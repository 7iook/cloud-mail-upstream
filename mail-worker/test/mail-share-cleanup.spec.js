import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';
import worker from '../src/index.js';
import { isDel } from '../src/const/entity-const.js';
import verifyRecordService from '../src/service/verify-record-service.js';
import userService from '../src/service/user-service.js';
import emailService from '../src/service/email-service.js';
import oauthService from '../src/service/oauth-service.js';
import { seedBindingRow } from './setup.js';

// 🔴 种子陷阱:默认 user_id=1 / account_id=1 在测试库里**没有对应 account 行**,
// 挂在这套种子上的任何 Binding 天生满足孤儿补偿臂的「非法」判据,会被顺手删掉 ——
// 「到期同批删 Binding」那条断言就会为错误的原因变绿。T-18 的新用例一律先种合法
// user + account(`seedLegalOwner`),让到期臂与补偿臂各自可独立证伪。
const T18_USER = 918001;
const T18_OTHER_USER = 918002;
const T18_ACC_1 = 918101;
const T18_ACC_2 = 918102;
const T18_OTHER_ACC = 918201;
const T18_MISSING_SHARE = 918999;

function stamp(offset, unit) {
	return dayjs().add(offset, unit).format('YYYY-MM-DD HH:mm:ss');
}

async function insertShare({ lid, expiresAt, deleteAt, userId = 1, accountId = 1 }) {
	await env.db.prepare(`
		INSERT INTO mail_share (
			lid, sec_hmac, pepper_kid, user_id, account_id, expires_at, delete_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`).bind(lid, 'hmac', 'kid-1', userId, accountId, expiresAt, deleteAt).run();
	return env.db.prepare('SELECT share_id FROM mail_share WHERE lid = ?').bind(lid).first();
}

async function seedLegalOwner() {
	for (const [userId, email] of [[T18_USER, 't18-owner@example.com'], [T18_OTHER_USER, 't18-other@example.com']]) {
		await env.db.prepare('DELETE FROM user WHERE user_id = ? OR email = ?').bind(userId, email).run();
		await env.db.prepare(`
			INSERT INTO user (user_id, email, type, password, salt, status, is_del)
			VALUES (?, ?, 1, 'x', 'x', 0, 0)
		`).bind(userId, email).run();
	}
	const accounts = [
		[T18_ACC_1, 't18-acc-1@example.com', T18_USER],
		[T18_ACC_2, 't18-acc-2@example.com', T18_USER],
		[T18_OTHER_ACC, 't18-acc-other@example.com', T18_OTHER_USER]
	];
	for (const [accountId, email, userId] of accounts) {
		await env.db.prepare('DELETE FROM account WHERE account_id = ? OR email = ?').bind(accountId, email).run();
		await env.db.prepare(`
			INSERT INTO account (account_id, email, name, user_id, is_del)
			VALUES (?, ?, 't18', ?, ?)
		`).bind(accountId, email, userId, isDel.NORMAL).run();
	}
}

async function dueShare(lid) {
	return insertShare({
		lid, expiresAt: stamp(-2, 'day'), deleteAt: stamp(-1, 'hour'), userId: T18_USER, accountId: T18_ACC_1
	});
}

async function liveShare(lid, accountId = T18_ACC_1) {
	return insertShare({
		lid, expiresAt: stamp(1, 'day'), deleteAt: stamp(7, 'day'), userId: T18_USER, accountId
	});
}

async function bindingAccountIds(shareId) {
	const rows = await env.db.prepare(
		'SELECT account_id FROM mail_share_binding WHERE share_id = ? ORDER BY binding_id ASC'
	).bind(shareId).all();
	return (rows.results || []).map((row) => row.account_id);
}

async function shareRow(shareId) {
	return env.db.prepare(
		'SELECT status, revoked_at, account_id, window_start_email_id FROM mail_share WHERE share_id = ?'
	).bind(shareId).first();
}

// 子表删在主表之前的唯一可证伪信号:全表扫「share_id 已无主表行」的 Binding。
async function danglingBindingCount() {
	const row = await env.db.prepare(`
		SELECT COUNT(*) AS n FROM mail_share_binding b
		WHERE NOT EXISTS (SELECT 1 FROM mail_share ms WHERE ms.share_id = b.share_id)
	`).first();
	return row.n;
}

async function runCron() {
	await worker.scheduled({ cron: '0 16 * * *' }, env, {});
}

function cascadeLogs(spy) {
	return spy.mock.calls
		.map(([first]) => {
			if (typeof first !== 'string') return null;
			try {
				return JSON.parse(first);
			} catch {
				return null;
			}
		})
		.filter((entry) => entry && entry.event === 'share.binding.cascade');
}

async function insertIdempotency({ key, createdAt, shareId }) {
	await env.db.prepare(`
		INSERT INTO share_idempotency (
			user_id, idempotency_key, operation, request_fingerprint, share_id, created_at
		) VALUES (?, ?, 'create', 'fp', ?, ?)
	`).bind(1, key, shareId, createdAt).run();
}

async function lids() {
	const rows = await env.db.prepare(
		"SELECT lid FROM mail_share WHERE lid LIKE 't12-%' ORDER BY lid"
	).all();
	return (rows.results || []).map((row) => row.lid);
}

async function idempotencyKeys() {
	const rows = await env.db.prepare(
		"SELECT idempotency_key FROM share_idempotency WHERE idempotency_key LIKE 't12-%' ORDER BY idempotency_key"
	).all();
	return (rows.results || []).map((row) => row.idempotency_key);
}

describe('AC-LIFE-07 scheduled share cleanup', () => {
	afterEach(async () => {
		await env.db.prepare("DELETE FROM mail_share WHERE lid LIKE 't12-%'").run();
		await env.db.prepare("DELETE FROM share_idempotency WHERE idempotency_key LIKE 't12-%'").run();
		await env.db.prepare(
			'DELETE FROM mail_share_binding WHERE share_id NOT IN (SELECT share_id FROM mail_share)'
		).run();
		await env.db.prepare('DELETE FROM account WHERE account_id IN (?, ?, ?)')
			.bind(T18_ACC_1, T18_ACC_2, T18_OTHER_ACC).run();
		await env.db.prepare('DELETE FROM user WHERE user_id IN (?, ?)').bind(T18_USER, T18_OTHER_USER).run();
		vi.restoreAllMocks();
	});

	it('deletes only past delete_at shares and 24h-stale idempotency via the daily cron', async () => {
		const due = await insertShare({
			lid: 't12-due',
			expiresAt: stamp(-2, 'day'),
			deleteAt: stamp(-1, 'hour')
		});
		await insertShare({
			lid: 't12-keep-expired',
			expiresAt: stamp(-1, 'hour'),
			deleteAt: stamp(7, 'day')
		});

		await insertIdempotency({ key: 't12-old', createdAt: stamp(-25, 'hour'), shareId: 900001 });
		await insertIdempotency({ key: 't12-fresh', createdAt: stamp(-23, 'hour'), shareId: 900002 });
		await insertIdempotency({ key: 't12-related-due', createdAt: stamp(-1, 'hour'), shareId: due.share_id });

		const existingJobs = [
			vi.spyOn(verifyRecordService, 'clearRecord'),
			vi.spyOn(userService, 'resetDaySendCount'),
			vi.spyOn(emailService, 'completeReceiveAll'),
			vi.spyOn(oauthService, 'clearNoBindOathUser')
		];

		await worker.scheduled({ cron: '0 16 * * *' }, env, {});

		expect(await lids()).toEqual(['t12-keep-expired']);
		expect(await idempotencyKeys()).toEqual(['t12-fresh']);
		for (const spy of existingJobs) {
			expect(spy).toHaveBeenCalledTimes(1);
		}
	});

	it('B1: deletes the bindings of a due share and leaves the not-due share untouched', async () => {
		await seedLegalOwner();
		const due = await dueShare('t12-b1-due');
		const keep = await liveShare('t12-b1-keep');
		await seedBindingRow({ shareId: due.share_id, accountId: T18_ACC_1 });
		await seedBindingRow({ shareId: due.share_id, accountId: T18_ACC_2 });
		await seedBindingRow({ shareId: keep.share_id, accountId: T18_ACC_1 });

		await runCron();

		expect(await bindingAccountIds(due.share_id)).toEqual([]);
		expect(await shareRow(due.share_id)).toBeNull();
		expect(await bindingAccountIds(keep.share_id)).toEqual([T18_ACC_1]);
	});

	it('B2: leaves no binding behind whose share row is already gone', async () => {
		await seedLegalOwner();
		const due = await dueShare('t12-b2-due');
		await seedBindingRow({ shareId: due.share_id, accountId: T18_ACC_1 });
		await seedBindingRow({ shareId: due.share_id, accountId: T18_ACC_2 });

		await runCron();

		expect(await danglingBindingCount()).toBe(0);
	});

	it('B3: sweeps a binding whose share row never existed', async () => {
		await seedLegalOwner();
		await seedBindingRow({ shareId: T18_MISSING_SHARE, accountId: T18_ACC_1 });

		await runCron();

		expect(await bindingAccountIds(T18_MISSING_SHARE)).toEqual([]);
	});

	it('B4: sweeps the binding of a hard-deleted account and revokes the emptied share', async () => {
		await seedLegalOwner();
		const share = await liveShare('t12-b4');
		await seedBindingRow({ shareId: share.share_id, accountId: T18_ACC_1 });
		await env.db.prepare('DELETE FROM account WHERE account_id = ?').bind(T18_ACC_1).run();

		await runCron();

		expect(await bindingAccountIds(share.share_id)).toEqual([]);
		const row = await shareRow(share.share_id);
		expect(row.status).toBe('REVOKED');
		expect(row.revoked_at).toEqual(expect.any(String));
	});

	it('B5: sweeps a binding pointing at another user account', async () => {
		await seedLegalOwner();
		const share = await liveShare('t12-b5');
		await seedBindingRow({ shareId: share.share_id, accountId: T18_ACC_1 });
		await seedBindingRow({ shareId: share.share_id, accountId: T18_OTHER_ACC });

		await runCron();

		expect(await bindingAccountIds(share.share_id)).toEqual([T18_ACC_1]);
		expect((await shareRow(share.share_id)).status).toBe('ACTIVE');
	});

	it('B6: keeps a zero-binding ACTIVE not-due share ACTIVE', async () => {
		await seedLegalOwner();
		const share = await insertShare({
			lid: 't12-b6-leftover',
			expiresAt: stamp(-1, 'hour'),
			deleteAt: stamp(7, 'day'),
			userId: T18_USER,
			accountId: T18_ACC_1
		});

		await runCron();

		const row = await shareRow(share.share_id);
		expect(row.status).toBe('ACTIVE');
		expect(row.revoked_at).toBeNull();
	});

	it('B7: sweeps only the dead binding and repoints the primary columns at the survivor', async () => {
		await seedLegalOwner();
		const share = await liveShare('t12-b7');
		await seedBindingRow({ shareId: share.share_id, accountId: T18_ACC_1, windowStartEmailId: 11 });
		await seedBindingRow({ shareId: share.share_id, accountId: T18_ACC_2, windowStartEmailId: 22 });
		await env.db.prepare('DELETE FROM account WHERE account_id = ?').bind(T18_ACC_1).run();

		await runCron();

		expect(await bindingAccountIds(share.share_id)).toEqual([T18_ACC_2]);
		const row = await shareRow(share.share_id);
		expect(row.status).toBe('ACTIVE');
		expect(row.revoked_at).toBeNull();
		expect(row.account_id).toBe(T18_ACC_2);
		expect(row.window_start_email_id).toBe(22);
	});

	it('B8: a second cron run changes nothing and does not rewrite revoked_at', async () => {
		await seedLegalOwner();
		const share = await liveShare('t12-b8');
		await seedBindingRow({ shareId: share.share_id, accountId: T18_ACC_1 });
		await env.db.prepare('DELETE FROM account WHERE account_id = ?').bind(T18_ACC_1).run();

		await runCron();
		const first = await shareRow(share.share_id);
		await runCron();
		const second = await shareRow(share.share_id);

		expect(second).toEqual(first);
		expect(await danglingBindingCount()).toBe(0);
	});

	it('B10: logs share.binding.cascade with a reason that tells the sweep apart from the cascade', async () => {
		await seedLegalOwner();
		const orphaned = await liveShare('t12-b10-orphan');
		const due = await dueShare('t12-b10-due');
		await seedBindingRow({ shareId: orphaned.share_id, accountId: T18_ACC_1 });
		await seedBindingRow({ shareId: due.share_id, accountId: T18_ACC_2 });
		await env.db.prepare('DELETE FROM account WHERE account_id = ?').bind(T18_ACC_1).run();
		const spy = vi.spyOn(console, 'log');

		await runCron();

		const logs = cascadeLogs(spy);
		const sweep = logs.filter((entry) => entry.shareId === orphaned.share_id);
		expect(sweep).toHaveLength(1);
		expect(sweep[0].reason).toBe('orphan_sweep');
		expect(sweep[0].removedBindings).toBe(1);
		expect(sweep[0].revoked).toBe(true);

		const expired = logs.filter((entry) => entry.shareId === due.share_id);
		expect(expired).toHaveLength(1);
		expect(expired[0].reason).toBe('share_expired');
		expect(expired[0].removedBindings).toBe(1);

		for (const entry of logs) {
			expect(entry.reason).not.toBe('account_deleted');
			expect(JSON.stringify(entry)).not.toContain('@');
		}
	});
});
