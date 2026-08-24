import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emailConst, isDel } from '../src/const/entity-const';
import { t } from '../src/i18n/i18n';
import shareResult from '../src/model/share-result';
import accountService from '../src/service/account-service';
import mailShareService from '../src/service/mail-share-service';
import shareAuthService from '../src/service/share-auth-service';
import shareMailService from '../src/service/share-mail-service';
import { seedBindingRow } from './setup.js';

const PEPPER = 't13-pepper-v1-fixed-test-value';
const SIGN = 't13-session-sign-v1-fixed-test-value';
const USER_A = 913001;
const USER_B = 913002;
const PRIMARY_A = 913101;
const BOX_A = 913102;
const BOX_B = 913103;
// PRIMARY_A 是 USER_A 的本人地址,`accountService.delete` 恒拒(delMyAccount),
// 多邮箱级联用例需要同一用户名下**两个可删**邮箱,BOX_C 就是第二个。
const BOX_C = 913104;
const MAIL_PRIMARY = 't13-owner@example.com';
const MAIL_BOX = 't13-box@example.com';
const MAIL_BOX_C = 't13-box-c@example.com';
const MAIL_OTHER = 't13-other@example.com';
const UNAVAILABLE = JSON.stringify(shareResult.fail('SHARE_UNAVAILABLE', 501));

function shareEnv(overrides = {}) {
	return {
		...env,
		SHARE_SEC_PEPPER: PEPPER,
		SHARE_SEC_PEPPER_KID: 'v1',
		SHARE_SESSION_SIGNING_KEY: SIGN,
		SHARE_SESSION_SIGNING_KID: 'v1',
		SHARE_SESSION_TTL: '900',
		SHARE_ENABLED: '1',
		SHARE_ACTIVE_LIMIT: '20',
		SHARE_MAX_DURATION_SECONDS: '86400',
		SHARE_RETENTION_SECONDS: '604800',
		SHARE_PUBLIC_ORIGIN: 'https://mail.example.com',
		...overrides
	};
}

function ctx(overrides = {}) {
	return { env: shareEnv(overrides) };
}

// 多邮箱 create 在 AC-LIFE-11 的栅栏后面,shareEnv() 没有 SHARE_CAPABILITY_V2 ——
// 不显式放行,`accountIds: [X, Y]` 会被拒成 SHARE_INVALID_CONFIG。
function v2ctx(overrides = {}) {
	return ctx({ SHARE_CAPABILITY_V2: 'true', ...overrides });
}

async function catchFail(promise) {
	try {
		await promise;
	} catch (err) {
		return JSON.stringify(shareResult.fail(err.message, err.code));
	}
	throw new Error('expected SHARE_UNAVAILABLE');
}

async function catchBiz(promise) {
	try {
		await promise;
	} catch (err) {
		if (err && err.name === 'BizError') {
			return err.message;
		}
		throw err;
	}
	throw new Error('expected BizError');
}

async function ensureUser(userId, email) {
	await env.db.prepare('DELETE FROM user WHERE user_id = ? OR email = ?').bind(userId, email).run();
	await env.db.prepare(`
		INSERT INTO user (user_id, email, type, password, salt, status, is_del)
		VALUES (?, ?, 1, 'x', 'x', 0, 0)
	`).bind(userId, email).run();
}

async function ensureAccount(accountId, email, userId) {
	await env.db.prepare('DELETE FROM account WHERE account_id = ? OR email = ?').bind(accountId, email).run();
	await env.db.prepare(`
		INSERT INTO account (account_id, email, name, user_id, is_del)
		VALUES (?, ?, ?, ?, ?)
	`).bind(accountId, email, 't13', userId, isDel.NORMAL).run();
}

async function insertEmail(accountId, userId, subject) {
	const row = await env.db.prepare(`
		INSERT INTO email (account_id, user_id, subject, is_del, status, type, send_email)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		RETURNING email_id
	`).bind(
		accountId,
		userId,
		subject,
		isDel.NORMAL,
		emailConst.status.RECEIVE,
		emailConst.type.RECEIVE,
		't13-sender@example.com'
	).first();
	return row.email_id;
}

async function seedMailbox() {
	await ensureUser(USER_A, MAIL_PRIMARY);
	await ensureUser(USER_B, MAIL_OTHER);
	await ensureAccount(PRIMARY_A, MAIL_PRIMARY, USER_A);
	await ensureAccount(BOX_A, MAIL_BOX, USER_A);
	await ensureAccount(BOX_C, MAIL_BOX_C, USER_A);
	await ensureAccount(BOX_B, MAIL_OTHER, USER_B);
}

async function cleanup() {
	await env.db.prepare('DELETE FROM share_idempotency WHERE user_id IN (?, ?)').bind(USER_A, USER_B).run();
	// Binding 必须在主表之前删:归属只能经 mail_share 回查。用例自己造的孤儿(share_id
	// 已无主表行)由第三条兜底,否则同一条用例内的后续断言会被上一步的残留污染。
	await env.db.prepare(`
		DELETE FROM mail_share_binding
		WHERE share_id IN (SELECT share_id FROM mail_share WHERE user_id IN (?, ?))
	`).bind(USER_A, USER_B).run();
	await env.db.prepare('DELETE FROM mail_share WHERE user_id IN (?, ?)').bind(USER_A, USER_B).run();
	await env.db.prepare(
		'DELETE FROM mail_share_binding WHERE share_id NOT IN (SELECT share_id FROM mail_share)'
	).run();
	await env.db.prepare('DELETE FROM email WHERE user_id IN (?, ?) OR subject LIKE ?').bind(USER_A, USER_B, 't13-%').run();
	await env.db.prepare('DELETE FROM account WHERE account_id IN (?, ?, ?, ?) OR email LIKE ?')
		.bind(PRIMARY_A, BOX_A, BOX_B, BOX_C, 't13-%@example.com').run();
	await env.db.prepare('DELETE FROM user WHERE user_id IN (?, ?) OR email LIKE ?')
		.bind(USER_A, USER_B, 't13-%@example.com').run();
}

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
});

async function openShare(accountId, userId, name) {
	const c = ctx();
	const created = await mailShareService.create(c, {
		accountId,
		durationSeconds: 3600,
		name,
		remark: 't13'
	}, userId);
	const session = await shareAuthService.establishSession(c, created.lid, created.sec);
	const shareCtx = await shareAuthService.resolveSession(c, session.sessionToken);
	return { c, created, session, shareCtx };
}

async function openMultiShare(accountIds, userId, name) {
	const c = v2ctx();
	const created = await mailShareService.create(c, {
		accountIds,
		durationSeconds: 3600,
		name,
		remark: 't13'
	}, userId);
	const session = await shareAuthService.establishSession(c, created.lid, created.sec);
	const shareCtx = await shareAuthService.resolveSession(c, session.sessionToken);
	return { c, created, session, shareCtx };
}

async function readShareRow(shareId) {
	return env.db.prepare(
		'SELECT status, revoked_at, account_id, window_start_email_id FROM mail_share WHERE share_id = ?'
	).bind(shareId).first();
}

async function bindingAccountIds(shareId) {
	const rows = await env.db.prepare(
		'SELECT account_id FROM mail_share_binding WHERE share_id = ? ORDER BY binding_id ASC'
	).bind(shareId).all();
	return (rows.results || []).map((row) => row.account_id);
}

// 无 Binding 的遗留形状(R3-A2 迁移窗口晚写行):只有主表 account_id,零 Binding 行。
async function insertLeftoverShare(lid, accountId, userId) {
	const row = await env.db.prepare(`
		INSERT INTO mail_share (lid, sec_hmac, pepper_kid, user_id, account_id, status, expires_at, delete_at)
		VALUES (?, 'hmac', 'v1', ?, ?, 'ACTIVE', '2099-01-01 00:00:00', '2099-01-02 00:00:00')
		RETURNING share_id
	`).bind(lid, userId, accountId).first();
	return row.share_id;
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

describe('account delete revokes mailbox shares (AC-LIFE-09, AC-LIFE-12 delete path)', () => {
	it('soft-deletes a mailbox, then the visitor cannot read and the share row is revoked', async () => {
		await seedMailbox();
		const live = await openShare(BOX_A, USER_A, 'soft-box');
		const other = await openShare(BOX_B, USER_B, 'other-box');
		const mailId = await insertEmail(BOX_A, USER_A, 't13-otp-soft');
		const mails = await shareMailService.list(live.c, live.shareCtx, null, 20);
		expect(mails.map((row) => row.mailId)).toContain(mailId);

		await accountService.delete(live.c, { accountId: BOX_A }, USER_A);

		const after = await catchFail(shareAuthService.resolveSession(live.c, live.session.sessionToken));
		const neverExisted = await catchFail(shareAuthService.establishSession(live.c, 'missing-lid', 'missing-sec'));
		expect(after).toBe(UNAVAILABLE);
		expect(after).toBe(neverExisted);

		const row = await readShareRow(live.created.shareId);
		expect(row.status).toBe('REVOKED');
		expect(row.revoked_at).toEqual(expect.any(String));

		const otherRow = await readShareRow(other.created.shareId);
		expect(otherRow.status).toBe('ACTIVE');
		expect(otherRow.revoked_at).toBeNull();
		const otherStill = await shareAuthService.resolveSession(other.c, other.session.sessionToken);
		expect(otherStill.accountId).toBe(BOX_B);

		const accountRow = await env.db.prepare(
			'SELECT is_del FROM account WHERE account_id = ?'
		).bind(BOX_A).first();
		expect(accountRow.is_del).toBe(isDel.DELETE);
		const { n } = await env.db.prepare(
			'SELECT COUNT(*) AS n FROM email WHERE email_id = ?'
		).bind(mailId).first();
		expect(n).toBe(1);
	});

	it('keeps the share revoked after the mailbox is restored (AC-LIFE-09)', async () => {
		await seedMailbox();
		const live = await openShare(BOX_A, USER_A, 'restore-box');
		await accountService.delete(live.c, { accountId: BOX_A }, USER_A);
		await accountService.restoreByEmail(live.c, MAIL_BOX);

		const restored = await env.db.prepare(
			'SELECT is_del FROM account WHERE account_id = ?'
		).bind(BOX_A).first();
		expect(restored.is_del).toBe(isDel.NORMAL);

		const after = await catchFail(shareAuthService.resolveSession(live.c, live.session.sessionToken));
		expect(after).toBe(UNAVAILABLE);
		const row = await readShareRow(live.created.shareId);
		expect(row.status).toBe('REVOKED');
		expect(row.revoked_at).toEqual(expect.any(String));
	});

	it('hard-deletes a mailbox, then the visitor cannot read and the share row is revoked', async () => {
		await seedMailbox();
		const live = await openShare(BOX_A, USER_A, 'hard-box');
		const other = await openShare(BOX_B, USER_B, 'other-hard');
		const mailId = await insertEmail(BOX_A, USER_A, 't13-otp-hard');
		const mails = await shareMailService.list(live.c, live.shareCtx, null, 20);
		expect(mails.map((row) => row.mailId)).toContain(mailId);

		await accountService.physicsDelete(live.c, { accountId: BOX_A });

		const after = await catchFail(shareAuthService.resolveSession(live.c, live.session.sessionToken));
		const neverExisted = await catchFail(shareAuthService.establishSession(live.c, 'missing-lid', 'missing-sec'));
		expect(after).toBe(UNAVAILABLE);
		expect(after).toBe(neverExisted);

		const row = await readShareRow(live.created.shareId);
		expect(row.status).toBe('REVOKED');
		expect(row.revoked_at).toEqual(expect.any(String));

		const gone = await env.db.prepare(
			'SELECT account_id FROM account WHERE account_id = ?'
		).bind(BOX_A).first();
		expect(gone).toBeNull();
		const { n } = await env.db.prepare(
			'SELECT COUNT(*) AS n FROM email WHERE email_id = ?'
		).bind(mailId).first();
		expect(n).toBe(0);

		const otherRow = await readShareRow(other.created.shareId);
		expect(otherRow.status).toBe('ACTIVE');
		const otherStill = await shareAuthService.resolveSession(other.c, other.session.sessionToken);
		expect(otherStill.accountId).toBe(BOX_B);
	});

	it('revokes every active share of accounts removed with the user (AC-LIFE-09)', async () => {
		await seedMailbox();
		const primaryShare = await openShare(PRIMARY_A, USER_A, 'primary');
		const boxShare = await openShare(BOX_A, USER_A, 'box');
		const other = await openShare(BOX_B, USER_B, 'keep');

		await accountService.physicsDeleteByUserIds(primaryShare.c, [USER_A]);

		expect(await catchFail(shareAuthService.resolveSession(primaryShare.c, primaryShare.session.sessionToken))).toBe(UNAVAILABLE);
		expect(await catchFail(shareAuthService.resolveSession(boxShare.c, boxShare.session.sessionToken))).toBe(UNAVAILABLE);
		expect((await readShareRow(primaryShare.created.shareId)).status).toBe('REVOKED');
		expect((await readShareRow(boxShare.created.shareId)).status).toBe('REVOKED');
		expect((await readShareRow(other.created.shareId)).status).toBe('ACTIVE');
	});

	it('does not change other account-delete rules', async () => {
		await seedMailbox();
		const primaryShare = await openShare(PRIMARY_A, USER_A, 'keep-primary');
		const otherShare = await openShare(BOX_B, USER_B, 'keep-other');
		const orphanMailId = await insertEmail(BOX_A, USER_A, 't13-orphan');

		expect(await catchBiz(accountService.delete(ctx(), { accountId: PRIMARY_A }, USER_A))).toBe(t('delMyAccount'));
		expect(await catchBiz(accountService.delete(ctx(), { accountId: BOX_B }, USER_A))).toBe(t('noUserAccount'));

		expect((await readShareRow(primaryShare.created.shareId)).status).toBe('ACTIVE');
		expect((await readShareRow(otherShare.created.shareId)).status).toBe('ACTIVE');

		await accountService.physicsDelete(ctx(), { accountId: BOX_A });
		expect(await env.db.prepare(
			'SELECT account_id FROM account WHERE account_id = ?'
		).bind(BOX_A).first()).toBeNull();
		expect((await env.db.prepare(
			'SELECT COUNT(*) AS n FROM email WHERE email_id = ?'
		).bind(orphanMailId).first()).n).toBe(0);
		expect((await env.db.prepare(
			'SELECT is_del FROM account WHERE account_id = ?'
		).bind(PRIMARY_A).first()).is_del).toBe(isDel.NORMAL);
	});
});

// T-18:级联撤销改走 mail_share_binding。判据恒是「accountId ∈ 本次传入集合」——
// 三个挂钩点(软删 / 随用户硬删 / 单账号硬删)全在 account 行仍存活时调用。
describe('T-18 cascade revoke goes through mail_share_binding (AC-BIND-05/06/10, AC-LIFE-09/10)', () => {
	it('A1: soft-deleting the primary mailbox of a multi share keeps it ACTIVE on the survivor', async () => {
		await seedMailbox();
		const mailA = await insertEmail(BOX_A, USER_A, 't13-a1-a');
		const mailC = await insertEmail(BOX_C, USER_A, 't13-a1-c');
		const live = await openMultiShare([BOX_A, BOX_C], USER_A, 'a1-multi');

		const before = await readShareRow(live.created.shareId);
		expect(before.account_id).toBe(BOX_A);
		expect(before.window_start_email_id).toBe(mailA);

		await accountService.delete(ctx(), { accountId: BOX_A }, USER_A);

		const row = await readShareRow(live.created.shareId);
		expect(row.status).toBe('ACTIVE');
		expect(row.revoked_at).toBeNull();
		expect(await bindingAccountIds(live.created.shareId)).toEqual([BOX_C]);
		// AC-LIFE-10 双写:主表两列跟随幸存主 Binding,绝不停在将死账号,也绝不写 0。
		expect(row.account_id).toBe(BOX_C);
		expect(row.window_start_email_id).toBe(mailC);

		const fresh = await insertEmail(BOX_C, USER_A, 't13-a1-after');
		const shareCtx = await shareAuthService.resolveSession(live.c, live.session.sessionToken);
		const mails = await shareMailService.list(live.c, shareCtx, null, 20);
		expect(mails.map((mail) => mail.mailId)).toContain(fresh);
	});

	it('A2: soft-deleting a non-primary mailbox leaves the primary account_id untouched', async () => {
		await seedMailbox();
		const mailA = await insertEmail(BOX_A, USER_A, 't13-a2-a');
		await insertEmail(BOX_C, USER_A, 't13-a2-c');
		const live = await openMultiShare([BOX_A, BOX_C], USER_A, 'a2-multi');

		await accountService.delete(ctx(), { accountId: BOX_C }, USER_A);

		const row = await readShareRow(live.created.shareId);
		expect(row.status).toBe('ACTIVE');
		expect(row.revoked_at).toBeNull();
		expect(await bindingAccountIds(live.created.shareId)).toEqual([BOX_A]);
		expect(row.account_id).toBe(BOX_A);
		expect(row.window_start_email_id).toBe(mailA);
	});

	it('A3: deleting the last remaining mailbox revokes the share and leaves no binding row', async () => {
		await seedMailbox();
		const live = await openMultiShare([BOX_A, BOX_C], USER_A, 'a3-multi');

		await accountService.delete(ctx(), { accountId: BOX_A }, USER_A);
		expect((await readShareRow(live.created.shareId)).status).toBe('ACTIVE');

		await accountService.delete(ctx(), { accountId: BOX_C }, USER_A);

		const row = await readShareRow(live.created.shareId);
		expect(row.status).toBe('REVOKED');
		expect(row.revoked_at).toEqual(expect.any(String));
		expect(await bindingAccountIds(live.created.shareId)).toEqual([]);
		expect(await catchFail(shareAuthService.resolveSession(live.c, live.session.sessionToken))).toBe(UNAVAILABLE);
	});

	it('A4: the hard-delete path behaves exactly like the soft-delete path', async () => {
		await seedMailbox();
		await insertEmail(BOX_A, USER_A, 't13-a4-a');
		const mailC = await insertEmail(BOX_C, USER_A, 't13-a4-c');
		const live = await openMultiShare([BOX_A, BOX_C], USER_A, 'a4-multi');

		await accountService.physicsDelete(ctx(), { accountId: BOX_A });

		let row = await readShareRow(live.created.shareId);
		expect(row.status).toBe('ACTIVE');
		expect(row.account_id).toBe(BOX_C);
		expect(row.window_start_email_id).toBe(mailC);
		expect(await bindingAccountIds(live.created.shareId)).toEqual([BOX_C]);

		await accountService.physicsDelete(ctx(), { accountId: BOX_C });

		row = await readShareRow(live.created.shareId);
		expect(row.status).toBe('REVOKED');
		expect(row.revoked_at).toEqual(expect.any(String));
		expect(await bindingAccountIds(live.created.shareId)).toEqual([]);
	});

	it('A5: removing every account of a user clears its bindings and spares the other user', async () => {
		await seedMailbox();
		const single = await openShare(PRIMARY_A, USER_A, 'a5-single');
		const multi = await openMultiShare([BOX_A, BOX_C], USER_A, 'a5-multi');
		const other = await openShare(BOX_B, USER_B, 'a5-keep');

		await accountService.physicsDeleteByUserIds(ctx(), [USER_A]);

		expect((await readShareRow(single.created.shareId)).status).toBe('REVOKED');
		expect((await readShareRow(multi.created.shareId)).status).toBe('REVOKED');
		expect(await bindingAccountIds(single.created.shareId)).toEqual([]);
		expect(await bindingAccountIds(multi.created.shareId)).toEqual([]);

		const otherRow = await readShareRow(other.created.shareId);
		expect(otherRow.status).toBe('ACTIVE');
		expect(otherRow.revoked_at).toBeNull();
		expect(await bindingAccountIds(other.created.shareId)).toEqual([BOX_B]);
	});

	it('A6: a share bound only to a surviving mailbox is never touched', async () => {
		await seedMailbox();
		const doomed = await openShare(BOX_A, USER_A, 'a6-doomed');
		const survivor = await openShare(BOX_C, USER_A, 'a6-survivor');
		const mailC = await insertEmail(BOX_C, USER_A, 't13-a6-c');

		await accountService.delete(ctx(), { accountId: BOX_A }, USER_A);

		expect((await readShareRow(doomed.created.shareId)).status).toBe('REVOKED');
		const row = await readShareRow(survivor.created.shareId);
		expect(row.status).toBe('ACTIVE');
		expect(row.revoked_at).toBeNull();
		expect(await bindingAccountIds(survivor.created.shareId)).toEqual([BOX_C]);

		const shareCtx = await shareAuthService.resolveSession(survivor.c, survivor.session.sessionToken);
		const mails = await shareMailService.list(survivor.c, shareCtx, null, 20);
		expect(mails.map((mail) => mail.mailId)).toContain(mailC);
	});

	it('A7: a zero-binding leftover row whose account dies falls back to the primary column', async () => {
		await seedMailbox();
		const leftover = await insertLeftoverShare('t13-a7-leftover', BOX_A, USER_A);
		expect(await bindingAccountIds(leftover)).toEqual([]);

		await accountService.delete(ctx(), { accountId: BOX_A }, USER_A);

		const row = await readShareRow(leftover);
		expect(row.status).toBe('REVOKED');
		expect(row.revoked_at).toEqual(expect.any(String));
	});

	it('A8: a zero-binding leftover row outside the dying set stays ACTIVE', async () => {
		await seedMailbox();
		const leftover = await insertLeftoverShare('t13-a8-leftover', BOX_C, USER_A);
		const foreign = await insertLeftoverShare('t13-a8-foreign', BOX_B, USER_B);

		await accountService.delete(ctx(), { accountId: BOX_A }, USER_A);

		for (const shareId of [leftover, foreign]) {
			const row = await readShareRow(shareId);
			expect(row.status).toBe('ACTIVE');
			expect(row.revoked_at).toBeNull();
		}
	});

	it('A9: an orphan binding neither breaks the cascade nor blocks the dying binding removal', async () => {
		await seedMailbox();
		const live = await openMultiShare([BOX_A, BOX_C], USER_A, 'a9-multi');
		await seedBindingRow({ shareId: live.created.shareId, accountId: 913999 });

		await accountService.delete(ctx(), { accountId: BOX_A }, USER_A);

		// 孤儿是否本轮被回收归 cleanup 的补偿臂,级联只保证「将死的那条被剔除」。
		expect(await bindingAccountIds(live.created.shareId)).toEqual([BOX_C, 913999]);
		expect((await readShareRow(live.created.shareId)).status).toBe('ACTIVE');
	});

	it('A10: logs one share.binding.cascade line per affected share with no mailbox plaintext', async () => {
		await seedMailbox();
		const live = await openMultiShare([BOX_A, BOX_C], USER_A, 'a10-multi');
		const spy = vi.spyOn(console, 'log');

		await accountService.delete(ctx(), { accountId: BOX_A }, USER_A);

		const logs = cascadeLogs(spy);
		const mine = logs.filter((entry) => entry.shareId === live.created.shareId);
		expect(mine).toHaveLength(1);
		expect(mine[0].reason).toBe('account_deleted');
		expect(mine[0].removedBindings).toBe(1);
		expect(mine[0].revoked).toBe(false);
		for (const entry of logs) {
			expect(JSON.stringify(entry)).not.toContain('@');
		}
	});

	it('A11: 60 account ids in one cascade stay inside the D1 bind-parameter budget', async () => {
		await seedMailbox();
		const live = await openShare(BOX_A, USER_A, 'a11-budget');
		// mail_share_binding 没有外键,合成 id 足以撑起「一次剔除很多行」的形状。
		const synthetic = Array.from({ length: 60 }, (_, index) => 914001 + index);
		for (const accountId of synthetic.slice(0, 3)) {
			await seedBindingRow({ shareId: live.created.shareId, accountId });
		}

		await expect(mailShareService.revokeByAccountIds(ctx(), synthetic))
			.resolves.toEqual({ revoked: 0, unbound: 3 });

		expect(await bindingAccountIds(live.created.shareId)).toEqual([BOX_A]);
		expect((await readShareRow(live.created.shareId)).status).toBe('ACTIVE');
	});

	// 语句顺序的唯一守卫。形状取自 exec-t08-note 登记的「主表 account_id 与 Binding 集合
	// 不一致」行:Binding 全部将死,而主表指向一个存活账号。撤销语句若跑在 DELETE **之后**,
	// Binding 臂已无行可读、回落臂又因主表指向存活账号而不成立 —— 分享会静默停在
	// 「ACTIVE + 零 Binding」的僵尸态。A1–A9 都被双臂互相兜住,抓不到这条。
	it('A12: revoke runs before the binding DELETE, so an inconsistent primary column cannot mask it', async () => {
		await seedMailbox();
		const live = await openShare(BOX_A, USER_A, 'a12-order');
		await env.db.prepare('UPDATE mail_share SET account_id = ? WHERE share_id = ?')
			.bind(BOX_C, live.created.shareId).run();

		await accountService.delete(ctx(), { accountId: BOX_A }, USER_A);

		const row = await readShareRow(live.created.shareId);
		expect(row.status).toBe('REVOKED');
		expect(row.revoked_at).toEqual(expect.any(String));
		expect(await bindingAccountIds(live.created.shareId)).toEqual([]);
	});
});
