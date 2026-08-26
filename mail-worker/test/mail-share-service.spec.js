import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { emailConst, isDel } from '../src/const/entity-const';
import KvConst from '../src/const/kv-const';
import jwtUtils from '../src/utils/jwt-utils';
import shareAuthService from '../src/service/share-auth-service';
import { decryptShareSec } from '../src/security/share-sec-cipher';
import mailShareService, {
	SHARE_BINDING_LIMIT,
	SHARE_V2_INTENT,
	assertCapabilityV2,
	syncPrimaryAccountId
} from '../src/service/mail-share-service';
import { SHARE_EVENT, logShareEvent, shareRequestId } from '../src/service/share-event';
import { Hono } from 'hono';
import shareResult from '../src/model/share-result';
import initSource from '../src/init/init.js?raw';
import worker from '../src/index.js';
import wranglerToml from '../wrangler.toml?raw';
import { seedBindingRow, seedShareRow, utcTextToMs, withLocalTimezoneShift } from './setup.js';

const PEPPER = 't09-pepper-v2-fixed-test-value';
const USER_A = 909001;
const USER_B = 909002;
const ACC_A = 909101;
const ACC_B = 909102;
const ACC_C = 909103;
const MAIL_A = 't09-owner-a@example.com';
const MAIL_B = 't09-owner-b@example.com';
const MAIL_C = 't09-owner-c@example.com';

function shareEnv(overrides = {}) {
	return {
		...env,
		SHARE_SEC_PEPPER: PEPPER,
		SHARE_SEC_PEPPER_KID: 'v2',
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

// 多邮箱 / AuthKey / 有限配额都在 AC-LIFE-11 的栅栏后面，需要显式放行的用例用这个上下文。
function v2ctx(overrides = {}) {
	return ctx({ SHARE_CAPABILITY_V2: 'true', ...overrides });
}

function failEnvelope(err) {
	return JSON.stringify(shareResult.fail(err.message, err.code));
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

function decodeBase64Url(value) {
	let padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
	while (padded.length % 4) {
		padded += '=';
	}
	return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function ensureAccount({ accountId, email, userId }) {
	await env.db.prepare('DELETE FROM account WHERE account_id = ? OR email = ?').bind(accountId, email).run();
	await env.db.prepare(`
		INSERT INTO account (account_id, email, name, user_id, is_del)
		VALUES (?, ?, ?, ?, ?)
	`).bind(accountId, email, 't09', userId, isDel.NORMAL).run();
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
		't09-sender@example.com'
	).first();
	return row.email_id;
}

async function cleanup() {
	await env.db.prepare(`
		DELETE FROM mail_share_binding
		WHERE share_id IN (SELECT share_id FROM mail_share WHERE user_id IN (?, ?))
	`).bind(USER_A, USER_B).run();
	await env.db.prepare('DELETE FROM share_idempotency WHERE user_id IN (?, ?)').bind(USER_A, USER_B).run();
	await env.db.prepare('DELETE FROM mail_share WHERE user_id IN (?, ?)').bind(USER_A, USER_B).run();
	await env.db.prepare('DELETE FROM email WHERE user_id IN (?, ?) OR subject LIKE ?').bind(USER_A, USER_B, 't09-%').run();
	await env.db.prepare('DELETE FROM account WHERE account_id IN (?, ?, ?) OR email LIKE ?')
		.bind(ACC_A, ACC_B, ACC_C, 't09-%@example.com').run();
	await env.db.prepare('DELETE FROM user WHERE user_id IN (?, ?)').bind(USER_A, USER_B).run();
}

afterEach(async () => {
	await cleanup();
});

async function seedOwners() {
	await ensureAccount({ accountId: ACC_A, email: MAIL_A, userId: USER_A });
	await ensureAccount({ accountId: ACC_B, email: MAIL_B, userId: USER_B });
	await ensureAccount({ accountId: ACC_C, email: MAIL_C, userId: USER_A });
}

async function readPrimaryAccountId(shareId) {
	const row = await env.db.prepare('SELECT account_id FROM mail_share WHERE share_id = ?').bind(shareId).first();
	return row.account_id;
}

async function readShareRow(shareId) {
	return env.db.prepare('SELECT * FROM mail_share WHERE share_id = ?').bind(shareId).first();
}

async function listBindings(shareId) {
	const rows = await env.db.prepare(`
		SELECT binding_id, account_id, window_start_email_id
		FROM mail_share_binding WHERE share_id = ? ORDER BY binding_id ASC
	`).bind(shareId).all();
	return rows.results || [];
}

async function countOwnerRows(userId) {
	const share = await env.db.prepare('SELECT COUNT(*) AS n FROM mail_share WHERE user_id = ?').bind(userId).first();
	const binding = await env.db.prepare(`
		SELECT COUNT(*) AS n FROM mail_share_binding WHERE account_id IN (?, ?, ?)
	`).bind(ACC_A, ACC_B, ACC_C).first();
	return { shares: share.n, bindings: binding.n };
}

function sqlProbe() {
	const seen = [];
	const prepare = env.db.prepare.bind(env.db);
	const db = new Proxy(env.db, {
		get(target, prop) {
			if (prop === 'prepare') {
				return (sql) => {
					seen.push(String(sql));
					return prepare(sql);
				};
			}
			const value = target[prop];
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
	return { seen, db };
}

async function clearPrimaryAccountId(shareId) {
	await env.db.prepare('UPDATE mail_share SET account_id = 0 WHERE share_id = ?').bind(shareId).run();
}

const FLAG_FIELDS = ['onlyMessagesAfterCreated', 'otpExtractionEnabled', 'autoRefresh', 'showFullAddress', 'authKeyEnabled'];
const COUNT_FIELDS = ['maxSessions', 'messageLimit'];
const MALFORMED_FLAGS = ['invalid', 2, {}];
const MALFORMED_COUNTS = [true, false, 'invalid'];

// 旧 Worker(基线 `5a81065`)的请求指纹:四字段 canonical body 的 SHA-256。
// 现算而不是硬编码,用例钉的是「两个 Worker 算出同一个值」而不是某一组常量。
async function legacyFingerprint({ accountId, durationSeconds, name = '', remark = '' }) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(JSON.stringify({ accountId, durationSeconds, name, remark }))
	);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createParams(overrides = {}) {
	return {
		accountId: ACC_A,
		durationSeconds: 3600,
		name: 'colleague',
		remark: 'otp handoff',
		...overrides
	};
}

describe('mailShareService owner write path', () => {
	it('creates a share URL with sec in the fragment and persists the row (AC-SHARE-01, AC-LEAK-01)', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), createParams(), USER_A);
		expect(created.lid).toEqual(expect.any(String));
		expect(created.sec).toEqual(expect.any(String));
		expect(created.shareId).toEqual(expect.any(Number));
		expect(created.shareUrl).toBe(`https://mail.example.com/s/${created.lid}#${created.sec}`);
		const row = await env.db.prepare('SELECT * FROM mail_share WHERE share_id = ?').bind(created.shareId).first();
		expect(row.lid).toBe(created.lid);
		expect(row.user_id).toBe(USER_A);
		expect(row.account_id).toBe(ACC_A);
		expect(row.status).toBe('ACTIVE');
	});

	it('generates independent 128-bit lid and 256-bit sec from CSPRNG (AC-SHARE-02, AC-SHARE-10)', async () => {
		await seedOwners();
		const first = await mailShareService.create(ctx(), createParams({ name: 'one' }), USER_A);
		const second = await mailShareService.create(ctx(), createParams({ name: 'two' }), USER_A);
		expect(decodeBase64Url(first.lid).length).toBe(16);
		expect(decodeBase64Url(first.sec).length).toBe(32);
		expect(first.lid).not.toBe(first.sec);
		expect(first.lid).not.toBe(second.lid);
		expect(first.sec).not.toBe(second.sec);
		expect(first.shareId).not.toBe(second.shareId);
	});

	it('stores HMAC(sec, pepper) and never persists plaintext sec (AC-SHARE-03)', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), createParams(), USER_A);
		const expectedHmac = await shareAuthService.digestShareSecret(created.sec, PEPPER);
		const share = await env.db.prepare('SELECT * FROM mail_share WHERE share_id = ?').bind(created.shareId).first();
		expect(share.sec_hmac).toBe(expectedHmac);
		expect(share.pepper_kid).toBe('v2');
		expect(Object.values(share)).not.toContain(created.sec);
		const idem = await env.db.prepare('SELECT * FROM share_idempotency WHERE share_id = ?').bind(created.shareId).all();
		for (const row of idem.results || []) {
			expect(Object.values(row)).not.toContain(created.sec);
		}
	});

	it('returns sec only on the first create response (AC-SHARE-04)', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), createParams({
			idempotencyKey: 't09-once'
		}), USER_A);
		expect(created.sec).toEqual(expect.any(String));
		const listed = await mailShareService.list(ctx(), {}, USER_A);
		expect(JSON.stringify(listed)).not.toContain(created.sec);
		expect(listed.list[0].sec).toBeUndefined();
		const replay = await mailShareService.create(ctx(), createParams({
			idempotencyKey: 't09-once'
		}), USER_A);
		expect(replay.sec).toBeUndefined();
		expect(replay.idempotentReplay).toBe(true);
	});

	it('rejects create against another owner account (AC-SHARE-05)', async () => {
		await seedOwners();
		const message = await catchBiz(mailShareService.create(ctx(), createParams({
			accountId: ACC_B
		}), USER_A));
		expect(message).toBe('SHARE_ACCOUNT_FORBIDDEN');
		const { n } = await env.db.prepare(
			'SELECT COUNT(*) AS n FROM mail_share WHERE user_id = ?'
		).bind(USER_A).first();
		expect(n).toBe(0);
	});

	it('snapshots window_start as the account max email_id at create (AC-SHARE-06)', async () => {
		await seedOwners();
		const firstId = await insertEmail(ACC_A, USER_A, 't09-mail-1');
		const secondId = await insertEmail(ACC_A, USER_A, 't09-mail-2');
		expect(secondId).toBeGreaterThan(firstId);
		const created = await mailShareService.create(ctx(), createParams(), USER_A);
		const row = await env.db.prepare(
			'SELECT window_start_email_id FROM mail_share WHERE share_id = ?'
		).bind(created.shareId).first();
		expect(row.window_start_email_id).toBe(secondId);
	});

	it('linearises the window snapshot in one INSERT...SELECT (AC-SHARE-06, AC-SHARE-16)', async () => {
		await seedOwners();
		await insertEmail(ACC_A, USER_A, 't09-mail-sql');
		const seen = [];
		const prepare = env.db.prepare.bind(env.db);
		const db = new Proxy(env.db, {
			get(target, prop) {
				if (prop === 'prepare') {
					return (sql) => {
						seen.push(String(sql));
						return prepare(sql);
					};
				}
				const value = target[prop];
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		await mailShareService.create({ env: shareEnv({ db }) }, createParams(), USER_A);
		const snapshotSql = seen.find((sql) => /INSERT\s+INTO\s+mail_share/i.test(sql));
		expect(snapshotSql).toEqual(expect.any(String));
		expect(snapshotSql).toMatch(/COALESCE\s*\(\s*MAX\s*\(\s*email_id\s*\)/i);
		expect(seen.some((sql) => /SELECT\s+MAX\s*\(\s*email_id\s*\)/i.test(sql) && !/INSERT\s+INTO\s+mail_share/i.test(sql))).toBe(false);
	});

	it('rejects duration above the configured max (AC-SHARE-07)', async () => {
		await seedOwners();
		const message = await catchBiz(mailShareService.create(ctx({
			SHARE_MAX_DURATION_SECONDS: '60'
		}), createParams({ durationSeconds: 61 }), USER_A));
		expect(message).toBe('SHARE_DURATION_EXCEEDED');
	});

	// I-2:上限不是「配了才有」。生产 `wrangler.toml` 从来没写过这一项,所以在兜底落地之前
	// 生产是彻底无上限的 —— 这条用例钉的正是「运维忘了配」这个真实部署形态。
	// 非数字 / 0 / 负数一并走兜底:它们与「没配」是同一件事,不是「解除上限」的暗门。
	it('falls back to the built-in 90-day ceiling when SHARE_MAX_DURATION_SECONDS is absent (I-2)', async () => {
		await seedOwners();
		const ninetyDays = 90 * 24 * 3600;
		for (const absent of [undefined, '', 'abc', '0', '-1']) {
			const message = await catchBiz(mailShareService.create(ctx({
				SHARE_MAX_DURATION_SECONDS: absent
			}), createParams({ durationSeconds: ninetyDays + 1 }), USER_A));
			expect([absent, message]).toEqual([absent, 'SHARE_DURATION_EXCEEDED']);
		}
		const created = await mailShareService.create(ctx({
			SHARE_MAX_DURATION_SECONDS: undefined
		}), createParams({ name: 'at-fallback-ceiling', durationSeconds: ninetyDays }), USER_A);
		expect(created.shareId).toEqual(expect.any(Number));
	});

	// 兜底只在缺失时接管:显式配置仍然是权威,不会把一个配得更宽的部署压回 90 天。
	it('lets an explicit SHARE_MAX_DURATION_SECONDS raise the ceiling above the fallback', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx({
			SHARE_MAX_DURATION_SECONDS: String(120 * 24 * 3600)
		}), createParams({ name: 'above-fallback', durationSeconds: 100 * 24 * 3600 }), USER_A);
		expect(created.shareId).toEqual(expect.any(Number));
	});

	it('sets expires_at to create time plus duration and delete_at later (AC-SHARE-08, AC-LIFE-06)', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx({
			SHARE_RETENTION_SECONDS: '3600'
		}), createParams({ durationSeconds: 120 }), USER_A);
		const row = await env.db.prepare(
			'SELECT create_time, expires_at, delete_at FROM mail_share WHERE share_id = ?'
		).bind(created.shareId).first();
		const createdMs = Date.parse(row.create_time.replace(' ', 'T') + 'Z');
		const expiresMs = Date.parse(row.expires_at.replace(' ', 'T') + 'Z');
		const deleteMs = Date.parse(row.delete_at.replace(' ', 'T') + 'Z');
		expect(expiresMs - createdMs).toBe(120000);
		expect(deleteMs).toBeGreaterThan(expiresMs);
		expect(created.expiresAt).toBe(row.expires_at);
	});

	// 上一条只比相对差值，写入方用哪个时区都成立，所以抓不到「裸串是本地时间」。
	// 这条钉的是绝对时刻：分享模块是全仓唯一一个「裸串是否 UTC 取决于运行环境」的写入方，
	// 部署到 Cloudflare(恒 UTC)与本地开发(UTC+8)必须产出同一个物理时刻。
	it('writes create_time / expires_at as UTC even from a UTC+8 process (WA-TZ)', async () => {
		await seedOwners();
		const before = Date.now();
		const created = await withLocalTimezoneShift(8, () => mailShareService.create(ctx({
			SHARE_RETENTION_SECONDS: '3600'
		}), createParams({ durationSeconds: 120 }), USER_A));
		const after = Date.now();
		const row = await env.db.prepare(
			'SELECT create_time, expires_at, delete_at FROM mail_share WHERE share_id = ?'
		).bind(created.shareId).first();
		const createdMs = utcTextToMs(row.create_time);
		// 秒级截断，所以下界放宽 1s。
		expect(createdMs).toBeGreaterThanOrEqual(before - 1000);
		expect(createdMs).toBeLessThanOrEqual(after + 1000);
		expect(utcTextToMs(row.expires_at) - createdMs).toBe(120000);
		expect(utcTextToMs(row.delete_at) - createdMs).toBe(3720000);
		// 独立锚点：binding 的 create_time 走 SQLite CURRENT_TIMESTAMP，恒 UTC，同一个 batch 落库。
		const binding = await env.db.prepare(
			'SELECT create_time FROM mail_share_binding WHERE share_id = ? ORDER BY binding_id ASC LIMIT 1'
		).bind(created.shareId).first();
		expect(Math.abs(createdMs - utcTextToMs(binding.create_time))).toBeLessThanOrEqual(2000);
	});

	it('stores name and remark for the owner list only (AC-SHARE-09, AC-MGMT-02)', async () => {
		await seedOwners();
		await mailShareService.create(ctx(), createParams({
			name: 'desk A',
			remark: 'front door'
		}), USER_A);
		const listed = await mailShareService.list(ctx(), {}, USER_A);
		expect(listed.total).toBe(1);
		expect(listed.list[0]).toMatchObject({
			mailbox: MAIL_A,
			name: 'desk A',
			remark: 'front door',
			status: 'ACTIVE',
			effectiveStatus: 'ACTIVE',
			accessCount: 0
		});
		expect(listed.list[0].createTime).toEqual(expect.any(String));
		expect(listed.list[0].expiresAt).toEqual(expect.any(String));
		expect(listed.list[0].lastAccessAt == null).toBe(true);
	});

	it('replays the same Idempotency-Key without a second share or sec (AC-SHARE-11)', async () => {
		await seedOwners();
		const params = createParams({ idempotencyKey: 't09-replay' });
		const first = await mailShareService.create(ctx(), params, USER_A);
		const second = await mailShareService.create(ctx(), params, USER_A);
		expect(second.shareId).toBe(first.shareId);
		expect(second.lid).toBe(first.lid);
		expect(second.idempotentReplay).toBe(true);
		expect(second.sec).toBeUndefined();
		const { n } = await env.db.prepare(
			'SELECT COUNT(*) AS n FROM mail_share WHERE user_id = ?'
		).bind(USER_A).first();
		expect(n).toBe(1);
		const { keys } = await env.db.prepare(
			'SELECT COUNT(*) AS keys FROM share_idempotency WHERE user_id = ? AND idempotency_key = ?'
		).bind(USER_A, 't09-replay').first();
		expect(keys).toBe(1);
	});

	it('rejects a same-key different-body replay as a stable conflict (AC-SHARE-14)', async () => {
		await seedOwners();
		const first = await mailShareService.create(ctx(), createParams({
			idempotencyKey: 't09-conflict',
			name: 'alpha'
		}), USER_A);
		const message = await catchBiz(mailShareService.create(ctx(), createParams({
			idempotencyKey: 't09-conflict',
			name: 'beta'
		}), USER_A));
		expect(message).toBe('SHARE_IDEMPOTENCY_CONFLICT');
		const { n } = await env.db.prepare(
			'SELECT COUNT(*) AS n FROM mail_share WHERE user_id = ?'
		).bind(USER_A).first();
		expect(n).toBe(1);
		const row = await env.db.prepare('SELECT lid FROM mail_share WHERE share_id = ?').bind(first.shareId).first();
		expect(row.lid).toBe(first.lid);
	});

	it('treats missing name and empty name as the same fingerprint (AC-SHARE-11)', async () => {
		await seedOwners();
		const first = await mailShareService.create(ctx(), {
			accountId: ACC_A,
			durationSeconds: 3600,
			idempotencyKey: 't09-empty-name'
		}, USER_A);
		const replay = await mailShareService.create(ctx(), {
			accountId: ACC_A,
			durationSeconds: 3600,
			name: '',
			remark: '',
			idempotencyKey: 't09-empty-name'
		}, USER_A);
		expect(replay.shareId).toBe(first.shareId);
		expect(replay.idempotentReplay).toBe(true);
	});

	it('does not let concurrent creates exceed the active limit (AC-SHARE-12, AC-ABUSE-02)', async () => {
		await seedOwners();
		const c = ctx({ SHARE_ACTIVE_LIMIT: '1' });
		const results = await Promise.allSettled([
			mailShareService.create(c, createParams({ name: 'left' }), USER_A),
			mailShareService.create(c, createParams({ name: 'right' }), USER_A)
		]);
		const fulfilled = results.filter((item) => item.status === 'fulfilled');
		const rejected = results.filter((item) => item.status === 'rejected');
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(rejected[0].reason.message).toBe('SHARE_LIMIT_EXCEEDED');
		const { n } = await env.db.prepare(
			"SELECT COUNT(*) AS n FROM mail_share WHERE user_id = ? AND status = 'ACTIVE'"
		).bind(USER_A).first();
		expect(n).toBe(1);
		const { keys } = await env.db.prepare(
			'SELECT COUNT(*) AS keys FROM share_idempotency WHERE user_id = ?'
		).bind(USER_A).first();
		expect(keys).toBeLessThanOrEqual(1);
	});

	it('counts only effective ACTIVE shares toward the cap (AC-SHARE-12, AC-LIFE-08)', async () => {
		await seedOwners();
		const expired = await mailShareService.create(ctx(), createParams({
			name: 'old',
			durationSeconds: 60
		}), USER_A);
		await env.db.prepare(
			"UPDATE mail_share SET expires_at = '2001-01-01 00:00:00' WHERE share_id = ?"
		).bind(expired.shareId).run();
		const created = await mailShareService.create(ctx({ SHARE_ACTIVE_LIMIT: '1' }), createParams({
			name: 'fresh'
		}), USER_A);
		expect(created.shareId).not.toBe(expired.shareId);
		const listed = await mailShareService.list(ctx(), {}, USER_A);
		const expiredRow = listed.list.find((row) => row.shareId === expired.shareId);
		expect(expiredRow.effectiveStatus).toBe('EXPIRED');
		expect(expiredRow.status).toBe('ACTIVE');
	});

	it('commits share and idempotency together so a limit miss leaves no orphan key (AC-SHARE-15)', async () => {
		await seedOwners();
		await mailShareService.create(ctx({ SHARE_ACTIVE_LIMIT: '1' }), createParams({
			name: 'taken',
			idempotencyKey: 't09-first'
		}), USER_A);
		const message = await catchBiz(mailShareService.create(ctx({ SHARE_ACTIVE_LIMIT: '1' }), createParams({
			name: 'overflow',
			idempotencyKey: 't09-second'
		}), USER_A));
		expect(message).toBe('SHARE_LIMIT_EXCEEDED');
		const { n } = await env.db.prepare(
			'SELECT COUNT(*) AS n FROM mail_share WHERE user_id = ?'
		).bind(USER_A).first();
		expect(n).toBe(1);
		const { keys } = await env.db.prepare(
			"SELECT COUNT(*) AS keys FROM share_idempotency WHERE idempotency_key = 't09-second'"
		).first();
		expect(keys).toBe(0);
	});

	it('lists only the caller owner rows (AC-MGMT-01)', async () => {
		await seedOwners();
		await mailShareService.create(ctx(), createParams({ name: 'mine' }), USER_A);
		await mailShareService.create(ctx(), createParams({
			accountId: ACC_B,
			name: 'theirs'
		}), USER_B);
		const listed = await mailShareService.list(ctx(), {}, USER_A);
		expect(listed.list.map((row) => row.name)).toEqual(['mine']);
		expect(listed.list.every((row) => row.userId === USER_A)).toBe(true);
	});

	it('revokes an owned share and refuses later mutation (AC-LIFE-02, AC-LIFE-04)', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), createParams(), USER_A);
		const revoked = await mailShareService.revoke(ctx(), { shareId: created.shareId }, USER_A);
		expect(revoked.shareId).toBe(created.shareId);
		const row = await env.db.prepare(
			'SELECT status, revoked_at FROM mail_share WHERE share_id = ?'
		).bind(created.shareId).first();
		expect(row.status).toBe('REVOKED');
		expect(row.revoked_at).toEqual(expect.any(String));
		const again = await catchBiz(mailShareService.revoke(ctx(), { shareId: created.shareId }, USER_A));
		expect(again).toBe('SHARE_NOT_FOUND');
		const after = await env.db.prepare(
			'SELECT status, revoked_at FROM mail_share WHERE share_id = ?'
		).bind(created.shareId).first();
		expect(after.status).toBe('REVOKED');
		expect(after.revoked_at).toBe(row.revoked_at);
	});

	it('returns SHARE_NOT_FOUND when operating on someone else share id (AC-MGMT-07)', async () => {
		await seedOwners();
		const theirs = await mailShareService.create(ctx(), createParams({
			accountId: ACC_B
		}), USER_B);
		const message = await catchBiz(mailShareService.revoke(ctx(), { shareId: theirs.shareId }, USER_A));
		expect(message).toBe('SHARE_NOT_FOUND');
		expect(failEnvelope({ message, code: 501, name: 'BizError' })).toBe(
			JSON.stringify(shareResult.fail('SHARE_NOT_FOUND', 501))
		);
		const row = await env.db.prepare('SELECT status FROM mail_share WHERE share_id = ?').bind(theirs.shareId).first();
		expect(row.status).toBe('ACTIVE');
	});

	it('rejects create when sharing is frozen and leaves existing rows ACTIVE (AC-ABUSE-03, AC-LIFE-13)', async () => {
		await seedOwners();
		const live = await mailShareService.create(ctx(), createParams(), USER_A);
		const message = await catchBiz(mailShareService.create(ctx({ SHARE_ENABLED: '0' }), createParams({
			name: 'frozen'
		}), USER_A));
		expect(message).toBe('SHARE_DISABLED');
		const row = await env.db.prepare('SELECT status FROM mail_share WHERE share_id = ?').bind(live.shareId).first();
		expect(row.status).toBe('ACTIVE');
	});

	// T-12 之后 create() 自己就会写 Binding，这四条不能再拿 create() 当「无 Binding 的空壳」用：
	// 手工补一条 ACC_A 会撞 idx_msb_share_account 的 UNIQUE，且主 Binding 已被 create 占定。
	// 改用 seedShareRow + seedBindingRow 直接造行（照抄下面那条 v3_2DB seeded 用例的写法），
	// 断言语义逐条保留：最小 binding_id 胜出 / 跟随幸存者 / 无 Binding 零变更不写 0 / 单语句可入 batch。
	it('syncs the primary account_id to the smallest binding_id account (AC-LIFE-10)', async () => {
		await seedOwners();
		const share = await seedShareRow({ userId: USER_A, accountId: ACC_B });
		const primary = await seedBindingRow({ shareId: share.shareId, accountId: ACC_A });
		const secondary = await seedBindingRow({ shareId: share.shareId, accountId: ACC_C });
		expect(secondary).toBeGreaterThan(primary);

		await syncPrimaryAccountId(ctx(), share.shareId).run();

		expect(await readPrimaryAccountId(share.shareId)).toBe(ACC_A);
	});

	it('follows the surviving primary binding after the first one is removed (AC-LIFE-10 path 2)', async () => {
		await seedOwners();
		const share = await seedShareRow({ userId: USER_A, accountId: ACC_A });
		const primary = await seedBindingRow({ shareId: share.shareId, accountId: ACC_A });
		await seedBindingRow({ shareId: share.shareId, accountId: ACC_C });
		await env.db.prepare('DELETE FROM mail_share_binding WHERE binding_id = ?').bind(primary).run();

		await syncPrimaryAccountId(ctx(), share.shareId).run();

		expect(await readPrimaryAccountId(share.shareId)).toBe(ACC_C);
	});

	it('never writes 0 when the share has no usable binding left (AC-LIFE-10)', async () => {
		await seedOwners();
		const share = await seedShareRow({ userId: USER_A, accountId: ACC_A });
		expect(await readPrimaryAccountId(share.shareId)).toBe(ACC_A);

		const applied = await syncPrimaryAccountId(ctx(), share.shareId).run();

		expect(applied.meta.changes).toBe(0);
		expect(await readPrimaryAccountId(share.shareId)).toBe(ACC_A);
	});

	it('is one conditional UPDATE that composes into a single db.batch (AC-LIFE-10)', async () => {
		await seedOwners();
		const share = await seedShareRow({ userId: USER_A, accountId: ACC_A });
		await seedBindingRow({ shareId: share.shareId, accountId: ACC_C });
		await clearPrimaryAccountId(share.shareId);

		const { seen, db } = sqlProbe();
		const statement = syncPrimaryAccountId({ env: shareEnv({ db }) }, share.shareId);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatch(/UPDATE\s+mail_share/i);
		expect(seen[0].replace(/;\s*$/, '')).not.toContain(';');

		await env.db.batch([statement]);

		expect(await readPrimaryAccountId(share.shareId)).toBe(ACC_C);
	});

	// create 组装双写语句时 share_id 还不存在（AUTOINCREMENT 由同批的 INSERT 决定），
	// 所以助手必须能按 lid 定位；window_start_email_id 与 account_id 同批双写（R2）。
	it('locates the share by lid and dual-writes the primary window snapshot (AC-LIFE-10)', async () => {
		await seedOwners();
		const share = await seedShareRow({ userId: USER_A, accountId: ACC_B, windowStartEmailId: 0 });
		await seedBindingRow({ shareId: share.shareId, accountId: ACC_A, windowStartEmailId: 7 });
		await seedBindingRow({ shareId: share.shareId, accountId: ACC_C, windowStartEmailId: 99 });

		const { seen, db } = sqlProbe();
		const statement = syncPrimaryAccountId({ env: shareEnv({ db }) }, { lid: share.lid });
		expect(seen).toHaveLength(1);
		expect(seen[0].replace(/;\s*$/, '')).not.toContain(';');
		await env.db.batch([statement]);

		const row = await readShareRow(share.shareId);
		expect(row.account_id).toBe(ACC_A);
		expect(row.window_start_email_id).toBe(7);
	});

	it('syncs a seeded v3_2DB-shaped row that never went through create (AC-LIFE-10)', async () => {
		await seedOwners();
		const share = await seedShareRow({
			userId: USER_A,
			accountId: ACC_B,
			maxSessions: 5,
			messageLimit: 10,
			authKeyEnabled: 1,
			authKeyHash: 't04-hash',
			authKeyKid: 'v1',
			credentialsVersion: 2
		});
		await seedBindingRow({ shareId: share.shareId, accountId: ACC_A, windowStartEmailId: 7 });
		await seedBindingRow({ shareId: share.shareId, accountId: ACC_C });

		await syncPrimaryAccountId(ctx(), share.shareId).run();

		expect(await readPrimaryAccountId(share.shareId)).toBe(ACC_A);
		const row = await env.db.prepare(
			'SELECT max_sessions, auth_key_enabled, credentials_version FROM mail_share WHERE share_id = ?'
		).bind(share.shareId).first();
		expect(row).toMatchObject({ max_sessions: 5, auth_key_enabled: 1, credentials_version: 2 });
	});

	it('refuses to seed a share row with a zero primary account_id (AC-LIFE-10)', async () => {
		await expect(seedShareRow({ userId: USER_A, accountId: 0 })).rejects.toThrow(/never|forbids|positive/i);
	});

	// 这四种形状都满足 `value > 0`，却都不是行 ID：'1e3' / '1.5' 是字符串，true 是布尔，
	// Infinity 溢出安全整数区间。放进 D1 绑定后只会被静默强转，种子行的主键语义随之失真。
	describe.each([
		['exponent-notation string', '1e3'],
		['fractional string', '1.5'],
		['boolean true', true],
		['Infinity', Infinity]
	])('rejects %s as a seed row id', (_label, value) => {
		it('as seedShareRow userId', async () => {
			await expect(seedShareRow({ userId: value, accountId: ACC_A })).rejects.toThrow(/positive/i);
		});

		it('as seedShareRow accountId', async () => {
			await expect(seedShareRow({ userId: USER_A, accountId: value })).rejects.toThrow(/positive/i);
		});

		it('as seedBindingRow shareId', async () => {
			await expect(seedBindingRow({ shareId: value, accountId: ACC_A })).rejects.toThrow(/positive/i);
		});

		it('as seedBindingRow accountId', async () => {
			await expect(seedBindingRow({ shareId: 1, accountId: value })).rejects.toThrow(/positive/i);
		});
	});

	it('still seeds normally at the integer floor of 1', async () => {
		const share = await seedShareRow({ userId: 1, accountId: 1 });
		try {
			expect(Number.isSafeInteger(share.shareId)).toBe(true);
			expect(share.shareId).toBeGreaterThan(0);
			const bindingId = await seedBindingRow({ shareId: share.shareId, accountId: 1 });
			expect(bindingId).toBeGreaterThan(0);
		} finally {
			await env.db.prepare('DELETE FROM mail_share_binding WHERE share_id = ?').bind(share.shareId).run();
			await env.db.prepare('DELETE FROM mail_share WHERE share_id = ?').bind(share.shareId).run();
		}
	});

	it('caps bindings per share at the design constant of 50 (AC-CAP-13)', () => {
		expect(SHARE_BINDING_LIMIT).toBe(50);
	});

	it('does not write sec to logs (AC-LEAK-05)', async () => {
		await seedOwners();
		const lines = [];
		const log = console.log;
		const error = console.error;
		console.log = (...args) => lines.push(args.map(String).join(' '));
		console.error = (...args) => lines.push(args.map(String).join(' '));
		try {
			const created = await mailShareService.create(ctx(), createParams(), USER_A);
			await catchBiz(mailShareService.create(ctx(), createParams({ accountId: ACC_B }), USER_A));
			const text = lines.join('\n');
			expect(text).not.toContain(created.sec);
		} finally {
			console.log = log;
			console.error = error;
		}
	});
});

describe('mailShareService multi-mailbox create (T-12)', () => {
	it('creates one share row plus one binding per mailbox and keeps the URL shape (AC-CAP-01)', async () => {
		await seedOwners();
		const created = await mailShareService.create(v2ctx(), createParams({
			accountIds: [ACC_C, ACC_A]
		}), USER_A);

		expect(created.shareUrl).toBe(`https://mail.example.com/s/${created.lid}#${created.sec}`);
		expect(decodeBase64Url(created.lid).length).toBe(16);
		expect(decodeBase64Url(created.sec).length).toBe(32);
		const { shares } = await countOwnerRows(USER_A);
		expect(shares).toBe(1);

		const rows = await listBindings(created.shareId);
		expect(rows.map((row) => row.account_id)).toEqual([ACC_A, ACC_C]);
		expect(created.bindings).toEqual([
			{ bindingId: rows[0].binding_id, accountId: ACC_A },
			{ bindingId: rows[1].binding_id, accountId: ACC_C }
		]);
	});

	it('derives shareType from the binding count and never persists a share_type column (AC-CAP-02)', async () => {
		await seedOwners();
		const single = await mailShareService.create(v2ctx(), createParams(), USER_A);
		const multi = await mailShareService.create(v2ctx(), createParams({
			accountIds: [ACC_A, ACC_C],
			name: 'pool'
		}), USER_A);

		expect(single.shareType).toBe('single');
		expect(single.bindings).toHaveLength(1);
		expect(multi.shareType).toBe('multi');
		expect(multi.bindings).toHaveLength(2);

		const columns = await env.db.prepare("SELECT name FROM pragma_table_info('mail_share')").all();
		expect((columns.results || []).map((row) => row.name)).not.toContain('share_type');
	});

	it('dual-writes the primary account_id and window snapshot onto the main row (AC-LIFE-10)', async () => {
		await seedOwners();
		const olderA = await insertEmail(ACC_A, USER_A, 't09-primary-1');
		const newerA = await insertEmail(ACC_A, USER_A, 't09-primary-2');
		await insertEmail(ACC_C, USER_A, 't09-secondary-1');
		expect(newerA).toBeGreaterThan(olderA);

		const created = await mailShareService.create(v2ctx(), createParams({
			accountIds: [ACC_C, ACC_A]
		}), USER_A);

		const rows = await listBindings(created.shareId);
		const row = await readShareRow(created.shareId);
		expect(row.account_id).toBe(rows[0].account_id);
		expect(row.account_id).toBe(ACC_A);
		expect(row.window_start_email_id).toBe(rows[0].window_start_email_id);
		expect(row.window_start_email_id).toBe(newerA);
	});

	it('refuses the whole create when one accountId belongs to another owner (AC-CAP-03)', async () => {
		await seedOwners();
		const message = await catchBiz(mailShareService.create(v2ctx(), createParams({
			accountIds: [ACC_A, ACC_B]
		}), USER_A));

		expect(message).toBe('SHARE_ACCOUNT_FORBIDDEN');
		expect(await countOwnerRows(USER_A)).toEqual({ shares: 0, bindings: 0 });
	});

	it('refuses the whole create when one accountId is soft-deleted (AC-CAP-03)', async () => {
		await seedOwners();
		await env.db.prepare('UPDATE account SET is_del = ? WHERE account_id = ?').bind(isDel.DELETE, ACC_C).run();

		const message = await catchBiz(mailShareService.create(v2ctx(), createParams({
			accountIds: [ACC_A, ACC_C]
		}), USER_A));

		expect(message).toBe('SHARE_ACCOUNT_FORBIDDEN');
		expect(await countOwnerRows(USER_A)).toEqual({ shares: 0, bindings: 0 });
	});

	it('rejects an empty or malformed accountIds set (AC-CAP-03)', async () => {
		await seedOwners();
		for (const accountIds of [[], [ACC_A, 0], [ACC_A, -1], [ACC_A, 1.5], [ACC_A, null], [ACC_A, Infinity]]) {
			const message = await catchBiz(mailShareService.create(v2ctx(), createParams({ accountIds }), USER_A));
			expect(message).toBe('SHARE_ACCOUNT_FORBIDDEN');
		}
		expect(await countOwnerRows(USER_A)).toEqual({ shares: 0, bindings: 0 });
	});

	it('lets accountIds win when the legacy accountId is also present', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), {
			accountId: ACC_B,
			accountIds: [ACC_A],
			durationSeconds: 3600
		}, USER_A);

		expect((await listBindings(created.shareId)).map((row) => row.account_id)).toEqual([ACC_A]);
		expect(await readPrimaryAccountId(created.shareId)).toBe(ACC_A);
	});

	// 这 51 个 ID 没有对应的 account 行 —— 上限校验刻意排在归属查询与 V2 栅栏之前，
	// 「51 > 50」是永远为真的领域错误，比「能力未激活」对调用方更有用（recon §3.3）。
	it('rejects more than SHARE_BINDING_LIMIT accountIds before the fence and before ownership (AC-CAP-13)', async () => {
		await seedOwners();
		const ids = Array.from({ length: SHARE_BINDING_LIMIT + 1 }, (_unused, index) => 990000 + index);
		const message = await catchBiz(mailShareService.create(ctx(), createParams({ accountIds: ids }), USER_A));

		expect(message).toBe('SHARE_BINDING_LIMIT_EXCEEDED');
		expect(await countOwnerRows(USER_A)).toEqual({ shares: 0, bindings: 0 });
	});

	it('does not treat exactly SHARE_BINDING_LIMIT accountIds as over the cap (AC-CAP-13)', async () => {
		await seedOwners();
		const ids = Array.from({ length: SHARE_BINDING_LIMIT }, (_unused, index) => 990000 + index);
		const message = await catchBiz(mailShareService.create(v2ctx(), createParams({ accountIds: ids }), USER_A));

		expect(message).toBe('SHARE_ACCOUNT_FORBIDDEN');
	});

	it('rejects refreshIntervalMs below 3000 on the write side (AC-CAP-06, AC-OTP-06)', async () => {
		await seedOwners();
		const message = await catchBiz(mailShareService.create(ctx(), createParams({
			refreshIntervalMs: 2999
		}), USER_A));
		expect(message).toBe('SHARE_INVALID_CONFIG');
		expect(await countOwnerRows(USER_A)).toEqual({ shares: 0, bindings: 0 });

		const created = await mailShareService.create(ctx(), createParams({
			refreshIntervalMs: 5000
		}), USER_A);
		expect((await readShareRow(created.shareId)).refresh_interval_ms).toBe(5000);
	});

	it('rejects out-of-range messageLimit and maxSessions (AC-CAP-06)', async () => {
		await seedOwners();
		expect(await catchBiz(mailShareService.create(v2ctx(), createParams({
			messageLimit: 0
		}), USER_A))).toBe('SHARE_INVALID_CONFIG');
		expect(await catchBiz(mailShareService.create(v2ctx(), createParams({
			maxSessions: 0
		}), USER_A))).toBe('SHARE_INVALID_CONFIG');
		expect(await countOwnerRows(USER_A)).toEqual({ shares: 0, bindings: 0 });
	});

	// AC-CAP-06 要求「校验取值域后随行存储」。归一化过宽时 `'invalid'` / `2` / `{}` 会静默变成 1,
	// 也就是静默打开 AuthKey、关掉地址掩码;`true` 会静默变成配额 1。值域必须封在归一化边界。
	it.each(FLAG_FIELDS.flatMap((field) => MALFORMED_FLAGS.map((value) => [field, value])))(
		'rejects a malformed %s (%o) with SHARE_INVALID_CONFIG (AC-CAP-06)',
		async (field, value) => {
			await seedOwners();
			expect(await catchBiz(mailShareService.create(v2ctx(), createParams({ [field]: value }), USER_A)))
				.toBe('SHARE_INVALID_CONFIG');
			expect(await countOwnerRows(USER_A)).toEqual({ shares: 0, bindings: 0 });
		}
	);

	it.each(COUNT_FIELDS.flatMap((field) => MALFORMED_COUNTS.map((value) => [field, value])))(
		'rejects a malformed %s (%o) with SHARE_INVALID_CONFIG (AC-CAP-06)',
		async (field, value) => {
			await seedOwners();
			expect(await catchBiz(mailShareService.create(v2ctx(), createParams({ [field]: value }), USER_A)))
				.toBe('SHARE_INVALID_CONFIG');
			expect(await countOwnerRows(USER_A)).toEqual({ shares: 0, bindings: 0 });
		}
	);

	it('still accepts every flag token the contract allows (AC-CAP-06)', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), createParams({
			onlyMessagesAfterCreated: '0',
			otpExtractionEnabled: 'false',
			autoRefresh: 0,
			showFullAddress: '1',
			authKeyEnabled: false
		}), USER_A);

		expect(await readShareRow(created.shareId)).toMatchObject({
			only_messages_after_created: 0,
			otp_extraction_enabled: 0,
			auto_refresh: 0,
			show_full_address: 1,
			auth_key_enabled: 0
		});
	});

	it('still accepts integer-valued count strings (AC-CAP-06)', async () => {
		await seedOwners();
		const created = await mailShareService.create(v2ctx(), createParams({
			maxSessions: '3',
			messageLimit: '5'
		}), USER_A);

		expect(await readShareRow(created.shareId)).toMatchObject({ max_sessions: 3, message_limit: 5 });
	});

	it('stores the accepted configuration set on the share row (AC-CAP-06)', async () => {
		await seedOwners();
		const created = await mailShareService.create(v2ctx(), createParams({
			maxSessions: 3,
			messageLimit: 5,
			onlyMessagesAfterCreated: false,
			otpExtractionEnabled: false,
			autoRefresh: false,
			refreshIntervalMs: 4000,
			showFullAddress: true
		}), USER_A);

		expect(await readShareRow(created.shareId)).toMatchObject({
			max_sessions: 3,
			message_limit: 5,
			only_messages_after_created: 0,
			otp_extraction_enabled: 0,
			auto_refresh: 0,
			refresh_interval_ms: 4000,
			show_full_address: 1
		});
	});

	it('snapshots every binding window at its own mailbox MAX(email_id) (AC-CAP-07)', async () => {
		await seedOwners();
		await insertEmail(ACC_A, USER_A, 't09-win-a1');
		const maxA = await insertEmail(ACC_A, USER_A, 't09-win-a2');
		const maxC = await insertEmail(ACC_C, USER_A, 't09-win-c1');
		expect(maxC).toBeGreaterThan(maxA);

		const created = await mailShareService.create(v2ctx(), createParams({
			accountIds: [ACC_A, ACC_C],
			onlyMessagesAfterCreated: true
		}), USER_A);

		const rows = await listBindings(created.shareId);
		expect(rows.map((row) => [row.account_id, row.window_start_email_id])).toEqual([
			[ACC_A, maxA],
			[ACC_C, maxC]
		]);
	});

	it('writes 0 to every binding window when onlyMessagesAfterCreated is false (AC-CAP-08)', async () => {
		await seedOwners();
		await insertEmail(ACC_A, USER_A, 't09-zero-a1');
		await insertEmail(ACC_C, USER_A, 't09-zero-c1');

		const created = await mailShareService.create(v2ctx(), createParams({
			accountIds: [ACC_A, ACC_C],
			onlyMessagesAfterCreated: false
		}), USER_A);

		const rows = await listBindings(created.shareId);
		expect(rows.map((row) => row.window_start_email_id)).toEqual([0, 0]);
		expect((await readShareRow(created.shareId)).window_start_email_id).toBe(0);
	});

	it('keeps the per-binding snapshot inside the write statements (AC-CAP-07, AC-SHARE-16)', async () => {
		await seedOwners();
		await insertEmail(ACC_A, USER_A, 't09-atomic-a');
		const { seen, db } = sqlProbe();

		await mailShareService.create({ env: shareEnv({ db, SHARE_CAPABILITY_V2: 'true' }) }, createParams({
			accountIds: [ACC_A, ACC_C]
		}), USER_A);

		const bindingSql = seen.find((sql) => /INSERT\s+INTO\s+mail_share_binding/i.test(sql));
		expect(bindingSql).toEqual(expect.any(String));
		expect(bindingSql).toMatch(/COALESCE\s*\(\s*MAX\s*\(\s*e\.email_id\s*\)/i);
		expect(seen.some((sql) => /SELECT\s+MAX\s*\(\s*email_id\s*\)/i.test(sql))).toBe(false);
	});

	it('returns the AuthKey plaintext exactly once and stores only hash plus kid (AC-CAP-05)', async () => {
		await seedOwners();
		const created = await mailShareService.create(v2ctx(), createParams({
			authKeyEnabled: true,
			idempotencyKey: 't09-authkey'
		}), USER_A);

		expect(created.authKey).toEqual(expect.any(String));
		expect(created.authKey).toHaveLength(22);
		expect(decodeBase64Url(created.authKey).length).toBe(16);

		const row = await readShareRow(created.shareId);
		expect(row.auth_key_enabled).toBe(1);
		expect(row.auth_key_hash).toBe(await shareAuthService.digestShareSecret(created.authKey, PEPPER));
		expect(row.auth_key_kid).toBe('v2');
		expect(Object.values(row)).not.toContain(created.authKey);

		const replay = await mailShareService.create(v2ctx(), createParams({
			authKeyEnabled: true,
			idempotencyKey: 't09-authkey'
		}), USER_A);
		expect(replay.shareId).toBe(created.shareId);
		expect(replay.idempotentReplay).toBe(true);
		expect(replay.authKey).toBeUndefined();
		expect(replay.sec).toBeUndefined();

		const listed = await mailShareService.list(ctx(), {}, USER_A);
		expect(JSON.stringify(listed)).not.toContain(created.authKey);
	});

	// T-08 的 establishSession 要用同一口径校验 AuthKey：pepper 复用 SHARE_SEC_PEPPER，
	// kid 复用 SHARE_SEC_PEPPER_KID（= sec 的 pepper_kid）。这条断言就是交给 T-08 的契约。
	it('derives auth_key_hash from the same pepper and kid as sec (T-08 input contract)', async () => {
		await seedOwners();
		const created = await mailShareService.create(v2ctx(), createParams({ authKeyEnabled: true }), USER_A);
		const row = await readShareRow(created.shareId);

		expect(row.auth_key_kid).toBe(row.pepper_kid);
		expect(row.auth_key_hash).toBe(await shareAuthService.digestShareSecret(created.authKey, PEPPER));
		expect(row.auth_key_hash).not.toBe(row.sec_hmac);
	});

	it('leaves auth key columns null when the feature stays off (AC-CAP-05)', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), createParams(), USER_A);
		const row = await readShareRow(created.shareId);

		expect(created.authKey).toBeUndefined();
		expect(row.auth_key_enabled).toBe(0);
		expect(row.auth_key_hash == null).toBe(true);
		expect(row.auth_key_kid == null).toBe(true);
	});

	it('never writes the AuthKey plaintext to logs (AC-LEAK-05)', async () => {
		await seedOwners();
		const lines = [];
		const log = console.log;
		const error = console.error;
		console.log = (...args) => lines.push(args.map(String).join(' '));
		console.error = (...args) => lines.push(args.map(String).join(' '));
		try {
			const created = await mailShareService.create(v2ctx(), createParams({ authKeyEnabled: true }), USER_A);
			await catchBiz(mailShareService.create(v2ctx(), createParams({
				accountIds: [ACC_A, ACC_B],
				authKeyEnabled: true
			}), USER_A));
			expect(lines.join('\n')).not.toContain(created.authKey);
		} finally {
			console.log = log;
			console.error = error;
		}
	});

	it('folds a reordered and duplicated accountIds set into the same fingerprint (AC-CAP-09)', async () => {
		await seedOwners();
		const first = await mailShareService.create(v2ctx(), createParams({
			accountIds: [ACC_C, ACC_A],
			idempotencyKey: 't09-set-order'
		}), USER_A);
		const replay = await mailShareService.create(v2ctx(), createParams({
			accountIds: [ACC_A, ACC_C, ACC_A],
			idempotencyKey: 't09-set-order'
		}), USER_A);

		expect(replay.shareId).toBe(first.shareId);
		expect(replay.lid).toBe(first.lid);
		expect(replay.idempotentReplay).toBe(true);
		expect(replay.sec).toBeUndefined();
		expect(replay.shareType).toBe('multi');
		expect(replay.bindings).toEqual(first.bindings);
		const { shares } = await countOwnerRows(USER_A);
		expect(shares).toBe(1);
	});

	it('treats omitted new config fields as their defaults for the fingerprint (AC-CAP-09)', async () => {
		await seedOwners();
		const first = await mailShareService.create(ctx(), {
			accountId: ACC_A,
			durationSeconds: 3600,
			idempotencyKey: 't09-defaults'
		}, USER_A);
		const replay = await mailShareService.create(ctx(), {
			accountIds: [ACC_A],
			durationSeconds: 3600,
			name: '',
			remark: '',
			maxSessions: null,
			messageLimit: null,
			onlyMessagesAfterCreated: true,
			otpExtractionEnabled: true,
			autoRefresh: true,
			refreshIntervalMs: 3000,
			showFullAddress: false,
			authKeyEnabled: false,
			idempotencyKey: 't09-defaults'
		}, USER_A);

		expect(replay.shareId).toBe(first.shareId);
		expect(replay.idempotentReplay).toBe(true);
		expect(replay.shareType).toBe('single');
	});

	it.each([
		['showFullAddress', { showFullAddress: true }],
		['otpExtractionEnabled', { otpExtractionEnabled: false }],
		['autoRefresh', { autoRefresh: false }],
		['refreshIntervalMs', { refreshIntervalMs: 9000 }],
		['messageLimit', { messageLimit: 4 }],
		['maxSessions', { maxSessions: 2 }],
		['authKeyEnabled', { authKeyEnabled: true }],
		['accountIds', { accountIds: [ACC_A, ACC_C] }]
	])('makes %s part of the request fingerprint (AC-CAP-09)', async (label, overrides) => {
		await seedOwners();
		const key = `t09-fp-${label}`;
		await mailShareService.create(v2ctx(), createParams({ idempotencyKey: key }), USER_A);
		const message = await catchBiz(mailShareService.create(v2ctx(), createParams({
			idempotencyKey: key,
			...overrides
		}), USER_A));

		expect(message).toBe('SHARE_IDEMPOTENCY_CONFLICT');
		const { shares } = await countOwnerRows(USER_A);
		expect(shares).toBe(1);
	});

	// 滚动发布 old→new:旧 Worker 建成分享后响应丢失,同一 key + 同一载荷落到新 Worker。
	// 存量行里的指纹是旧四字段 hash,新代码必须认它并安全重放,而不是 SHARE_IDEMPOTENCY_CONFLICT
	// —— Owner 已经拿不到 sec,换 key 重试只会建出第二条分享(AC-CAP-09/14, AC-LIFE-10)。
	it('replays an idempotency row written with the old four-field fingerprint (AC-CAP-09, AC-CAP-14, AC-LIFE-10)', async () => {
		await seedOwners();
		const legacyParams = { accountId: ACC_A, durationSeconds: 3600, name: 'colleague', remark: 'otp handoff' };
		const first = await mailShareService.create(ctx(), legacyParams, USER_A);
		await env.db.prepare(`
			INSERT INTO share_idempotency (
				user_id, idempotency_key, operation, request_fingerprint, share_id, response_fingerprint
			) VALUES (?, ?, 'create', ?, ?, ?)
		`).bind(
			USER_A,
			't12-rolling-old',
			await legacyFingerprint(legacyParams),
			first.shareId,
			JSON.stringify({ lid: first.lid })
		).run();

		const replay = await mailShareService.create(ctx(), {
			...legacyParams,
			idempotencyKey: 't12-rolling-old'
		}, USER_A);

		expect(replay.shareId).toBe(first.shareId);
		expect(replay.lid).toBe(first.lid);
		expect(replay.idempotentReplay).toBe(true);
		expect(replay.sec).toBeUndefined();
		expect(replay.authKey).toBeUndefined();
		expect((await countOwnerRows(USER_A)).shares).toBe(1);
	});

	// 滚动发布 new→old:同一窗口内路由是随机的,所以新 Worker 为兼容载荷落库的指纹
	// 必须是旧 Worker 也会算出的那一个,否则回滚/重试打到旧 Worker 时同样 CONFLICT。
	it('persists the old four-field fingerprint for a legacy-compatible create (AC-CAP-09, AC-LIFE-10)', async () => {
		await seedOwners();
		const legacyParams = { accountId: ACC_A, durationSeconds: 3600, name: 'colleague', remark: 'otp handoff' };
		await mailShareService.create(ctx(), { ...legacyParams, idempotencyKey: 't12-rolling-new' }, USER_A);

		const row = await env.db.prepare(`
			SELECT request_fingerprint FROM share_idempotency WHERE user_id = ? AND idempotency_key = ?
		`).bind(USER_A, 't12-rolling-new').first();
		expect(row.request_fingerprint).toBe(await legacyFingerprint(legacyParams));
	});

	// 兼容口径只对「单邮箱 + 全默认」开放。任一新字段离开默认值就只认 12 字段 hash,
	// 否则旧 Worker 会重放出一条它根本无法执行的策略。
	it('keeps a non-legacy create off the old fingerprint (AC-CAP-09)', async () => {
		await seedOwners();
		const params = { accountId: ACC_A, durationSeconds: 3600, name: 'colleague', remark: 'otp handoff' };
		await mailShareService.create(v2ctx(), { ...params, maxSessions: 3, idempotencyKey: 't12-rolling-multi' }, USER_A);

		const row = await env.db.prepare(`
			SELECT request_fingerprint FROM share_idempotency WHERE user_id = ? AND idempotency_key = ?
		`).bind(USER_A, 't12-rolling-multi').first();
		expect(row.request_fingerprint).not.toBe(await legacyFingerprint(params));
	});

	it('creates the legacy single-accountId payload with every configuration default (AC-CAP-10)', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), {
			accountId: ACC_A,
			durationSeconds: 3600
		}, USER_A);

		expect(created.shareType).toBe('single');
		expect(created.bindings).toEqual([
			{ bindingId: expect.any(Number), accountId: ACC_A }
		]);
		const row = await readShareRow(created.shareId);
		expect(row.max_sessions == null).toBe(true);
		expect(row.message_limit == null).toBe(true);
		expect(row).toMatchObject({
			account_id: ACC_A,
			name: '',
			remark: '',
			only_messages_after_created: 1,
			otp_extraction_enabled: 1,
			auto_refresh: 1,
			refresh_interval_ms: 3000,
			show_full_address: 0,
			auth_key_enabled: 0,
			credentials_version: 0
		});
	});

	// 预检是 TOCTOU 窗口,不是防线。这条把 account 删除塞进预检与 batch 之间,直击写入语句里的
	// 归属计数谓词 —— D1 没有 BEGIN,零残留只能靠这条谓词,不能靠回滚。
	it('keeps the write atomic when an account is deleted after the precheck (AC-CAP-03, AC-BIND-10)', async () => {
		await seedOwners();
		const realBatch = env.db.batch.bind(env.db);
		const db = new Proxy(env.db, {
			get(target, prop) {
				if (prop === 'batch') {
					return async (statements) => {
						await env.db.prepare('UPDATE account SET is_del = ? WHERE account_id = ?')
							.bind(isDel.DELETE, ACC_C).run();
						return realBatch(statements);
					};
				}
				const value = target[prop];
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});

		const message = await catchBiz(mailShareService.create({
			env: shareEnv({ db, SHARE_CAPABILITY_V2: 'true' })
		}, createParams({ accountIds: [ACC_A, ACC_C] }), USER_A));

		expect(message).toBe('SHARE_ACCOUNT_FORBIDDEN');
		expect(await countOwnerRows(USER_A)).toEqual({ shares: 0, bindings: 0 });
	});

	it('leaves no binding behind when the active limit blocks the share insert (AC-CAP-03, AC-SHARE-15)', async () => {
		await seedOwners();
		await mailShareService.create(v2ctx({ SHARE_ACTIVE_LIMIT: '1' }), createParams({ name: 'taken' }), USER_A);
		const message = await catchBiz(mailShareService.create(v2ctx({ SHARE_ACTIVE_LIMIT: '1' }), createParams({
			accountIds: [ACC_A, ACC_C],
			name: 'overflow'
		}), USER_A));

		expect(message).toBe('SHARE_LIMIT_EXCEEDED');
		expect(await countOwnerRows(USER_A)).toEqual({ shares: 1, bindings: 1 });
	});
});

describe('create under SHARE_CAPABILITY_V2=false (AC-LIFE-11)', () => {
	it.each([
		['multi-mailbox create', { accountIds: [ACC_A, ACC_C] }],
		['AuthKey enable', { authKeyEnabled: true }],
		['a finite maxSessions', { maxSessions: 5 }],
		['a finite messageLimit', { messageLimit: 5 }]
	])('rejects %s with SHARE_CAPABILITY_NOT_ENABLED and leaves zero rows', async (_label, overrides) => {
		await seedOwners();
		const message = await catchBiz(mailShareService.create(ctx(), createParams(overrides), USER_A));

		expect(message).toBe('SHARE_CAPABILITY_NOT_ENABLED');
		expect(await countOwnerRows(USER_A)).toEqual({ shares: 0, bindings: 0 });
	});

	// window 下界由 R2 的主表双写覆盖，show_full_address=1 只是「掩码在旧 Worker 上失效」——
	// 方向是收紧失效不是越权，两者都不进栅栏（主 AI 裁决 T12-R3）。
	it('still accepts onlyMessagesAfterCreated=false and showFullAddress=1', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), createParams({
			onlyMessagesAfterCreated: false,
			showFullAddress: true
		}), USER_A);

		expect(created.shareType).toBe('single');
		expect(await readShareRow(created.shareId)).toMatchObject({
			only_messages_after_created: 0,
			show_full_address: 1
		});
	});

	it('still accepts explicit nulls for the gated quota fields', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), createParams({
			maxSessions: null,
			messageLimit: null,
			authKeyEnabled: false
		}), USER_A);

		const row = await readShareRow(created.shareId);
		expect(row.max_sessions == null).toBe(true);
		expect(row.message_limit == null).toBe(true);
	});

	it('keeps the production wrangler.toml from opening the fence', () => {
		const active = wranglerToml
			.split('\n')
			.filter((line) => line.trim().startsWith('SHARE_CAPABILITY_V2'));
		expect(active).toEqual([]);
	});

	// 同一条 keep_vars 教训(`wrangler.toml:72`):toml 里显式写出的值会覆盖 Dashboard 配的值,
	// 所以「把上限写进生产 toml」看着是显式化,实际是把运维在 Dashboard 上调好的上限
	// 硬压回仓库里的字面量。I-2 的兜底让这一项不必再写进 toml —— 缺失已经不等于不设防。
	it('keeps the production wrangler.toml from pinning the duration ceiling (keep_vars)', () => {
		const active = wranglerToml
			.split('\n')
			.filter((line) => line.trim().startsWith('SHARE_MAX_DURATION_SECONDS'));
		expect(active).toEqual([]);
	});
});

function catchBizSync(fn) {
	try {
		fn();
	} catch (err) {
		if (err && err.name === 'BizError') {
			return err;
		}
		throw err;
	}
	throw new Error('expected BizError');
}

function captureLog(fn) {
	const lines = [];
	const log = console.log;
	console.log = (...args) => lines.push(args.map(String).join(' '));
	try {
		fn();
	} finally {
		console.log = log;
	}
	return lines;
}

// 带请求上下文的最小 hono 替身:`req.header` 供 requestId 取平台标识,`get`/`set` 供它
// 在一次请求内只算一次 —— 同一请求的多条事件必须落在同一个 requestId 上才能串成时间线。
function reqCtx(ray, overrides = {}) {
	const store = new Map();
	return {
		env: shareEnv(overrides),
		req: { header: (name) => (String(name).toLowerCase() === 'cf-ray' ? ray : undefined) },
		get: (key) => store.get(key),
		set: (key, value) => store.set(key, value)
	};
}

const GATED_INTENTS = ['multi_create', 'binding_expand', 'auth_key_enable', 'finite_max_sessions', 'message_limit'];

describe('SHARE_CAPABILITY_V2 capability fence (AC-LIFE-11)', () => {
	// message_limit 是 T-12 补进来的第五条：旧 Worker 不认识该列，落库即「可见集被放宽到全部」，
	// 与 multi / AuthKey / 有限配额同构（主 AI 裁决 T12-R3）。
	it('names the gated intents the rolling-release fence has to stop', () => {
		expect(SHARE_V2_INTENT).toEqual({
			MULTI_CREATE: 'multi_create',
			BINDING_EXPAND: 'binding_expand',
			AUTH_KEY_ENABLE: 'auth_key_enable',
			FINITE_MAX_SESSIONS: 'finite_max_sessions',
			MESSAGE_LIMIT: 'message_limit'
		});
		expect(Object.values(SHARE_V2_INTENT).sort()).toEqual([...GATED_INTENTS].sort());
	});

	// 栅栏是暂时的发布态,前两种 SHARE_INVALID_CONFIG(状态不匹配 / 配置越域)是永久领域错误。
	// 共用一个码时管理台只能靠语句顺序猜,所以栅栏单独占一个可辨识的码。
	it.each(GATED_INTENTS)('rejects %s with SHARE_CAPABILITY_NOT_ENABLED when the flag is missing', (intent) => {
		const err = catchBizSync(() => assertCapabilityV2({ env: {} }, intent));
		expect(err.message).toBe('SHARE_CAPABILITY_NOT_ENABLED');
		expect(err.code).toBe(501);
	});

	it.each(GATED_INTENTS)('rejects %s when the flag is explicitly off', (intent) => {
		for (const flag of ['false', '0', 0, false, '']) {
			const err = catchBizSync(() => assertCapabilityV2(ctx({ SHARE_CAPABILITY_V2: flag }), intent));
			expect(err.message).toBe('SHARE_CAPABILITY_NOT_ENABLED');
		}
	});

	it.each(GATED_INTENTS)('lets %s through once the flag is on', (intent) => {
		for (const flag of ['true', '1', 1, true]) {
			expect(assertCapabilityV2(ctx({ SHARE_CAPABILITY_V2: flag }), intent)).toBeUndefined();
		}
	});

	it('does not read the flag off the setting row the way SHARE_ENABLED does', () => {
		// SHARE_ENABLED 有 setting 死分支；V2 栅栏是发布协议开关，只认环境变量。
		const c = ctx({ SHARE_CAPABILITY_V2: 'false' });
		c.get = () => ({ share: 0, shareCapabilityV2: 1 });
		const err = catchBizSync(() => assertCapabilityV2(c, SHARE_V2_INTENT.MULTI_CREATE));
		expect(err.message).toBe('SHARE_CAPABILITY_NOT_ENABLED');
	});

	// 防「图省事全改成新码」:栅栏拆码后,永久领域错误必须仍是 SHARE_INVALID_CONFIG,
	// 否则管理台会把一个写错的取值读成「平台没开这项能力」,指向完全错误的自助动作。
	it('leaves the two permanent domain errors on SHARE_INVALID_CONFIG', async () => {
		const c = v2ctx();
		const { shareId } = await seedShareRow({ userId: USER_A, accountId: ACC_A, authKeyEnabled: 0 });
		// ① 状态不匹配:已是「未启用」还要再 disable。
		expect(await catchBiz(mailShareService.resetAuthKey(c, { shareId, action: 'disable' }, USER_A)))
			.toBe('SHARE_INVALID_CONFIG');
		// ② 配置越域:刷新间隔低于下限。
		expect(await catchBiz(mailShareService.update(c, { shareId, refreshIntervalMs: 1 }, USER_A)))
			.toBe('SHARE_INVALID_CONFIG');
	});
});

describe('structured share observability events (R2-F2 / R3-A7)', () => {
	it('pins the fixed event-name list from design.md', () => {
		expect(SHARE_EVENT).toEqual({
			SESSION_DENIED_QUOTA: 'share.session.denied_quota',
			SESSION_DENIED_AUTH: 'share.session.denied_auth',
			SESSION_DENIED_CV: 'share.session.denied_cv',
			BINDING_CASCADE: 'share.binding.cascade',
			MIGRATE_INVALID_ROW: 'share.migrate.invalid_row',
			// T-20b2b:凭据暴露面的审计线。事件名是告警规则的契约,加一条要连着告警
			// 规则一起加,所以它必须出现在这张钉死的清单里而不是随手 import。
			SEC_REVEAL: 'share.sec.reveal',
			SYSTEM_ERROR: 'share.system.error'
		});
	});

	it('emits one JSON line carrying requestId and shareId even when unset', () => {
		const lines = captureLog(() => {
			logShareEvent(ctx(), SHARE_EVENT.SESSION_DENIED_QUOTA, { shareId: 42, reason: 'quota_exhausted' });
			logShareEvent(ctx(), SHARE_EVENT.SYSTEM_ERROR, {});
		});
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(line).not.toContain('\n');
		}
		const denied = JSON.parse(lines[0]);
		expect(denied).toMatchObject({
			event: 'share.session.denied_quota',
			requestId: null,
			shareId: 42,
			reason: 'quota_exhausted'
		});
		expect(denied.ts).toEqual(expect.any(String));
		expect(JSON.parse(lines[1])).toMatchObject({
			event: 'share.system.error',
			requestId: null,
			shareId: null
		});
	});

	it('never lets a diagnostic field overwrite the canonical envelope', () => {
		const lines = captureLog(() => {
			logShareEvent(ctx(), SHARE_EVENT.SESSION_DENIED_AUTH, {
				event: 'overridden',
				ts: 'overridden',
				requestId: 'overridden',
				shareId: 7,
				reason: 'bad_sec'
			});
		});
		const parsed = JSON.parse(lines[0]);
		expect(parsed.event).toBe('share.session.denied_auth');
		expect(parsed.ts).not.toBe('overridden');
		expect(parsed).toMatchObject({ requestId: null, shareId: 7, reason: 'bad_sec' });
	});

	// 成功状态①的可验证形式:运维按 requestId 过滤,一次请求产生的多条事件必须全部落在
	// 同一个值上。`requestId` 恒为 null 时这条时间线根本不存在(线上实际就是这样)。
	it('stamps every event of one request with the same requestId', () => {
		const c = reqCtx('8f1c2d3e4a5b6071-SJC');
		const lines = captureLog(() => {
			logShareEvent(c, SHARE_EVENT.SESSION_DENIED_AUTH, { shareId: 11, reason: 'auth_key_mismatch' });
			logShareEvent(c, SHARE_EVENT.SYSTEM_ERROR, { shareId: 11, reason: 'replay_cache_read_failed' });
		});
		const [first, second] = lines.map((line) => JSON.parse(line));
		expect(first.requestId).toBe('8f1c2d3e4a5b6071-SJC');
		expect(second.requestId).toBe(first.requestId);
	});

	// 两个请求之间必须可分辨,否则「串成一条时间线」会把并发访客的事件混进同一条。
	it('gives two different requests two different requestIds', () => {
		const lines = captureLog(() => {
			logShareEvent(reqCtx('aaa1-SJC'), SHARE_EVENT.SESSION_DENIED_QUOTA, { shareId: 1, reason: 'quota_race' });
			logShareEvent(reqCtx('bbb2-SJC'), SHARE_EVENT.SESSION_DENIED_QUOTA, { shareId: 2, reason: 'quota_race' });
		});
		const [first, second] = lines.map((line) => JSON.parse(line));
		expect(first.requestId).toBe('aaa1-SJC');
		expect(second.requestId).toBe('bbb2-SJC');
	});

	// 本地 wrangler dev 不经边缘,没有 cf-ray。此时仍要能串起来,否则交付契约里那次
	// e2e(本地起 dev、按 requestId 对齐多条事件)根本没法做。
	it('still correlates one request when the platform header is absent', () => {
		const c = reqCtx(undefined);
		const lines = captureLog(() => {
			logShareEvent(c, SHARE_EVENT.SESSION_DENIED_CV, { shareId: 3, reason: 'credentials_version_mismatch' });
			logShareEvent(c, SHARE_EVENT.SYSTEM_ERROR, { shareId: 3, reason: 'replay_cache_write_failed' });
		});
		const [first, second] = lines.map((line) => JSON.parse(line));
		expect(typeof first.requestId).toBe('string');
		expect(first.requestId).not.toHaveLength(0);
		expect(second.requestId).toBe(first.requestId);
	});

	// 定时清理与迁移没有请求可关联。此时 requestId 是 null 而不是「缺这个键」——
	// 按字段过滤的告警规则漏掉的是缺字段的那类,不是值为 null 的那类。
	it('keeps the requestId key present as null outside any request', () => {
		const lines = captureLog(() => {
			logShareEvent({ env: {} }, SHARE_EVENT.BINDING_CASCADE, { shareId: 9, reason: 'expired' });
		});
		const parsed = JSON.parse(lines[0]);
		expect(parsed).toHaveProperty('requestId', null);
	});

	// 上面几条用的是手搓 context。这条换成**真的 hono Context**:`shareRequestId` 依赖
	// `c.req.header` / `c.get` / `c.set` 三个真实 API,假替身把它们实现成什么样都能自证。
	// 缺这条,「恒带 requestId」可以在单测全绿的同时线上仍恒为 null —— 那正是本轮的原状。
	it('reads the platform id off a real hono context (R2-F2 · design.md:451)', async () => {
		const probe = new Hono();
		probe.get('/probe', (c) => c.json({
			first: shareRequestId(c),
			// 同一个 context 上第二次调用必须复用,否则一次请求里的多条事件各带一个值。
			second: shareRequestId(c)
		}));
		const ray = '9a1b2c3d4e5f6071-SJC';
		const answer = await probe.request('/probe', { headers: { 'CF-Ray': ray } });
		const body = await answer.json();

		expect(body.first).toBe(ray);
		expect(body.second).toBe(ray);
	});

	it('mints and reuses one id per real request when cf-ray is absent', async () => {
		const probe = new Hono();
		probe.get('/probe', (c) => c.json({ first: shareRequestId(c), second: shareRequestId(c) }));

		const one = await (await probe.request('/probe')).json();
		const two = await (await probe.request('/probe')).json();

		expect(one.first).toEqual(expect.any(String));
		expect(one.second).toBe(one.first);
		// 两次独立请求不能撞在同一个值上,否则并发访客的事件会混进同一条时间线。
		expect(two.first).not.toBe(one.first);
	});

	// init.js 原来手写 console.log,字段形状与其余五个事件不同,按字段过滤的告警规则会整类
	// 漏掉它。收归统一出口,但**不能**让迁移路径依赖 share 服务(原断言刻意钉住的边界,
	// 且那条依赖会与 share-auth-service 形成回环),所以出口自己是一个无依赖模块。
	it('routes the migration event through the shared emitter, not its own literal', () => {
		expect(initSource).toMatch(/from\s+['"][^'"]*share-event/);
		expect(initSource).toContain('SHARE_EVENT.MIGRATE_INVALID_ROW');
		expect(initSource).not.toContain("event: 'share.migrate.invalid_row'");
		expect(initSource).not.toMatch(/from\s+['"].*mail-share-service/);
	});
});

// ── T-13 · bindings 增删（全有或全无原子命令）────────────────────────────────
// 分享行一律用 seedShareRow + seedBindingRow 直接造：create 走 V2 栅栏，而这里要测的
// 是「已经存在 N 条 Binding 的分享」被增删时的行为，两者是不同的写入口。
async function seedShareWithBindings(accountIds, overrides = {}) {
	const share = await seedShareRow({ userId: USER_A, accountId: accountIds[0], ...overrides });
	const bindingIds = [];
	for (const accountId of accountIds) {
		bindingIds.push(await seedBindingRow({ shareId: share.shareId, accountId }));
	}
	return { ...share, bindingIds };
}

async function bindingAccountIds(shareId) {
	return (await listBindings(shareId)).map((row) => row.account_id);
}

function batchProbe() {
	const seen = [];
	let batches = 0;
	const prepare = env.db.prepare.bind(env.db);
	const batch = env.db.batch.bind(env.db);
	const db = new Proxy(env.db, {
		get(target, prop) {
			if (prop === 'prepare') {
				return (sql) => {
					seen.push(String(sql));
					return prepare(sql);
				};
			}
			if (prop === 'batch') {
				return (statements) => {
					batches += 1;
					return batch(statements);
				};
			}
			const value = target[prop];
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
	return { seen, db, batchCount: () => batches };
}

const ACC_D = 909104;
const MAIL_D = 't09-owner-d@example.com';

// 把 account 软删塞进预检与 batch 之间：写入侧谓词是唯一防线，预检只决定错误码。
function killAccountOnBatch(accountId) {
	const realBatch = env.db.batch.bind(env.db);
	return new Proxy(env.db, {
		get(target, prop) {
			if (prop === 'batch') {
				return async (statements) => {
					await env.db.prepare('UPDATE account SET is_del = ? WHERE account_id = ?')
						.bind(isDel.DELETE, accountId).run();
					return realBatch(statements);
				};
			}
			const value = target[prop];
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

// 把「预读之后 Binding 集合被并发命令改写」塞进预检与 batch 之间。用代理而不是两个
// Promise，是因为这里要钉的是单条命令的写入侧谓词，不该依赖调度顺序。
function driftBindingsOnBatch(mutate) {
	const realBatch = env.db.batch.bind(env.db);
	return new Proxy(env.db, {
		get(target, prop) {
			if (prop === 'batch') {
				return async (statements) => {
					await mutate();
					return realBatch(statements);
				};
			}
			const value = target[prop];
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

// D1 每条语句最多 100 个绑定参数：https://developers.cloudflare.com/d1/platform/limits/
const D1_MAX_BOUND_PARAMS = 100;
const BULK_ACC_BASE = 909300;

function bindSlots(sql) {
	return (String(sql).match(/\?/g) || []).length;
}

// 上限用例必须用真实的自有 account：合成 id 在 assertOwnedAccounts 就被拒，
// 根本走不到 SQL，也就证不了绑定参数预算。
async function seedOwnedAccounts(count) {
	const accountIds = [];
	for (let index = 0; index < count; index += 1) {
		const accountId = BULK_ACC_BASE + index;
		await ensureAccount({ accountId, email: `t09-bulk-${index}@example.com`, userId: USER_A });
		accountIds.push(accountId);
	}
	return accountIds;
}

const OWNER_EMAIL = 't13-owner@example.com';

// T-15：`/mailShare/list` 在 `requirePermsExact` 里，所以 HTTP 用例的 Owner 必须真的
// 持有 `share:manage`（`user.type` 即 role_id）。新加的 get/update/delete 三条尚未进
// 那张表（归 T-17），本 helper 一并授权，等 T-17 收编后无需再改。
const SHARE_PERM_ID = 37;
const SHARE_ROLE_ID = 98;

async function ownerJwt() {
	await env.db.prepare(`
		INSERT OR IGNORE INTO perm (perm_id, name, perm_key, pid, type, sort)
		VALUES (?, 'share-manage', 'share:manage', 0, 2, 0)
	`).bind(SHARE_PERM_ID).run();
	await env.db.prepare(`
		INSERT OR IGNORE INTO role (role_id, name, send_type, is_default)
		VALUES (?, 'share-only', 'count', 0)
	`).bind(SHARE_ROLE_ID).run();
	const bound = await env.db.prepare('SELECT id FROM role_perm WHERE role_id = ? AND perm_id = ?')
		.bind(SHARE_ROLE_ID, SHARE_PERM_ID).first();
	if (!bound) {
		await env.db.prepare('INSERT INTO role_perm (role_id, perm_id) VALUES (?, ?)')
			.bind(SHARE_ROLE_ID, SHARE_PERM_ID).run();
	}
	await env.db.prepare('DELETE FROM user WHERE user_id = ? OR email = ?').bind(USER_A, OWNER_EMAIL).run();
	await env.db.prepare(`
		INSERT INTO user (user_id, email, type, password, salt, status, is_del)
		VALUES (?, ?, ?, 'x', 'x', 0, 0)
	`).bind(USER_A, OWNER_EMAIL, SHARE_ROLE_ID).run();
	const token = crypto.randomUUID();
	const jwt = await jwtUtils.generateToken({ env }, { userId: USER_A, token });
	await env.kv.put(KvConst.AUTH_INFO + USER_A, JSON.stringify({
		tokens: [token],
		user: { userId: USER_A, email: OWNER_EMAIL },
		refreshTime: new Date().toISOString()
	}));
	return jwt;
}

async function putBindings(jwt, body) {
	const response = await SELF.fetch('http://example.com/api/mailShare/bindings', {
		method: 'PUT',
		headers: { Authorization: jwt, 'content-type': 'application/json', 'accept-language': 'en' },
		body: JSON.stringify(body)
	});
	return { status: response.status, json: await response.json() };
}

describe('mailShareService.updateBindings (T-13)', () => {
	it('adds an owned live mailbox and snapshots its own window (AC-BIND-02)', async () => {
		await seedOwners();
		await insertEmail(ACC_A, USER_A, 't09-bind-a1');
		await insertEmail(ACC_C, USER_A, 't09-bind-c1');
		const maxC = await insertEmail(ACC_C, USER_A, 't09-bind-c2');
		const share = await seedShareWithBindings([ACC_A]);

		const result = await mailShareService.updateBindings(v2ctx(), {
			shareId: share.shareId,
			add: [ACC_C]
		}, USER_A);

		const rows = await listBindings(share.shareId);
		expect(rows.map((row) => [row.account_id, row.window_start_email_id])).toEqual([
			[ACC_A, 0],
			[ACC_C, maxC]
		]);
		expect(result.shareType).toBe('multi');
		expect(result.bindings).toEqual(rows.map((row) => ({ bindingId: row.binding_id, accountId: row.account_id })));
	});

	it('snapshots the new binding window at 0 when only_messages_after_created is false (AC-BIND-02)', async () => {
		await seedOwners();
		await insertEmail(ACC_C, USER_A, 't09-bind-zero');
		const share = await seedShareWithBindings([ACC_A], { onlyMessagesAfterCreated: 0 });

		await mailShareService.updateBindings(v2ctx(), { shareId: share.shareId, add: [ACC_C] }, USER_A);

		const rows = await listBindings(share.shareId);
		expect(rows.map((row) => row.window_start_email_id)).toEqual([0, 0]);
	});

	it('refuses the add with zero residue when the account dies after the precheck (AC-BIND-10)', async () => {
		await seedOwners();
		const share = await seedShareWithBindings([ACC_A]);

		const message = await catchBiz(mailShareService.updateBindings({
			env: shareEnv({ db: killAccountOnBatch(ACC_C), SHARE_CAPABILITY_V2: 'true' })
		}, { shareId: share.shareId, add: [ACC_C] }, USER_A));

		expect(message).toBe('SHARE_ACCOUNT_FORBIDDEN');
		expect(await bindingAccountIds(share.shareId)).toEqual([ACC_A]);
		expect((await readShareRow(share.shareId)).status).toBe('ACTIVE');
	});

	// 这两条直击 batch 的语义边界：D1 只在语句报错时回滚，0 行 INSERT 会就地提交，
	// 所以 add 必须自己「全有或全无」，remove 必须看得见 add 的结果才敢删。
	it('inserts every add or none when one of them dies after the precheck (AC-BIND-10)', async () => {
		await seedOwners();
		await ensureAccount({ accountId: ACC_D, email: MAIL_D, userId: USER_A });
		const share = await seedShareWithBindings([ACC_A]);

		const message = await catchBiz(mailShareService.updateBindings({
			env: shareEnv({ db: killAccountOnBatch(ACC_D), SHARE_CAPABILITY_V2: 'true' })
		}, { shareId: share.shareId, add: [ACC_C, ACC_D] }, USER_A));

		expect(message).toBe('SHARE_ACCOUNT_FORBIDDEN');
		expect(await bindingAccountIds(share.shareId)).toEqual([ACC_A]);
	});

	it('does not commit the remove when the add is emptied by a concurrent delete (AC-BIND-12)', async () => {
		await seedOwners();
		await ensureAccount({ accountId: ACC_D, email: MAIL_D, userId: USER_A });
		const share = await seedShareWithBindings([ACC_A, ACC_C]);

		const message = await catchBiz(mailShareService.updateBindings({
			env: shareEnv({ db: killAccountOnBatch(ACC_D), SHARE_CAPABILITY_V2: 'true' })
		}, { shareId: share.shareId, add: [ACC_D], remove: [share.bindingIds[0]] }, USER_A));

		expect(message).toBe('SHARE_ACCOUNT_FORBIDDEN');
		expect(await bindingAccountIds(share.shareId)).toEqual([ACC_A, ACC_C]);
		expect((await readShareRow(share.shareId)).status).toBe('ACTIVE');
	});

	it('rejects an add that belongs to another owner (AC-BIND-10)', async () => {
		await seedOwners();
		const share = await seedShareWithBindings([ACC_A]);

		const message = await catchBiz(mailShareService.updateBindings(v2ctx(), {
			shareId: share.shareId,
			add: [ACC_B]
		}, USER_A));

		expect(message).toBe('SHARE_ACCOUNT_FORBIDDEN');
		expect(await bindingAccountIds(share.shareId)).toEqual([ACC_A]);
	});

	it('rejects a malformed accountId in add (AC-BIND-10)', async () => {
		await seedOwners();
		const share = await seedShareWithBindings([ACC_A]);

		for (const add of [[0], [-1], [1.5], [null], [Infinity], [ACC_C, 0]]) {
			expect(await catchBiz(mailShareService.updateBindings(v2ctx(), {
				shareId: share.shareId,
				add
			}, USER_A))).toBe('SHARE_ACCOUNT_FORBIDDEN');
		}
		expect(await bindingAccountIds(share.shareId)).toEqual([ACC_A]);
	});

	it('rejects adding a mailbox the share already binds (AC-BIND-07)', async () => {
		await seedOwners();
		const share = await seedShareWithBindings([ACC_A, ACC_C]);

		const message = await catchBiz(mailShareService.updateBindings(v2ctx(), {
			shareId: share.shareId,
			add: [ACC_C]
		}, USER_A));

		expect(message).toBe('SHARE_BINDING_DUPLICATE');
		expect(await bindingAccountIds(share.shareId)).toEqual([ACC_A, ACC_C]);
	});

	it('removes a binding located by binding_id + share_id + owner (AC-BIND-03)', async () => {
		await seedOwners();
		const share = await seedShareWithBindings([ACC_A, ACC_C]);

		const result = await mailShareService.updateBindings(ctx(), {
			shareId: share.shareId,
			remove: [share.bindingIds[1]]
		}, USER_A);

		expect(await bindingAccountIds(share.shareId)).toEqual([ACC_A]);
		expect(result.shareType).toBe('single');
		expect(result.status).toBe('ACTIVE');
		expect((await readShareRow(share.shareId)).status).toBe('ACTIVE');
	});

	it('refuses the whole command when a bindingId belongs to another share (AC-BIND-12)', async () => {
		await seedOwners();
		const mine = await seedShareWithBindings([ACC_A]);
		const other = await seedShareWithBindings([ACC_C]);

		const message = await catchBiz(mailShareService.updateBindings(ctx(), {
			shareId: mine.shareId,
			remove: [mine.bindingIds[0], other.bindingIds[0]]
		}, USER_A));

		expect(message).toBe('SHARE_BINDING_FORBIDDEN');
		expect(await bindingAccountIds(mine.shareId)).toEqual([ACC_A]);
		expect(await bindingAccountIds(other.shareId)).toEqual([ACC_C]);
	});

	// 他人 Binding 与根本不存在的 Binding 必须返回同一个错误码，否则错误码本身就是存在性探针。
	it('does not distinguish another owner binding from an unknown one (AC-BIND-12)', async () => {
		await seedOwners();
		const mine = await seedShareWithBindings([ACC_A]);
		const theirs = await seedShareRow({ userId: USER_B, accountId: ACC_B });
		const theirBinding = await seedBindingRow({ shareId: theirs.shareId, accountId: ACC_B });

		const foreign = await catchBiz(mailShareService.updateBindings(ctx(), {
			shareId: mine.shareId,
			remove: [theirBinding]
		}, USER_A));
		const unknown = await catchBiz(mailShareService.updateBindings(ctx(), {
			shareId: mine.shareId,
			remove: [88880000]
		}, USER_A));

		expect(foreign).toBe('SHARE_BINDING_FORBIDDEN');
		expect(unknown).toBe(foreign);
		expect(await bindingAccountIds(mine.shareId)).toEqual([ACC_A]);
		expect(await bindingAccountIds(theirs.shareId)).toEqual([ACC_B]);
	});

	it('rolls the add back when one removed bindingId is invalid (AC-BIND-12)', async () => {
		await seedOwners();
		const mine = await seedShareWithBindings([ACC_A]);
		const other = await seedShareWithBindings([ACC_C]);

		const message = await catchBiz(mailShareService.updateBindings(v2ctx(), {
			shareId: mine.shareId,
			add: [ACC_C],
			remove: [other.bindingIds[0]]
		}, USER_A));

		expect(message).toBe('SHARE_BINDING_FORBIDDEN');
		expect(await bindingAccountIds(mine.shareId)).toEqual([ACC_A]);
		expect(await bindingAccountIds(other.shareId)).toEqual([ACC_C]);
	});

	it('revokes the share when the last binding is removed (AC-BIND-04)', async () => {
		await seedOwners();
		const share = await seedShareWithBindings([ACC_A]);

		const result = await mailShareService.updateBindings(ctx(), {
			shareId: share.shareId,
			remove: share.bindingIds
		}, USER_A);

		expect(result.bindings).toEqual([]);
		expect(result.status).toBe('REVOKED');
		const row = await readShareRow(share.shareId);
		expect(row.status).toBe('REVOKED');
		expect(row.revoked_at).toEqual(expect.any(String));
		// 主表 account_id 是 NOT NULL 且禁止写 0：没有 Binding 可跟随时停在旧值（AC-LIFE-10）。
		expect(row.account_id).toBe(ACC_A);
	});

	it('keeps the share ACTIVE while any binding survives (AC-BIND-04)', async () => {
		await seedOwners();
		const share = await seedShareWithBindings([ACC_A, ACC_C]);

		await mailShareService.updateBindings(ctx(), {
			shareId: share.shareId,
			remove: [share.bindingIds[0]]
		}, USER_A);

		const row = await readShareRow(share.shareId);
		expect(row.status).toBe('ACTIVE');
		expect(row.revoked_at == null).toBe(true);
	});

	it('dual-writes the primary account_id and window onto the main row (AC-LIFE-10)', async () => {
		await seedOwners();
		const maxA = await insertEmail(ACC_A, USER_A, 't09-primary-follow');
		const share = await seedShareWithBindings([ACC_C]);

		await mailShareService.updateBindings(v2ctx(), { shareId: share.shareId, add: [ACC_A] }, USER_A);
		expect(await readPrimaryAccountId(share.shareId)).toBe(ACC_C);

		await mailShareService.updateBindings(ctx(), {
			shareId: share.shareId,
			remove: [share.bindingIds[0]]
		}, USER_A);

		const row = await readShareRow(share.shareId);
		expect(row.account_id).toBe(ACC_A);
		expect(row.window_start_email_id).toBe(maxA);
	});

	it('rejects a 1 to N expansion while SHARE_CAPABILITY_V2 is off (AC-LIFE-11)', async () => {
		await seedOwners();
		const share = await seedShareWithBindings([ACC_A]);

		const message = await catchBiz(mailShareService.updateBindings(ctx(), {
			shareId: share.shareId,
			add: [ACC_C]
		}, USER_A));

		expect(message).toBe('SHARE_CAPABILITY_NOT_ENABLED');
		expect(await bindingAccountIds(share.shareId)).toEqual([ACC_A]);
	});

	it('needs no capability fence to shrink or hold the binding count (AC-LIFE-11)', async () => {
		await seedOwners();
		const share = await seedShareWithBindings([ACC_A, ACC_C]);

		const result = await mailShareService.updateBindings(ctx(), {
			shareId: share.shareId,
			remove: [share.bindingIds[1]]
		}, USER_A);

		expect(result.bindings.map((binding) => binding.accountId)).toEqual([ACC_A]);
	});

	it('rejects the command when the projected count passes SHARE_BINDING_LIMIT (AC-CAP-13)', async () => {
		await seedOwners();
		const filler = Array.from({ length: SHARE_BINDING_LIMIT - 1 }, (_unused, index) => 991000 + index);
		const share = await seedShareWithBindings([ACC_A, ...filler]);

		const message = await catchBiz(mailShareService.updateBindings(v2ctx(), {
			shareId: share.shareId,
			add: [ACC_C]
		}, USER_A));

		expect(message).toBe('SHARE_BINDING_LIMIT_EXCEEDED');
		expect((await listBindings(share.shareId))).toHaveLength(SHARE_BINDING_LIMIT);
	});

	// 上限看的是变更后的投影数，不是变更前的现存数：满仓时「删一个加一个」仍然合法。
	it('measures the cap against the projected count, not the current one (AC-CAP-13)', async () => {
		await seedOwners();
		const filler = Array.from({ length: SHARE_BINDING_LIMIT - 1 }, (_unused, index) => 992000 + index);
		const share = await seedShareWithBindings([ACC_A, ...filler]);

		const result = await mailShareService.updateBindings(v2ctx(), {
			shareId: share.shareId,
			add: [ACC_C],
			remove: [share.bindingIds[0]]
		}, USER_A);

		expect(result.bindings).toHaveLength(SHARE_BINDING_LIMIT);
		expect(result.bindings.some((binding) => binding.accountId === ACC_C)).toBe(true);
		expect(result.bindings.some((binding) => binding.accountId === ACC_A)).toBe(false);
	});

	// P-BIND-02：命令返回的集合就是库里的集合，Visitor 下一次读不需要等任何缓存过期。
	it('returns exactly the set an immediate reload sees (P-BIND-02, AC-BIND-08)', async () => {
		await seedOwners();
		const share = await seedShareWithBindings([ACC_C]);

		const applied = await mailShareService.updateBindings(v2ctx(), {
			shareId: share.shareId,
			add: [ACC_A],
			remove: [share.bindingIds[0]]
		}, USER_A);

		const reloaded = await listBindings(share.shareId);
		expect(applied.bindings).toEqual(reloaded.map((row) => ({
			bindingId: row.binding_id,
			accountId: row.account_id
		})));
		expect(applied.bindings.map((binding) => binding.accountId)).toEqual([ACC_A]);
	});

	it('hides shares that are missing, owned by someone else, revoked or expired (AC-MGMT-07)', async () => {
		await seedOwners();
		const theirs = await seedShareWithBindings([ACC_C], { userId: USER_B });
		const revoked = await seedShareWithBindings([ACC_A], { status: 'REVOKED', revokedAt: '2001-01-01 00:00:00' });
		const expired = await seedShareWithBindings([ACC_A], { expiresAt: '2001-01-01 00:00:00' });

		for (const shareId of [88881111, theirs.shareId, revoked.shareId, expired.shareId]) {
			expect(await catchBiz(mailShareService.updateBindings(ctx(), {
				shareId,
				remove: [1]
			}, USER_A))).toBe('SHARE_NOT_FOUND');
		}
		expect(await bindingAccountIds(theirs.shareId)).toEqual([ACC_C]);
		expect(await bindingAccountIds(revoked.shareId)).toEqual([ACC_A]);
		expect(await bindingAccountIds(expired.shareId)).toEqual([ACC_A]);
	});

	// 一个 batch = 一次提交：D1 没有 BEGIN，跨 batch 的第二条语句失败就再也回不去了。
	// Binding INSERT 只有一套方言：create 与 bindings 两个写入口必须落到同一条 SQL 文本。
	it('commits every mutation in one batch and reuses the create binding INSERT (AC-BIND-12)', async () => {
		await seedOwners();
		const share = await seedShareWithBindings([ACC_A]);
		const probe = batchProbe();

		await mailShareService.updateBindings({
			env: shareEnv({ db: probe.db, SHARE_CAPABILITY_V2: 'true' })
		}, { shareId: share.shareId, add: [ACC_C], remove: [share.bindingIds[0]] }, USER_A);

		expect(probe.batchCount()).toBe(1);
		const bindingInserts = probe.seen.filter((sql) => /INSERT\s+INTO\s+mail_share_binding/i.test(sql));
		expect(bindingInserts).toHaveLength(1);

		const createProbe = batchProbe();
		await mailShareService.create({ env: shareEnv({ db: createProbe.db }) }, createParams(), USER_A);
		const createInsert = createProbe.seen.find((sql) => /INSERT\s+INTO\s+mail_share_binding/i.test(sql));
		expect(bindingInserts[0]).toBe(createInsert);
	});

	// ── P0-1：预读快照必须进写入侧，否则并发替换能提交出第三种集合 ──────────────
	// V2=false 下两条命令各自算出 projected=1，栅栏都不触发。任何合法串行次序的终态
	// 只能是 {C} 或 {D}；缺了写入侧快照，第二批的 INSERT 会成功、DELETE 落 0 行却被
	// 当成成功，终态变成 {C,D} —— 一个 V2=false 根本不允许存在的 multi 分享。
	it('lets only one of two concurrent replacements win (AC-BIND-12, AC-LIFE-11)', async () => {
		await seedOwners();
		await ensureAccount({ accountId: ACC_D, email: MAIL_D, userId: USER_A });
		const share = await seedShareWithBindings([ACC_A]);

		const settled = await Promise.allSettled([
			mailShareService.updateBindings(ctx(), {
				shareId: share.shareId, add: [ACC_C], remove: [share.bindingIds[0]]
			}, USER_A),
			mailShareService.updateBindings(ctx(), {
				shareId: share.shareId, add: [ACC_D], remove: [share.bindingIds[0]]
			}, USER_A)
		]);

		const won = settled.filter((outcome) => outcome.status === 'fulfilled');
		expect(won).toHaveLength(1);
		expect(settled.filter((outcome) => outcome.status === 'rejected')
			.map((outcome) => outcome.reason.message)).toEqual(['SHARE_BINDING_CONFLICT']);

		const rows = await listBindings(share.shareId);
		expect(rows).toHaveLength(1);
		expect([ACC_C, ACC_D]).toContain(rows[0].account_id);
		expect(won[0].value.shareType).toBe('single');
		const row = await readShareRow(share.shareId);
		expect(row.status).toBe('ACTIVE');
		expect(row.account_id).toBe(rows[0].account_id);
	});

	it('cannot let two concurrent adds push the count past SHARE_BINDING_LIMIT (AC-CAP-13)', async () => {
		await seedOwners();
		await ensureAccount({ accountId: ACC_D, email: MAIL_D, userId: USER_A });
		const filler = Array.from({ length: SHARE_BINDING_LIMIT - 2 }, (_unused, index) => 993500 + index);
		const share = await seedShareWithBindings([ACC_A, ...filler]);

		const settled = await Promise.allSettled([
			mailShareService.updateBindings(v2ctx(), { shareId: share.shareId, add: [ACC_C] }, USER_A),
			mailShareService.updateBindings(v2ctx(), { shareId: share.shareId, add: [ACC_D] }, USER_A)
		]);

		expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
		expect(settled.filter((outcome) => outcome.status === 'rejected')
			.map((outcome) => outcome.reason.message)).toEqual(['SHARE_BINDING_CONFLICT']);
		expect(await listBindings(share.shareId)).toHaveLength(SHARE_BINDING_LIMIT);
	});

	it('refuses a remove whose pre-read set gained a binding, with zero residue (AC-BIND-12)', async () => {
		await seedOwners();
		const share = await seedShareWithBindings([ACC_A, ACC_C]);

		const message = await catchBiz(mailShareService.updateBindings({
			env: shareEnv({
				db: driftBindingsOnBatch(() => seedBindingRow({ shareId: share.shareId, accountId: 993999 }))
			})
		}, { shareId: share.shareId, remove: [share.bindingIds[0]] }, USER_A));

		expect(message).toBe('SHARE_BINDING_CONFLICT');
		expect(await bindingAccountIds(share.shareId)).toEqual([ACC_A, ACC_C, 993999]);
		expect((await readShareRow(share.shareId)).status).toBe('ACTIVE');
	});

	it('refuses a remove whose pre-read set lost a binding, with zero residue (AC-BIND-12)', async () => {
		await seedOwners();
		const share = await seedShareWithBindings([ACC_A, ACC_C]);

		const message = await catchBiz(mailShareService.updateBindings({
			env: shareEnv({
				db: driftBindingsOnBatch(() => env.db.prepare('DELETE FROM mail_share_binding WHERE binding_id = ?')
					.bind(share.bindingIds[1]).run())
			})
		}, { shareId: share.shareId, remove: [share.bindingIds[0]] }, USER_A));

		expect(message).toBe('SHARE_BINDING_CONFLICT');
		expect(await bindingAccountIds(share.shareId)).toEqual([ACC_A]);
	});

	// 一条命令删多个 Binding：集合谓词必须按 DELETE 之前的状态求值一次，
	// 逐行重算会让第二行起全部落空，变成半提交。
	it('removes several bindings in one command (AC-BIND-12)', async () => {
		await seedOwners();
		await ensureAccount({ accountId: ACC_D, email: MAIL_D, userId: USER_A });
		const share = await seedShareWithBindings([ACC_A, ACC_C, ACC_D]);

		const result = await mailShareService.updateBindings(ctx(), {
			shareId: share.shareId,
			remove: [share.bindingIds[0], share.bindingIds[1]]
		}, USER_A);

		expect(result.bindings.map((binding) => binding.accountId)).toEqual([ACC_D]);
		expect(await bindingAccountIds(share.shareId)).toEqual([ACC_D]);
	});

	it('serves PUT /mailShare/bindings over HTTP for the owner', async () => {
		await seedOwners();
		const jwt = await ownerJwt();
		const share = await seedShareWithBindings([ACC_A, ACC_C]);

		const ok = await putBindings(jwt, { shareId: share.shareId, remove: [share.bindingIds[1]] });
		expect(ok.json.code).toBe(200);
		expect(ok.json.data.shareType).toBe('single');
		expect(ok.json.data.bindings.map((binding) => binding.accountId)).toEqual([ACC_A]);

		const forbidden = await putBindings(jwt, { shareId: share.shareId, remove: [88882222] });
		expect(forbidden.json.message).toBe('SHARE_BINDING_FORBIDDEN');
		expect(await bindingAccountIds(share.shareId)).toEqual([ACC_A]);
	});
});

// ── P1-1 · D1 每条语句最多 100 个绑定参数 ─────────────────────────────────────
// SHARE_BINDING_LIMIT=50 是契约允许的合法上界，所以两个写入口在 N=50 时都必须过得去。
// 本地 miniflare 不强制这条生产限制，因此除了「跑得通」还要直接数占位符。
describe('D1 bound-parameter budget on the share write path (P1-1)', () => {
	it.each([48, SHARE_BINDING_LIMIT])('creates a share with %i real owned mailboxes', async (count) => {
		const accountIds = await seedOwnedAccounts(count);

		const created = await mailShareService.create(v2ctx(), { accountIds, durationSeconds: 3600 }, USER_A);

		expect(created.shareType).toBe('multi');
		expect(created.bindings.map((binding) => binding.accountId)).toEqual(accountIds);
		expect(await listBindings(created.shareId)).toHaveLength(count);
	});

	it('keeps every create statement under the limit at SHARE_BINDING_LIMIT', async () => {
		const accountIds = await seedOwnedAccounts(SHARE_BINDING_LIMIT);
		const probe = batchProbe();

		await mailShareService.create({
			env: shareEnv({ db: probe.db, SHARE_CAPABILITY_V2: 'true' })
		}, { accountIds, durationSeconds: 3600, idempotencyKey: 'bulk-cap' }, USER_A);

		expect(probe.seen.filter((sql) => bindSlots(sql) > D1_MAX_BOUND_PARAMS)).toEqual([]);
		const bindingInsert = probe.seen.find((sql) => /INSERT\s+INTO\s+mail_share_binding/i.test(sql));
		expect(bindSlots(bindingInsert)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
	});

	it('keeps the largest legal replacement under the limit', async () => {
		const accountIds = await seedOwnedAccounts(SHARE_BINDING_LIMIT * 2);
		const seated = accountIds.slice(0, SHARE_BINDING_LIMIT);
		const incoming = accountIds.slice(SHARE_BINDING_LIMIT);
		const share = await seedShareWithBindings(seated);
		const probe = batchProbe();

		const result = await mailShareService.updateBindings({
			env: shareEnv({ db: probe.db, SHARE_CAPABILITY_V2: 'true' })
		}, { shareId: share.shareId, add: incoming, remove: share.bindingIds }, USER_A);

		expect(result.bindings.map((binding) => binding.accountId)).toEqual(incoming);
		expect(probe.seen.filter((sql) => bindSlots(sql) > D1_MAX_BOUND_PARAMS)).toEqual([]);
	});
});

// ── T-15 · Owner API：get / update / delete + list 分页与新投影 ───────────────
// 分享行一律 seedShareRow + seedBindingRow 直接造：本任务要测的是「已存在的行被读 /
// 改 / 删」，create 的栅栏与幂等是另一个写入口的语义。

const LIST_DEPRECATED_CAP = 500;

function sqlTime(offsetSeconds = 0) {
	return new Date(Date.now() + offsetSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

// 四态各造一行，供 status 筛选与 effectiveStatus 投影两组用例共用。
async function seedFourStates() {
	const active = await seedShareRow({ userId: USER_A, accountId: ACC_A, name: 'st-active' });
	const expired = await seedShareRow({
		userId: USER_A, accountId: ACC_A, name: 'st-expired', expiresAt: '2001-01-01 00:00:00'
	});
	const revoked = await seedShareRow({
		userId: USER_A, accountId: ACC_A, name: 'st-revoked', status: 'REVOKED', revokedAt: sqlTime(-60)
	});
	const capped = await seedShareRow({
		userId: USER_A, accountId: ACC_A, name: 'st-capped', maxSessions: 2, accessCount: 2
	});
	return { active, expired, revoked, capped };
}

// 一条语句造 N 行：分页硬上限要 500+ 行才验得到，逐条 INSERT 会把用例拖成分钟级。
async function seedBulkShares(count, { userId = USER_A, accountId = ACC_A, prefix = 't15-bulk' } = {}) {
	await env.db.prepare(`
		WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
		INSERT INTO mail_share (lid, sec_hmac, pepper_kid, user_id, account_id, name, expires_at, delete_at)
		SELECT ? || '-' || n, 'x', 'v1', ?, ?, ? || '-' || n, ?, ?
		FROM seq
	`).bind(count, prefix, userId, accountId, prefix, sqlTime(3600), sqlTime(7200)).run();
}

async function seedIdempotencyRow(shareId, userId, key) {
	await env.db.prepare(`
		INSERT INTO share_idempotency (user_id, idempotency_key, operation, request_fingerprint, share_id, created_at)
		VALUES (?, ?, 'create', 'fp', ?, ?)
	`).bind(userId, key, shareId, sqlTime(0)).run();
}

async function countIdempotency(shareId) {
	const row = await env.db.prepare('SELECT COUNT(*) AS n FROM share_idempotency WHERE share_id = ?')
		.bind(shareId).first();
	return row.n;
}

async function countIdempotencyForUser(shareId, userId) {
	const row = await env.db.prepare(
		'SELECT COUNT(*) AS n FROM share_idempotency WHERE share_id = ? AND user_id = ?'
	).bind(shareId, userId).first();
	return row.n;
}

async function ownerApi(method, path, { jwt, body } = {}) {
	const headers = { Authorization: jwt, 'accept-language': 'en' };
	if (body !== undefined) {
		headers['content-type'] = 'application/json';
	}
	const response = await SELF.fetch(`http://example.com/api${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	return { status: response.status, json: await response.json() };
}

describe('mailShareService.get (T-15)', () => {
	it('returns the detail, the binding list and the full config for an owned share (AC-ADMIN-02)', async () => {
		await seedOwners();
		const share = await seedShareRow({
			userId: USER_A,
			accountId: ACC_A,
			name: 'desk',
			remark: 'front door',
			maxSessions: 7,
			messageLimit: 3,
			onlyMessagesAfterCreated: 0,
			otpExtractionEnabled: 0,
			autoRefresh: 0,
			refreshIntervalMs: 15000,
			showFullAddress: 1,
			accessCount: 2
		});
		const first = await seedBindingRow({ shareId: share.shareId, accountId: ACC_A });
		const second = await seedBindingRow({ shareId: share.shareId, accountId: ACC_C });

		const detail = await mailShareService.get(ctx(), { shareId: share.shareId }, USER_A);

		expect(detail).toMatchObject({
			shareId: share.shareId,
			lid: share.lid,
			userId: USER_A,
			mailbox: MAIL_A,
			name: 'desk',
			remark: 'front door',
			status: 'ACTIVE',
			effectiveStatus: 'ACTIVE',
			shareType: 'multi',
			maxSessions: 7,
			messageLimit: 3,
			usedSessions: 2,
			// T12：物理列名不改，`usedSessions` 是新增别名，两个键必须并存。
			accessCount: 2,
			onlyMessagesAfterCreated: false,
			otpExtractionEnabled: false,
			autoRefresh: false,
			refreshIntervalMs: 15000,
			showFullAddress: true,
			authKeyEnabled: false
		});
		expect(detail.bindings).toEqual([
			{ bindingId: first, accountId: ACC_A, mailbox: MAIL_A },
			{ bindingId: second, accountId: ACC_C, mailbox: MAIL_C }
		]);
	});

	it('still serves EXPIRED, REVOKED and ACCESS_LIMIT_REACHED rows for audit (AC-ADMIN-09)', async () => {
		await seedOwners();
		const states = await seedFourStates();

		const seen = {};
		for (const [key, row] of Object.entries(states)) {
			seen[key] = (await mailShareService.get(ctx(), { shareId: row.shareId }, USER_A)).effectiveStatus;
		}

		expect(seen).toEqual({
			active: 'ACTIVE',
			expired: 'EXPIRED',
			revoked: 'REVOKED',
			capped: 'ACCESS_LIMIT_REACHED'
		});
	});

	it('answers SHARE_NOT_FOUND for another owner, a missing row and a malformed id (AC-ADMIN-02)', async () => {
		await seedOwners();
		const theirs = await seedShareRow({ userId: USER_B, accountId: ACC_B });
		await seedBindingRow({ shareId: theirs.shareId, accountId: ACC_B });

		for (const shareId of [theirs.shareId, 88881111, 0, -1, 'abc', null, undefined, true]) {
			expect(await catchBiz(mailShareService.get(ctx(), { shareId }, USER_A))).toBe('SHARE_NOT_FOUND');
		}
	});

	it('never hands back a credential column (AC-SEC-09)', async () => {
		await seedOwners();
		const share = await seedShareRow({
			userId: USER_A,
			accountId: ACC_A,
			secHmac: 't15-secret-hmac-value',
			authKeyEnabled: 1,
			authKeyHash: 't15-secret-key-hash',
			authKeyKid: 'v9',
			credentialsVersion: 4
		});
		await seedBindingRow({ shareId: share.shareId, accountId: ACC_A });

		const detail = await mailShareService.get(ctx(), { shareId: share.shareId }, USER_A);
		const serialized = JSON.stringify(detail);

		expect(serialized).not.toContain('t15-secret-hmac-value');
		expect(serialized).not.toContain('t15-secret-key-hash');
		expect(Object.keys(detail)).not.toContain('secHmac');
		expect(Object.keys(detail)).not.toContain('authKeyHash');
		expect(Object.keys(detail)).not.toContain('authKeyKid');
		expect(Object.keys(detail)).not.toContain('pepperKid');
		// 前端 AuthKey 区只需要状态，不需要任何密钥物料。
		expect(detail.authKeyEnabled).toBe(true);
	});
});

describe('mailShareService.update (T-15)', () => {
	async function seedConfigured(overrides = {}) {
		const share = await seedShareRow({
			userId: USER_A,
			accountId: ACC_A,
			name: 'before',
			remark: 'note',
			maxSessions: 5,
			messageLimit: 3,
			onlyMessagesAfterCreated: 0,
			otpExtractionEnabled: 0,
			autoRefresh: 0,
			refreshIntervalMs: 15000,
			showFullAddress: 1,
			accessCount: 2,
			...overrides
		});
		await seedBindingRow({ shareId: share.shareId, accountId: ACC_A });
		return share;
	}

	it('writes only the keys present in the patch (AC-ADMIN-03)', async () => {
		await seedOwners();
		const share = await seedConfigured();

		await mailShareService.update(ctx(), { shareId: share.shareId, name: 'after' }, USER_A);

		// 缺席的键必须原样留下，不能回落 DDL 默认值（patch ≠ create 归一）。
		expect(await readShareRow(share.shareId)).toMatchObject({
			name: 'after',
			remark: 'note',
			max_sessions: 5,
			message_limit: 3,
			only_messages_after_created: 0,
			otp_extraction_enabled: 0,
			auto_refresh: 0,
			refresh_interval_ms: 15000,
			show_full_address: 1,
			access_count: 2
		});
	});

	it('accepts an empty patch as a no-op that returns the current detail', async () => {
		await seedOwners();
		const share = await seedConfigured();
		const before = await readShareRow(share.shareId);

		const detail = await mailShareService.update(ctx(), { shareId: share.shareId }, USER_A);

		expect(detail.shareId).toBe(share.shareId);
		expect(await readShareRow(share.shareId)).toEqual(before);
	});

	it('writes every whitelisted field (AC-ADMIN-03)', async () => {
		await seedOwners();
		const share = await seedConfigured();

		const detail = await mailShareService.update(v2ctx(), {
			shareId: share.shareId,
			name: 'renamed',
			remark: 'moved',
			maxSessions: 9,
			messageLimit: 4,
			otpExtractionEnabled: true,
			autoRefresh: true,
			refreshIntervalMs: 8000,
			showFullAddress: false
		}, USER_A);

		expect(await readShareRow(share.shareId)).toMatchObject({
			name: 'renamed',
			remark: 'moved',
			max_sessions: 9,
			message_limit: 4,
			otp_extraction_enabled: 1,
			auto_refresh: 1,
			refresh_interval_ms: 8000,
			show_full_address: 0
		});
		expect(detail).toMatchObject({
			name: 'renamed',
			maxSessions: 9,
			messageLimit: 4,
			otpExtractionEnabled: true,
			refreshIntervalMs: 8000,
			showFullAddress: false
		});
	});

	// T-22b-1b 起 `expiresAt` 是白名单里的合法字段(续期),所以它从这袋「劫持尝试」里
	// 移出、单独成组用例;`expires_at` 蛇形别名留在袋里 —— 白名单只认驼峰键,
	// 别名仍然必须是死路,否则等于给同一列开了第二个未校验入口。
	it('leaves lid, sec, expiry, AuthKey, cv and the binding-derived columns untouched (AC-AUTH-07)', async () => {
		await seedOwners();
		const share = await seedConfigured({
			authKeyEnabled: 1,
			authKeyHash: 't15-hash',
			authKeyKid: 'v9',
			credentialsVersion: 3,
			windowStartEmailId: 41
		});
		const before = await readShareRow(share.shareId);

		await mailShareService.update(ctx(), {
			shareId: share.shareId,
			name: 'renamed',
			lid: 'hijacked-lid',
			secHmac: 'hijacked',
			sec_hmac: 'hijacked',
			pepperKid: 'hijacked',
			expires_at: '2099-01-01 00:00:00',
			deleteAt: '2099-01-01 00:00:00',
			status: 'REVOKED',
			userId: USER_B,
			accountId: ACC_B,
			windowStartEmailId: 0,
			onlyMessagesAfterCreated: 1,
			authKeyEnabled: 0,
			authKeyHash: null,
			authKeyKid: null,
			credentialsVersion: 99,
			accessCount: 0
		}, USER_A);

		const after = await readShareRow(share.shareId);
		expect(after.name).toBe('renamed');
		for (const column of [
			'lid', 'sec_hmac', 'pepper_kid', 'expires_at', 'delete_at', 'status', 'user_id',
			'account_id', 'window_start_email_id', 'only_messages_after_created',
			'auth_key_enabled', 'auth_key_hash', 'auth_key_kid', 'credentials_version', 'access_count'
		]) {
			expect([column, after[column]]).toEqual([column, before[column]]);
		}
	});

	it('takes effect on the next visitor session (AC-ADMIN-03)', async () => {
		await seedOwners();
		// 走真实创建以拿到 sec 明文；pepper 必须与 Worker env 同源，否则 HTTP 侧验不过。
		const workerCtx = ctx({
			SHARE_SEC_PEPPER: env.SHARE_SEC_PEPPER,
			SHARE_SEC_PEPPER_KID: env.SHARE_SEC_PEPPER_KID
		});
		const created = await mailShareService.create(workerCtx, createParams(), USER_A);

		const before = await SELF.fetch('http://example.com/api/share/session', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'accept-language': 'en' },
			body: JSON.stringify({ lid: created.lid, sec: created.sec })
		}).then((response) => response.json());
		expect(before.data.config).toMatchObject({ refreshIntervalMs: 3000, otpExtractionEnabled: true });

		await mailShareService.update(ctx(), {
			shareId: created.shareId,
			refreshIntervalMs: 9000,
			otpExtractionEnabled: false,
			showFullAddress: true
		}, USER_A);

		const after = await SELF.fetch('http://example.com/api/share/session', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'accept-language': 'en' },
			body: JSON.stringify({ lid: created.lid, sec: created.sec })
		}).then((response) => response.json());
		expect(after.data.config).toMatchObject({ refreshIntervalMs: 9000, otpExtractionEnabled: false });
		expect(after.data.mailboxes[0].address).toBe(MAIL_A);
	});

	it('zeroes used sessions when max_sessions is first set from NULL (AC-EDGE-14)', async () => {
		await seedOwners();
		const share = await seedConfigured({ maxSessions: null, accessCount: 4 });

		const detail = await mailShareService.update(v2ctx(), { shareId: share.shareId, maxSessions: 3 }, USER_A);

		expect((await readShareRow(share.shareId)).access_count).toBe(0);
		expect(detail).toMatchObject({ usedSessions: 0, maxSessions: 3, effectiveStatus: 'ACTIVE' });
	});

	it('keeps the count when the owner explicitly opts out of the reset (AC-EDGE-14)', async () => {
		await seedOwners();
		const share = await seedConfigured({ maxSessions: null, accessCount: 4 });

		const detail = await mailShareService.update(v2ctx(), {
			shareId: share.shareId, maxSessions: 2, resetUsedSessions: false
		}, USER_A);

		expect((await readShareRow(share.shareId)).access_count).toBe(4);
		expect(detail.effectiveStatus).toBe('ACCESS_LIMIT_REACHED');
	});

	it('never re-zeroes the count once max_sessions is already finite (AC-EDGE-14)', async () => {
		await seedOwners();
		const share = await seedConfigured({ maxSessions: 5, accessCount: 3 });

		await mailShareService.update(v2ctx(), {
			shareId: share.shareId, maxSessions: 10, resetUsedSessions: true
		}, USER_A);

		expect((await readShareRow(share.shareId)).access_count).toBe(3);
	});

	it('accepts lowering max_sessions to at most used_sessions (AC-ADMIN-04)', async () => {
		await seedOwners();
		const share = await seedConfigured({ maxSessions: 10, accessCount: 7 });

		const detail = await mailShareService.update(v2ctx(), { shareId: share.shareId, maxSessions: 3 }, USER_A);

		expect(await readShareRow(share.shareId)).toMatchObject({ max_sessions: 3, access_count: 7 });
		expect(detail.effectiveStatus).toBe('ACCESS_LIMIT_REACHED');
	});

	it('clearing a quota is not a reset trigger and needs no capability flag (AC-LIFE-11)', async () => {
		await seedOwners();
		const share = await seedConfigured({ maxSessions: 5, messageLimit: 3, accessCount: 6 });

		const detail = await mailShareService.update(ctx(), {
			shareId: share.shareId, maxSessions: null, messageLimit: null
		}, USER_A);

		expect(await readShareRow(share.shareId)).toMatchObject({
			max_sessions: null, message_limit: null, access_count: 6
		});
		expect(detail.effectiveStatus).toBe('ACTIVE');
	});

	// exec-t12-note 第 5 条点名的后门：update 少接 MESSAGE_LIMIT 就是绕过栅栏写 message_limit。
	it('gates exactly the two finite-value writes the old Worker cannot run (AC-LIFE-11)', async () => {
		await seedOwners();
		const share = await seedConfigured({ maxSessions: null, messageLimit: null });

		expect(await catchBiz(mailShareService.update(ctx(), {
			shareId: share.shareId, maxSessions: 3
		}, USER_A))).toBe('SHARE_CAPABILITY_NOT_ENABLED');
		expect(await catchBiz(mailShareService.update(ctx(), {
			shareId: share.shareId, messageLimit: 3
		}, USER_A))).toBe('SHARE_CAPABILITY_NOT_ENABLED');
		expect(await readShareRow(share.shareId)).toMatchObject({ max_sessions: null, message_limit: null });

		// 白名单里其余六项与栅栏无关：V2=false 下必须照常落库。
		await mailShareService.update(ctx(), {
			shareId: share.shareId,
			name: 'ok',
			remark: 'ok',
			otpExtractionEnabled: true,
			autoRefresh: true,
			refreshIntervalMs: 5000,
			showFullAddress: true
		}, USER_A);
		expect(await readShareRow(share.shareId)).toMatchObject({ name: 'ok', refresh_interval_ms: 5000 });
	});

	it('rejects out-of-range values even with the capability flag on', async () => {
		await seedOwners();
		const share = await seedConfigured();

		for (const patch of [
			{ refreshIntervalMs: 2999 },
			{ refreshIntervalMs: 'fast' },
			{ maxSessions: 0 },
			{ maxSessions: -1 },
			{ maxSessions: true },
			{ messageLimit: 0 },
			{ messageLimit: 1.5 },
			{ otpExtractionEnabled: 2 },
			{ autoRefresh: 'yes' },
			{ showFullAddress: null }
		]) {
			expect(await catchBiz(mailShareService.update(v2ctx(), {
				shareId: share.shareId, ...patch
			}, USER_A))).toBe('SHARE_INVALID_CONFIG');
		}
		expect(await readShareRow(share.shareId)).toMatchObject({
			refresh_interval_ms: 15000, max_sessions: 5, message_limit: 3, otp_extraction_enabled: 0
		});
	});

	it('refuses another owner, a revoked row and an expired row alike (AC-MGMT-07)', async () => {
		await seedOwners();
		const theirs = await seedShareRow({ userId: USER_B, accountId: ACC_B, name: 'theirs' });
		const revoked = await seedShareRow({ userId: USER_A, accountId: ACC_A, status: 'REVOKED' });
		const expired = await seedShareRow({
			userId: USER_A, accountId: ACC_A, expiresAt: '2001-01-01 00:00:00'
		});

		for (const shareId of [theirs.shareId, revoked.shareId, expired.shareId, 88881111, 'abc']) {
			expect(await catchBiz(mailShareService.update(ctx(), {
				shareId, name: 'hijack'
			}, USER_A))).toBe('SHARE_NOT_FOUND');
		}
		expect((await readShareRow(theirs.shareId)).name).toBe('theirs');
	});

	// ── T-22b-1b 续期 ────────────────────────────────────────────────────────
	// 全部用例走 `ctx()` 而不是 `v2ctx()`:`expires_at` 是 v1 就有的列,旧 Worker 认得,
	// 不该落在 AC-LIFE-11 栅栏后面 —— 当前生产 `SHARE_CAPABILITY_V2` 就是关的,
	// 续期在那里必须可用,否则「不必删掉重建」这个目标在生产上根本不成立。
	const DAY = 24 * 3600;

	// 夹具的 `SHARE_MAX_DURATION_SECONDS='86400'` 会把续期窗口压到 1 天,
	// 「上限从 create_time 起算」这条判据就没有观测空间了。续期用例统一取
	// 「运维没配上限」的生产形态 = 兜底 90 天。
	function renewCtx(overrides = {}) {
		return ctx({ SHARE_MAX_DURATION_SECONDS: undefined, ...overrides });
	}

	it('extends expires_at and carries delete_at along, leaving credentials untouched (T-22b-1b)', async () => {
		await seedOwners();
		const share = await seedConfigured();
		const before = await readShareRow(share.shareId);
		const target = sqlTime(30 * DAY);

		const detail = await mailShareService.update(renewCtx({ SHARE_RETENTION_SECONDS: '3600' }), {
			shareId: share.shareId, expiresAt: target
		}, USER_A);

		const after = await readShareRow(share.shareId);
		expect(after.expires_at).toBe(target);
		expect(detail.expiresAt).toBe(target);
		// delete_at 必须同步顺延,否则续期后的分享还没到期就被清理任务删掉。
		expect(utcTextToMs(after.delete_at) - utcTextToMs(after.expires_at)).toBe(3600000);
		// 链接不变、在看的访客不掉线 = 这四列一个都不许动。
		for (const column of ['lid', 'sec_hmac', 'pepper_kid', 'credentials_version', 'status', 'access_count']) {
			expect([column, after[column]]).toEqual([column, before[column]]);
		}
	});

	it('accepts the ISO form the API hands out and stores it canonically', async () => {
		await seedOwners();
		const share = await seedConfigured();
		const target = sqlTime(10 * DAY);

		await mailShareService.update(renewCtx(), {
			shareId: share.shareId, expiresAt: `${target.replace(' ', 'T')}Z`
		}, USER_A);

		expect((await readShareRow(share.shareId)).expires_at).toBe(target);
	});

	// 本项最容易写错的地方:上限从**创建时刻**起算。若按「续期时刻 + 90 天」算,
	// 每次快到期续一下就能把一条分享续成永久分享,I-2 形同虚设。
	it('measures the renewal ceiling from create_time, not from now (I-2)', async () => {
		await seedOwners();
		const createdAt = sqlTime(-80 * DAY);
		const share = await seedConfigured({ createTime: createdAt, expiresAt: sqlTime(3600) });

		expect(await catchBiz(mailShareService.update(renewCtx(), {
			shareId: share.shareId, expiresAt: sqlTime(30 * DAY)
		}, USER_A))).toBe('SHARE_DURATION_EXCEEDED');
		expect((await readShareRow(share.shareId)).expires_at).toBe(share.expiresAt);

		// 恰好落在 create_time + 90 天 上仍然允许:与 create 侧 `> maxDuration` 才拒同一口径。
		// 从 createdAt 精确推算而不是写 `sqlTime(10 * DAY)` —— 后者会随秒级时钟推进
		// 越过上限一秒,把这条判据变成偶发红。
		const atCeiling = new Date(utcTextToMs(createdAt) + 90 * DAY * 1000)
			.toISOString().replace('T', ' ').slice(0, 19);
		await mailShareService.update(renewCtx(), { shareId: share.shareId, expiresAt: atCeiling }, USER_A);
		expect((await readShareRow(share.shareId)).expires_at).toBe(atCeiling);
	});

	it('stops the second renewal once the ceiling from create_time is used up (I-2)', async () => {
		await seedOwners();
		const share = await seedConfigured({ createTime: sqlTime(0), expiresAt: sqlTime(3600) });

		await mailShareService.update(renewCtx(), {
			shareId: share.shareId, expiresAt: sqlTime(89 * DAY)
		}, USER_A);
		expect(await catchBiz(mailShareService.update(renewCtx(), {
			shareId: share.shareId, expiresAt: sqlTime(91 * DAY)
		}, USER_A))).toBe('SHARE_DURATION_EXCEEDED');
	});

	// 过期后原地复活是被规格明确禁止的(AC-LIFE-11 同类语义):EXPIRED / REVOKED 一律
	// 走 `loadMutableShare` 的状态门,与 resetAuthKey 同构,共用 SHARE_NOT_FOUND。
	it('refuses to resurrect an expired or revoked share by renewing it', async () => {
		await seedOwners();
		const expired = await seedConfigured({ expiresAt: '2001-01-01 00:00:00' });
		const revoked = await seedConfigured({ status: 'REVOKED' });

		for (const share of [expired, revoked]) {
			expect(await catchBiz(mailShareService.update(renewCtx(), {
				shareId: share.shareId, expiresAt: sqlTime(30 * DAY)
			}, USER_A))).toBe('SHARE_NOT_FOUND');
		}
		expect((await readShareRow(expired.shareId)).expires_at).toBe('2001-01-01 00:00:00');
		expect((await readShareRow(revoked.shareId)).status).toBe('REVOKED');
	});

	// 落在过去的到期时刻是一次不可逆的自锁:行立刻变 EXPIRED,而 EXPIRED 行连 update
	// 都进不来,管理员再也救不回来。想立即失效请用 revoke,那条路径有 revoked_at 与 cv。
	it('rejects a non-future or malformed expiresAt', async () => {
		await seedOwners();
		const share = await seedConfigured();
		const before = await readShareRow(share.shareId);

		for (const value of [
			sqlTime(-60), '2001-01-01 00:00:00', 'tomorrow', '', null, 42, {},
			'2026-13-45 00:00:00', '2099-01-01', '2099-01-01 10:00:00+08:00'
		]) {
			expect([value, await catchBiz(mailShareService.update(renewCtx(), {
				shareId: share.shareId, expiresAt: value
			}, USER_A))]).toEqual([value, 'SHARE_INVALID_CONFIG']);
		}
		expect(await readShareRow(share.shareId)).toEqual(before);
	});

	// 缩短允许:它与 revoke 同向(只收窄暴露面),而禁止它只会把管理员推回
	// 「删掉重建再重新分发一次」—— 恰是本轮要消灭的动作。
	it('allows shortening the window and pulls delete_at back with it', async () => {
		await seedOwners();
		const share = await seedConfigured({ expiresAt: sqlTime(30 * DAY), deleteAt: sqlTime(37 * DAY) });
		const target = sqlTime(2 * DAY);

		await mailShareService.update(renewCtx({ SHARE_RETENTION_SECONDS: '3600' }), {
			shareId: share.shareId, expiresAt: target
		}, USER_A);

		const after = await readShareRow(share.shareId);
		expect(after.expires_at).toBe(target);
		expect(utcTextToMs(after.delete_at) - utcTextToMs(target)).toBe(3600000);
	});

	it('renews together with the other whitelisted fields in one statement', async () => {
		await seedOwners();
		const share = await seedConfigured();
		const target = sqlTime(20 * DAY);
		const probe = batchProbe();

		await mailShareService.update({ env: shareEnv({ db: probe.db, SHARE_MAX_DURATION_SECONDS: undefined }) }, {
			shareId: share.shareId, name: 'renewed', expiresAt: target
		}, USER_A);

		expect(await readShareRow(share.shareId)).toMatchObject({ name: 'renewed', expires_at: target });
		const updates = probe.seen.filter((sql) => /UPDATE\s+mail_share\b/i.test(sql));
		expect(updates).toHaveLength(1);
		expect(updates[0]).toMatch(/delete_at\s*=\s*\?/i);
	});

	// 真跑一次的姿势:走真实 HTTP 入口,而且 `SELF.fetch` 打的是 workerd 自己那份 env ——
	// `wrangler-vitest.toml` 里没有 SHARE_MAX_DURATION_SECONDS,所以这条同时证明
	// 「运维没配上限的部署」上续期照样受兜底约束、且照常可用。
	// 最后一条断言是本任务的用户可见目标:续期前发出去的 session token,续期后仍然取得到信 ——
	// 「已经拿着链接在看的访客不受影响」。
	it('renews over the real HTTP route without dropping a live visitor (T-22b-1b)', async () => {
		await seedOwners();
		const jwt = await ownerJwt();
		const created = await mailShareService.create(workerCtx(), createParams(), USER_A);
		const established = await postSession({ lid: created.lid, sec: created.sec });
		expect(established.code).toBe(200);

		const target = sqlTime(60 * DAY);
		const renewed = await ownerApi('PUT', '/mailShare/update', {
			jwt, body: { shareId: created.shareId, expiresAt: target }
		});

		expect(renewed.json.code).toBe(200);
		expect(renewed.json.data.expiresAt).toBe(target);
		const row = await readShareRow(created.shareId);
		expect(row.lid).toBe(created.lid);
		expect(row.credentials_version).toBe(0);
		expect(utcTextToMs(row.delete_at)).toBeGreaterThan(utcTextToMs(target));
		expect((await getShareMails(established.data.sessionToken)).code).toBe(200);

		// 同一条路由上,超出兜底上限的续期仍然被拒 —— 上限不是只在 create 侧成立。
		const tooFar = await ownerApi('PUT', '/mailShare/update', {
			jwt, body: { shareId: created.shareId, expiresAt: sqlTime(91 * DAY) }
		});
		expect(tooFar.json.message).toBe('SHARE_DURATION_EXCEEDED');
		expect((await readShareRow(created.shareId)).expires_at).toBe(target);
	});

	// ── T-22b P0-2 · 续期写入的 CAS 守卫 ─────────────────────────────────────
	// 干扰必须精确钉在「预读之后、UPDATE 之前」那条缝上。拿 `Promise.all` 撞两条真命令
	// 撞不出这条缝:resetAuthKey 比 update 多几个 await(mint key + digest),它稳定地后写,
	// 那样测到的是一次完全合法的线性化,而不是 CAS 守卫 —— 守卫拆掉用例照样绿,取证为零。
	// 只拦第一条 `UPDATE mail_share`(就是 `prepareUpdate` 那条),随后放行,好让 update
	// 收尾的 `loadOwnerDetail` 与干扰方自己的写入照常走。
	function ctxStallingUpdate(interfere, overrides = {}) {
		let armed = true;
		const prepare = env.db.prepare.bind(env.db);
		const db = new Proxy(env.db, {
			get(target, prop) {
				if (prop !== 'prepare') {
					const value = target[prop];
					return typeof value === 'function' ? value.bind(target) : value;
				}
				return (sql) => {
					const statement = prepare(sql);
					if (!armed || !/UPDATE\s+mail_share\b/i.test(String(sql))) {
						return statement;
					}
					armed = false;
					return {
						bind: (...args) => {
							const bound = statement.bind(...args);
							return { run: async () => { await interfere(); return bound.run(); } };
						}
					};
				};
			}
		});
		return renewCtx({ db, ...overrides });
	}

	async function seedKeyedConfigured(overrides = {}) {
		return seedConfigured({
			authKeyEnabled: 1, authKeyHash: 't22b-old-hash', authKeyKid: 'v9', credentialsVersion: 3, ...overrides
		});
	}

	// 本项的用户可见目标:管理员点「延长有效期」的同时另一个管理员在重置访问密钥,续期
	// 不能假装无事发生地成功 —— 那等于把一次凭据轮换静默回滚成「密钥换了但旧会话仍按新到期时刻活着」。
	it('refuses the renewal when credentials rotate between the pre-read and the write (P0-2)', async () => {
		await seedOwners();
		const share = await seedKeyedConfigured();
		const stalled = ctxStallingUpdate(() => mailShareService.resetAuthKey(ctx(), {
			shareId: share.shareId, action: 'reset'
		}, USER_A));

		expect(await catchBiz(mailShareService.update(stalled, {
			shareId: share.shareId, expiresAt: sqlTime(30 * DAY)
		}, USER_A))).toBe('SHARE_UPDATE_CONFLICT');

		// 轮换赢了:cv 前进一格,到期时刻一秒没动。续期是零变更,不是「成功但被覆盖」。
		const after = await readShareRow(share.shareId);
		expect([after.credentials_version, after.expires_at]).toEqual([4, share.expiresAt]);
	});

	// 撤销这一路本来就被既有的 `status = 'ACTIVE'` 谓词挡住,CAS 两列都不是它的判据 ——
	// 所以拆掉 CAS 这条用例仍然绿。留着它是回归护栏(别哪天把活跃谓词一起"优化"掉),
	// 同时钉住错误码分流:行真的没了要报 NOT_FOUND,不能报成「重试就好」的 CONFLICT。
	it('refuses the renewal when the share is revoked between the pre-read and the write', async () => {
		await seedOwners();
		const share = await seedConfigured();
		const stalled = ctxStallingUpdate(() => mailShareService.revoke(ctx(), {
			shareId: share.shareId
		}, USER_A));

		expect(await catchBiz(mailShareService.update(stalled, {
			shareId: share.shareId, expiresAt: sqlTime(30 * DAY)
		}, USER_A))).toBe('SHARE_NOT_FOUND');

		const after = await readShareRow(share.shareId);
		expect([after.status, after.expires_at]).toEqual(['REVOKED', share.expiresAt]);
	});

	// 续期不动 cv,所以 cv 拦不住另一次续期 —— 这一条是 `expires_at` 那半个 CAS 的取证。
	// 没有它,两条命令各按各的旧快照判 create_time 上限,最终到期时刻由到达次序决定。
	it('lets exactly one of two concurrent renewals win, on the row and not by arrival order', async () => {
		await seedOwners();
		const share = await seedConfigured();
		const winner = sqlTime(20 * DAY);
		const loser = sqlTime(40 * DAY);
		const stalled = ctxStallingUpdate(() => mailShareService.update(renewCtx(), {
			shareId: share.shareId, expiresAt: winner
		}, USER_A));

		expect(await catchBiz(mailShareService.update(stalled, {
			shareId: share.shareId, expiresAt: loser
		}, USER_A))).toBe('SHARE_UPDATE_CONFLICT');

		// 后到的那条零变更:最终状态由「谁先落库」解释,而不是「谁最后写」。
		expect((await readShareRow(share.shareId)).expires_at).toBe(winner);
	});

	// `prepareUpdate` 是 `update` 的唯一写入语句,白名单九个字段共用它 —— CAS 一并作用到
	// 改名这类字段上是刻意的,不是溢出:它们同样先读后写,同样会盖掉期间的凭据轮换。
	it('applies the same guard to a non-renewal field on the shared statement (P0-2 blast radius)', async () => {
		await seedOwners();
		const share = await seedKeyedConfigured();
		const stalled = ctxStallingUpdate(() => mailShareService.resetAuthKey(ctx(), {
			shareId: share.shareId, action: 'disable'
		}, USER_A));

		expect(await catchBiz(mailShareService.update(stalled, {
			shareId: share.shareId, name: 'after'
		}, USER_A))).toBe('SHARE_UPDATE_CONFLICT');
		expect((await readShareRow(share.shareId)).name).toBe('before');
	});

	// 主路径不能被守卫修坏,且守卫必须在 WHERE 里而不是预读里 —— 与 resetAuthKey 的
	// R2-F1 取证同款:预读只决定错误码,WHERE 才决定并发下的正确性。
	it('keeps the plain renewal working and carries both CAS columns in the WHERE (P0-2)', async () => {
		await seedOwners();
		const share = await seedConfigured({ credentialsVersion: 3 });
		const target = sqlTime(30 * DAY);
		const probe = sqlProbe();

		await mailShareService.update({ env: shareEnv({ db: probe.db, SHARE_MAX_DURATION_SECONDS: undefined }) }, {
			shareId: share.shareId, expiresAt: target
		}, USER_A);

		expect((await readShareRow(share.shareId)).expires_at).toBe(target);
		const [, predicates] = probe.seen
			.find((sql) => /UPDATE\s+mail_share\b/i.test(sql))
			.split(/\bWHERE\b/i);
		expect(predicates).toMatch(/credentials_version\s*=\s*\?/i);
		expect(predicates).toMatch(/expires_at\s*=\s*\?/i);
	});
});

describe('mailShareService.delete (T-15)', () => {
	it('removes the share, its bindings and its idempotency rows in one batch (AC-ADMIN-07)', async () => {
		await seedOwners();
		const share = await seedShareWithBindings([ACC_A, ACC_C]);
		await seedIdempotencyRow(share.shareId, USER_A, 't15-del-key');
		const probe = batchProbe();

		const result = await mailShareService.delete({ env: shareEnv({ db: probe.db }) }, {
			shareId: share.shareId
		}, USER_A);

		expect(result.shareId).toBe(share.shareId);
		expect(probe.batchCount()).toBe(1);
		expect(await readShareRow(share.shareId)).toBe(null);
		expect(await listBindings(share.shareId)).toEqual([]);
		expect(await countIdempotency(share.shareId)).toBe(0);
	});

	it('deletes rows the revoke path can no longer touch', async () => {
		await seedOwners();
		const revoked = await seedShareWithBindings([ACC_A], { status: 'REVOKED', revokedAt: sqlTime(-60) });
		const expired = await seedShareWithBindings([ACC_C], { expiresAt: '2001-01-01 00:00:00' });

		await mailShareService.delete(ctx(), { shareId: revoked.shareId }, USER_A);
		await mailShareService.delete(ctx(), { shareId: expired.shareId }, USER_A);

		expect(await readShareRow(revoked.shareId)).toBe(null);
		expect(await readShareRow(expired.shareId)).toBe(null);
		expect(await listBindings(revoked.shareId)).toEqual([]);
		expect(await listBindings(expired.shareId)).toEqual([]);
	});

	it('leaves another owner rows completely alone (AC-MGMT-07)', async () => {
		await seedOwners();
		const theirs = await seedShareRow({ userId: USER_B, accountId: ACC_B });
		await seedBindingRow({ shareId: theirs.shareId, accountId: ACC_B });
		await seedIdempotencyRow(theirs.shareId, USER_B, 't15-their-key');

		expect(await catchBiz(mailShareService.delete(ctx(), { shareId: theirs.shareId }, USER_A)))
			.toBe('SHARE_NOT_FOUND');

		expect(await readShareRow(theirs.shareId)).not.toBe(null);
		expect(await listBindings(theirs.shareId)).toHaveLength(1);
		expect(await countIdempotency(theirs.shareId)).toBe(1);
	});

	it('does not delete a caller-owned idempotency row that only shares a foreign share_id', async () => {
		await seedOwners();
		const theirs = await seedShareRow({ userId: USER_B, accountId: ACC_B });
		await seedBindingRow({ shareId: theirs.shareId, accountId: ACC_B });
		await seedIdempotencyRow(theirs.shareId, USER_B, 't15-owner-key');
		await seedIdempotencyRow(theirs.shareId, USER_A, 't15-mismatched-key');

		expect(await catchBiz(mailShareService.delete(ctx(), { shareId: theirs.shareId }, USER_A)))
			.toBe('SHARE_NOT_FOUND');

		expect(await readShareRow(theirs.shareId)).not.toBe(null);
		expect(await listBindings(theirs.shareId)).toHaveLength(1);
		expect(await countIdempotency(theirs.shareId)).toBe(2);
		expect(await countIdempotencyForUser(theirs.shareId, USER_A)).toBe(1);
	});

	it('clears every idempotency row of an owned share even if the child user_id drifted', async () => {
		await seedOwners();
		const share = await seedShareWithBindings([ACC_A]);
		await seedIdempotencyRow(share.shareId, USER_A, 't15-own-key');
		await seedIdempotencyRow(share.shareId, USER_B, 't15-drift-key');

		await mailShareService.delete(ctx(), { shareId: share.shareId }, USER_A);

		expect(await countIdempotency(share.shareId)).toBe(0);
	});

	it('is not idempotent by accident: the second delete is SHARE_NOT_FOUND', async () => {
		await seedOwners();
		const share = await seedShareWithBindings([ACC_A]);

		await mailShareService.delete(ctx(), { shareId: share.shareId }, USER_A);

		for (const shareId of [share.shareId, 88881111, 0, 'abc']) {
			expect(await catchBiz(mailShareService.delete(ctx(), { shareId }, USER_A))).toBe('SHARE_NOT_FOUND');
		}
	});
});

describe('mailShareService.list paging and projection (T-15)', () => {
	it('carries shareType, four-state effectiveStatus, quota and binding summaries (AC-ADMIN-01)', async () => {
		await seedOwners();
		const share = await seedShareRow({
			userId: USER_A, accountId: ACC_A, name: 'listed', maxSessions: 9, messageLimit: 2, accessCount: 4
		});
		const first = await seedBindingRow({ shareId: share.shareId, accountId: ACC_A });
		const second = await seedBindingRow({ shareId: share.shareId, accountId: ACC_C });

		const listed = await mailShareService.list(ctx(), {}, USER_A);

		expect(listed.total).toBe(1);
		expect(listed.list[0]).toMatchObject({
			shareId: share.shareId,
			shareType: 'multi',
			effectiveStatus: 'ACTIVE',
			usedSessions: 4,
			accessCount: 4,
			maxSessions: 9,
			messageLimit: 2
		});
		expect(listed.list[0].bindings).toEqual([
			{ bindingId: first, accountId: ACC_A, mailbox: MAIL_A },
			{ bindingId: second, accountId: ACC_C, mailbox: MAIL_C }
		]);
	});

	// T2：投影不喂 maxSessions 时这条分支恒不可达，AC-ADMIN-04/09 会假绿。
	it('can actually reach ACCESS_LIMIT_REACHED in the list projection (AC-ADMIN-09)', async () => {
		await seedOwners();
		await seedFourStates();

		const listed = await mailShareService.list(ctx(), {}, USER_A);
		const byName = Object.fromEntries(listed.list.map((row) => [row.name, row.effectiveStatus]));

		expect(byName).toEqual({
			'st-active': 'ACTIVE',
			'st-expired': 'EXPIRED',
			'st-revoked': 'REVOKED',
			'st-capped': 'ACCESS_LIMIT_REACHED'
		});
		// 存储态仍只有两值（AC-LIFE-01）。
		expect(new Set(listed.list.map((row) => row.status))).toEqual(new Set(['ACTIVE', 'REVOKED']));
	});

	it('pages a status-only query with the default size instead of the deprecated dump (R1-F2)', async () => {
		await seedOwners();
		await seedBulkShares(25);

		const listed = await mailShareService.list(ctx(), { status: 'ACTIVE' }, USER_A);

		expect(listed).toMatchObject({ total: 25, page: 1, size: 20 });
		expect(listed.list).toHaveLength(20);
		expect(listed.deprecated).toBeUndefined();
	});

	it('filters on the computed state and counts with the same CASE (AC-ADMIN-01)', async () => {
		await seedOwners();
		await seedFourStates();
		await seedShareRow({ userId: USER_A, accountId: ACC_A, name: 'st-active-2' });

		for (const [status, names] of Object.entries({
			ACTIVE: ['st-active', 'st-active-2'],
			EXPIRED: ['st-expired'],
			REVOKED: ['st-revoked'],
			ACCESS_LIMIT_REACHED: ['st-capped']
		})) {
			const listed = await mailShareService.list(ctx(), { status }, USER_A);
			expect(listed.list.map((row) => row.name).sort()).toEqual([...names].sort());
			// total 走同一条 CASE，不是分页后的 list.length。
			expect(listed.total).toBe(names.length);
		}
		expect(await catchBiz(mailShareService.list(ctx(), { status: 'PENDING' }, USER_A)))
			.toBe('SHARE_INVALID_CONFIG');
	});

	it('pages with size 20 by default and a stable share_id DESC order (AC-ADMIN-01)', async () => {
		await seedOwners();
		await seedBulkShares(25);
		const all = await mailShareService.list(ctx(), {}, USER_A);
		const expected = all.list.map((row) => row.shareId);

		const firstPage = await mailShareService.list(ctx(), { page: 1 }, USER_A);
		const secondPage = await mailShareService.list(ctx(), { page: 2 }, USER_A);

		expect(firstPage).toMatchObject({ total: 25, page: 1, size: 20 });
		expect(firstPage.list).toHaveLength(20);
		expect(secondPage.list).toHaveLength(5);
		expect([...firstPage.list, ...secondPage.list].map((row) => row.shareId)).toEqual(expected);
		expect(expected).toEqual([...expected].sort((left, right) => right - left));
	});

	it('caps size at 100 and clamps polluted paging params instead of failing', async () => {
		await seedOwners();
		await seedBulkShares(3);

		const cases = [
			[{ size: 200 }, { page: 1, size: 100 }],
			[{ size: '100' }, { page: 1, size: 100 }],
			[{ size: 'abc' }, { page: 1, size: 20 }],
			[{ size: 0 }, { page: 1, size: 20 }],
			[{ size: -1 }, { page: 1, size: 20 }],
			[{ size: '1e3' }, { page: 1, size: 100 }],
			[{ size: 1.5 }, { page: 1, size: 20 }],
			[{ page: true, size: 5 }, { page: 1, size: 5 }],
			[{ page: '0', size: 5 }, { page: 1, size: 5 }],
			[{ page: '2', size: 2 }, { page: 2, size: 2 }]
		];
		for (const [params, expected] of cases) {
			const listed = await mailShareService.list(ctx(), params, USER_A);
			expect([params, { page: listed.page, size: listed.size }]).toEqual([params, expected]);
			expect(listed.total).toBe(3);
		}
	});

	it('keeps the no-arg dump deprecated and hard-capped at 500 rows (R1-F2)', async () => {
		await seedOwners();
		await seedBulkShares(LIST_DEPRECATED_CAP + 5);

		const dump = await mailShareService.list(ctx(), {}, USER_A);

		expect(dump.list).toHaveLength(LIST_DEPRECATED_CAP);
		expect(dump.total).toBe(LIST_DEPRECATED_CAP + 5);
		expect(dump.deprecated).toBe(true);
		expect(dump.page).toBeUndefined();
		// 老前端 `http.get('/mailShare/list')` 不带参数，形状不许改。
		expect(dump.list[0].shareId).toBeGreaterThan(dump.list[dump.list.length - 1].shareId);
	});

	it('does not let a multi-binding share eat extra page slots (T8)', async () => {
		await seedOwners();
		await ensureAccount({ accountId: ACC_D, email: MAIL_D, userId: USER_A });
		await seedShareWithBindings([ACC_A], { lid: 't15-slot-1' });
		await seedShareWithBindings([ACC_C], { lid: 't15-slot-2' });
		// 最后建的分享 share_id 最大，在 DESC 首页；它的 3 条 Binding 必须只占一个名额。
		const wide = await seedShareWithBindings([ACC_A, ACC_C, ACC_D], { lid: 't15-slot-wide' });

		const page = await mailShareService.list(ctx(), { page: 1, size: 2 }, USER_A);

		expect(page.list).toHaveLength(2);
		expect(page.total).toBe(3);
		const wideRow = page.list.find((row) => row.shareId === wide.shareId);
		expect(wideRow.bindings).toHaveLength(3);
		expect(wideRow.shareType).toBe('multi');
	});

	it('loads binding summaries through json_each and stays inside the D1 parameter budget (T9)', async () => {
		await seedOwners();
		await seedBulkShares(100);
		const probe = sqlProbe();

		const listed = await mailShareService.list({ env: shareEnv({ db: probe.db }) }, { size: 100 }, USER_A);

		expect(listed.list).toHaveLength(100);
		expect(probe.seen.some((sql) => /json_each/i.test(sql) && /mail_share_binding/i.test(sql))).toBe(true);
		expect(probe.seen.filter((sql) => bindSlots(sql) > D1_MAX_BOUND_PARAMS)).toEqual([]);
	});
});

describe('owner API surface for get / update / delete (T-15)', () => {
	it('serves the three new endpoints over HTTP for the owner', async () => {
		await seedOwners();
		const jwt = await ownerJwt();
		const share = await seedShareWithBindings([ACC_A, ACC_C]);

		const detail = await ownerApi('GET', `/mailShare/get?shareId=${share.shareId}`, { jwt });
		expect(detail.json.code).toBe(200);
		expect(detail.json.data).toMatchObject({ shareId: share.shareId, shareType: 'multi' });

		const updated = await ownerApi('PUT', '/mailShare/update', {
			jwt,
			body: { shareId: share.shareId, name: 'renamed', remark: 'via http' }
		});
		expect(updated.json.data).toMatchObject({ name: 'renamed', remark: 'via http' });

		const removed = await ownerApi('DELETE', `/mailShare/delete?shareId=${share.shareId}`, { jwt });
		expect(removed.json.data.shareId).toBe(share.shareId);

		const gone = await ownerApi('GET', `/mailShare/get?shareId=${share.shareId}`, { jwt });
		expect(gone.json.message).toBe('SHARE_NOT_FOUND');
		expect(await listBindings(share.shareId)).toEqual([]);
	});

	it('serves the paged list over HTTP without breaking the no-arg shape', async () => {
		await seedOwners();
		const jwt = await ownerJwt();
		await seedBulkShares(3);

		const paged = await ownerApi('GET', '/mailShare/list?page=1&size=2', { jwt });
		expect(paged.json.data).toMatchObject({ total: 3, page: 1, size: 2 });
		expect(paged.json.data.list).toHaveLength(2);

		const dump = await ownerApi('GET', '/mailShare/list', { jwt });
		expect(dump.json.data.total).toBe(3);
		expect(dump.json.data.list).toHaveLength(3);
	});
});

// ── T-16 · AuthKey 状态机（`POST /mailShare/resetAuthKey` 单入口）─────────────
// design.md:311-329 的迁移表就是这一节的断言表：源态 → 目标列值 → cv 增量 → 是否过栅栏。
// 分享行仍一律 seedShareRow 直接造：这里测的是「已存在的行被迁移」，create 的 AuthKey
// 首发语义（`:952-1003`）是另一个写入口，两处不得互相顶替。

const AUTH_KEY_COLUMNS = ['auth_key_enabled', 'auth_key_hash', 'auth_key_kid', 'credentials_version'];

function authKeyColumns(row) {
	return Object.fromEntries(AUTH_KEY_COLUMNS.map((column) => [column, row[column]]));
}

// design.md:327 的字段不变量，写成与实现无关的全表扫描：`enabled=1` IFF hash 与 kid 均非空。
// DDL 侧没有、也无法追加 CHECK（`init.js:48-51` 是纯 ALTER ADD COLUMN），所以「schema 侧」
// 只能靠这条断言表达。
async function countAuthKeyInvariantBreaks() {
	const row = await env.db.prepare(`
		SELECT COUNT(*) AS bad FROM mail_share
		WHERE (auth_key_enabled = 1) <> (auth_key_hash IS NOT NULL AND auth_key_kid IS NOT NULL)
	`).first();
	return row.bad;
}

// 种子 cv 刻意取 3 而不是 0：「enable 不变」与「reset/disable 恰 +1」才有可辨识的期望值。
async function seedKeyed(overrides = {}) {
	const share = await seedShareRow({
		userId: USER_A,
		accountId: ACC_A,
		authKeyEnabled: 1,
		authKeyHash: 't16-old-key-hash',
		authKeyKid: 'v9',
		credentialsVersion: 3,
		...overrides
	});
	await seedBindingRow({ shareId: share.shareId, accountId: ACC_A });
	return share;
}

async function seedKeyless(overrides = {}) {
	const share = await seedShareRow({
		userId: USER_A,
		accountId: ACC_A,
		credentialsVersion: 3,
		...overrides
	});
	await seedBindingRow({ shareId: share.shareId, accountId: ACC_A });
	return share;
}

// Visitor 闭环用的上下文：pepper / kid 必须取 Worker env 的那一份，否则 SELF.fetch 侧的
// matchSec / matchAuthKey 永远验不过。
function workerCtx(overrides = {}) {
	return ctx({
		SHARE_SEC_PEPPER: env.SHARE_SEC_PEPPER,
		SHARE_SEC_PEPPER_KID: env.SHARE_SEC_PEPPER_KID,
		...overrides
	});
}

async function postSession(body) {
	const response = await SELF.fetch('http://example.com/api/share/session', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'accept-language': 'en' },
		body: JSON.stringify(body)
	});
	return response.json();
}

// `SELF.fetch` 打的是 workerd 自己那份 env,测试侧改 `env` 它看不见;要在 HTTP 面临时放行
// 栅栏,就必须像 `share-integration.spec.js:82-89` 那样把同一个 `env` 对象直接喂给 worker。
async function ownerWorker(method, path, { jwt, body } = {}) {
	const headers = { Authorization: jwt, 'accept-language': 'en' };
	if (body !== undefined) {
		headers['content-type'] = 'application/json';
	}
	const response = await worker.fetch(new Request(`http://example.com/api${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body)
	}), env, {});
	return { status: response.status, json: await response.json() };
}

async function getShareMails(sessionToken) {
	const response = await SELF.fetch('http://example.com/api/share/mails', {
		headers: { Authorization: `Bearer ${sessionToken}`, 'accept-language': 'en' }
	});
	return response.json();
}

describe('mailShareService.resetAuthKey state machine (T-16)', () => {
	it('enable mints a 22-char key, stores only hash plus kid and leaves cv untouched (AC-AUTH-07)', async () => {
		await seedOwners();
		const share = await seedKeyless();

		const result = await mailShareService.resetAuthKey(v2ctx(), {
			shareId: share.shareId, action: 'enable'
		}, USER_A);

		expect(result.authKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(decodeBase64Url(result.authKey).length).toBe(16);

		const row = await readShareRow(share.shareId);
		expect(authKeyColumns(row)).toEqual({
			auth_key_enabled: 1,
			auth_key_hash: await shareAuthService.digestShareSecret(result.authKey, PEPPER),
			auth_key_kid: 'v2',
			credentials_version: 3
		});
		expect(Object.values(row)).not.toContain(result.authKey);

		// 出参是 loadOwnerDetail 的形状；cv / hash / kid 一个都不回。
		expect(result).toMatchObject({
			shareId: share.shareId, authKeyEnabled: true, effectiveStatus: 'ACTIVE', shareType: 'single'
		});
		expect(result.bindings).toHaveLength(1);
		for (const key of ['credentialsVersion', 'authKeyHash', 'authKeyKid', 'secHmac']) {
			expect([key, Object.keys(result).includes(key)]).toEqual([key, false]);
		}
		expect(await countAuthKeyInvariantBreaks()).toBe(0);
	});

	it('reset swaps hash and kid and bumps cv by exactly one (AC-ADMIN-05)', async () => {
		await seedOwners();
		const share = await seedKeyed();

		// 跑在 V2=false 上：reset 明确不受栅栏门控（design.md:307 只门控 enable），
		// 这条同时是「没误加门控」的取证。
		const result = await mailShareService.resetAuthKey(ctx(), {
			shareId: share.shareId, action: 'reset'
		}, USER_A);

		expect(result.authKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
		const row = await readShareRow(share.shareId);
		expect(authKeyColumns(row)).toEqual({
			auth_key_enabled: 1,
			auth_key_hash: await shareAuthService.digestShareSecret(result.authKey, PEPPER),
			auth_key_kid: 'v2',
			credentials_version: 4
		});
		expect(row.auth_key_hash).not.toBe('t16-old-key-hash');
		expect(result.authKeyEnabled).toBe(true);
		expect(await countAuthKeyInvariantBreaks()).toBe(0);
	});

	it('disable clears the key material, bumps cv and hands back no plaintext (AC-AUTH-08)', async () => {
		await seedOwners();
		const share = await seedKeyed();

		const result = await mailShareService.resetAuthKey(ctx(), {
			shareId: share.shareId, action: 'disable'
		}, USER_A);

		// 「没有这个键」而不是「空串」：与 firstCreateResponse:539-541 的条件挂载同款。
		expect('authKey' in result).toBe(false);
		expect(result.authKeyEnabled).toBe(false);
		expect(authKeyColumns(await readShareRow(share.shareId))).toEqual({
			auth_key_enabled: 0,
			auth_key_hash: null,
			auth_key_kid: null,
			credentials_version: 4
		});
		expect(await countAuthKeyInvariantBreaks()).toBe(0);
	});

	it('mints an independent secret on every migration', async () => {
		await seedOwners();
		const share = await seedKeyless();

		const minted = [
			(await mailShareService.resetAuthKey(v2ctx(), { shareId: share.shareId, action: 'enable' }, USER_A)).authKey,
			(await mailShareService.resetAuthKey(ctx(), { shareId: share.shareId, action: 'reset' }, USER_A)).authKey,
			(await mailShareService.resetAuthKey(ctx(), { shareId: share.shareId, action: 'reset' }, USER_A)).authKey
		];

		expect(new Set(minted).size).toBe(3);
		// enable +0、reset +1、reset +1。
		expect((await readShareRow(share.shareId)).credentials_version).toBe(5);
		expect(await countAuthKeyInvariantBreaks()).toBe(0);
	});

	it('writes the three key columns in one SET of one guarded UPDATE (R2-F1)', async () => {
		await seedOwners();
		const share = await seedKeyed();
		const probe = sqlProbe();

		await mailShareService.resetAuthKey({ env: shareEnv({ db: probe.db }) }, {
			shareId: share.shareId, action: 'reset'
		}, USER_A);

		const writes = probe.seen.filter((sql) => /UPDATE\s+mail_share/i.test(sql) && /auth_key_/i.test(sql));
		expect(writes).toHaveLength(1);
		const [assignments, predicates] = writes[0].split(/\bWHERE\b/i);
		for (const column of ['auth_key_enabled', 'auth_key_hash', 'auth_key_kid']) {
			expect([column, new RegExp(`${column}\\s*=\\s*\\?`).test(assignments)]).toEqual([column, true]);
		}
		expect(assignments).toMatch(/credentials_version\s*=\s*credentials_version\s*\+\s*\?/i);
		// 迁移守卫必须进 WHERE：预读只决定错误码，WHERE 才决定并发下的正确性。
		expect(predicates).toMatch(/auth_key_enabled\s*=\s*\?/i);
	});

	// 守卫必须进 WHERE 的取证：两条并发命令的预读都会看到 `enabled=1`，只有写入语句自身的
	// 谓词能让输的一方零变更。少了它，cv 会被 +2 —— 白白多杀一轮在飞 Session。
	it('lets exactly one of two concurrent disables win', async () => {
		await seedOwners();
		const share = await seedKeyed();

		const settled = await Promise.allSettled([
			mailShareService.resetAuthKey(ctx(), { shareId: share.shareId, action: 'disable' }, USER_A),
			mailShareService.resetAuthKey(ctx(), { shareId: share.shareId, action: 'disable' }, USER_A)
		]);

		expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
		// 输的一方拿到哪个码取决于它是在预读还是在 WHERE 上失配，两者都属「重读再决定」。
		expect(['SHARE_NOT_FOUND', 'SHARE_INVALID_CONFIG'])
			.toContain(settled.find((item) => item.status === 'rejected').reason.message);
		expect(authKeyColumns(await readShareRow(share.shareId))).toEqual({
			auth_key_enabled: 0, auth_key_hash: null, auth_key_kid: null, credentials_version: 4
		});
	});

	it('brings a row seeded in an illegal combination back to a legal one', async () => {
		await seedOwners();
		const share = await seedKeyed({ authKeyHash: null, authKeyKid: null });
		expect(await countAuthKeyInvariantBreaks()).toBe(1);

		await mailShareService.resetAuthKey(ctx(), { shareId: share.shareId, action: 'disable' }, USER_A);

		expect(await countAuthKeyInvariantBreaks()).toBe(0);
		expect(authKeyColumns(await readShareRow(share.shareId))).toEqual({
			auth_key_enabled: 0, auth_key_hash: null, auth_key_kid: null, credentials_version: 4
		});
	});

	it('rejects every action outside the closed enum and touches no column (T14)', async () => {
		await seedOwners();
		const share = await seedKeyed();
		const before = authKeyColumns(await readShareRow(share.shareId));

		// 归一化阶段一旦把非法值折成合法值，「静默打开 AuthKey」就再也认不出来了：
		// 不 toLowerCase、不 trim、不接受数组包装、不把缺省当 reset。
		const actions = [
			undefined, null, '', ' ', 'ENABLE', 'Reset', 'enable ', ' disable', 'rotate',
			true, 1, 0, {}, ['reset'], 'toString', 'constructor', '__proto__'
		];
		for (const action of actions) {
			const params = action === undefined ? { shareId: share.shareId } : { shareId: share.shareId, action };
			expect([action, await catchBiz(mailShareService.resetAuthKey(v2ctx(), params, USER_A))])
				.toEqual([action, 'SHARE_INVALID_CONFIG']);
		}
		expect(authKeyColumns(await readShareRow(share.shareId))).toEqual(before);
	});

	it('answers SHARE_NOT_FOUND for another owner, a missing row and a malformed id', async () => {
		await seedOwners();
		const theirs = await seedShareRow({
			userId: USER_B, accountId: ACC_B, authKeyEnabled: 1, authKeyHash: 't16-their-hash', authKeyKid: 'v9'
		});
		await seedBindingRow({ shareId: theirs.shareId, accountId: ACC_B });

		for (const shareId of [theirs.shareId, 88881111, 0, -1, 'abc', null, undefined, true]) {
			expect([shareId, await catchBiz(mailShareService.resetAuthKey(v2ctx(), {
				shareId, action: 'disable'
			}, USER_A))]).toEqual([shareId, 'SHARE_NOT_FOUND']);
		}
		expect(authKeyColumns(await readShareRow(theirs.shareId))).toEqual({
			auth_key_enabled: 1, auth_key_hash: 't16-their-hash', auth_key_kid: 'v9', credentials_version: 0
		});
	});

	it('refuses a revoked or an expired row and leaves its key material alone', async () => {
		await seedOwners();
		const revoked = await seedKeyed({ status: 'REVOKED', revokedAt: sqlTime(-60) });
		const expired = await seedKeyed({ expiresAt: '2001-01-01 00:00:00' });

		for (const share of [revoked, expired]) {
			expect(await catchBiz(mailShareService.resetAuthKey(ctx(), {
				shareId: share.shareId, action: 'reset'
			}, USER_A))).toBe('SHARE_NOT_FOUND');
			expect(authKeyColumns(await readShareRow(share.shareId))).toEqual({
				auth_key_enabled: 1, auth_key_hash: 't16-old-key-hash', auth_key_kid: 'v9', credentials_version: 3
			});
		}
	});

	it('gates enable and only enable behind SHARE_CAPABILITY_V2 (AC-LIFE-11)', async () => {
		await seedOwners();
		const off = await seedKeyless();
		const on = await seedKeyed();

		expect(await catchBiz(mailShareService.resetAuthKey(ctx(), {
			shareId: off.shareId, action: 'enable'
		}, USER_A))).toBe('SHARE_CAPABILITY_NOT_ENABLED');
		expect(authKeyColumns(await readShareRow(off.shareId))).toEqual({
			auth_key_enabled: 0, auth_key_hash: null, auth_key_kid: null, credentials_version: 3
		});

		// 同一个 V2=false 上下文里 reset / disable 必须放行：AC-LIFE-10 路径③ 要求 Owner 在
		// 开关回退后仍能关掉自己打开的第二因子，门控它等于把人锁死在关不掉的第二因子上。
		await mailShareService.resetAuthKey(ctx(), { shareId: on.shareId, action: 'reset' }, USER_A);
		await mailShareService.resetAuthKey(ctx(), { shareId: on.shareId, action: 'disable' }, USER_A);
		expect(authKeyColumns(await readShareRow(on.shareId))).toEqual({
			auth_key_enabled: 0, auth_key_hash: null, auth_key_kid: null, credentials_version: 5
		});
	});

	// 本任务的核心红线：AC-LIFE-11 只门控 enable，若 reset 能落在未启用的行上，它就是一次
	// 绕过 AUTH_KEY_ENABLE 栅栏的 enable —— 随机路由到旧 Worker 的请求会绕过第二因子。
	it('refuses reset on a disabled row under both flag states, so it cannot back-door an enable', async () => {
		await seedOwners();
		const share = await seedKeyless();

		for (const context of [['off', ctx()], ['on', v2ctx()]]) {
			expect([context[0], await catchBiz(mailShareService.resetAuthKey(context[1], {
				shareId: share.shareId, action: 'reset'
			}, USER_A))]).toEqual([context[0], 'SHARE_INVALID_CONFIG']);
		}
		expect(authKeyColumns(await readShareRow(share.shareId))).toEqual({
			auth_key_enabled: 0, auth_key_hash: null, auth_key_kid: null, credentials_version: 3
		});
	});

	it('refuses enable on an already-enabled row, so it cannot become a cv-free reset (AC-AUTH-07)', async () => {
		await seedOwners();
		const share = await seedKeyed();

		expect(await catchBiz(mailShareService.resetAuthKey(v2ctx(), {
			shareId: share.shareId, action: 'enable'
		}, USER_A))).toBe('SHARE_INVALID_CONFIG');
		expect(authKeyColumns(await readShareRow(share.shareId))).toEqual({
			auth_key_enabled: 1, auth_key_hash: 't16-old-key-hash', auth_key_kid: 'v9', credentials_version: 3
		});
	});

	it('refuses disable on an already-disabled row without bumping cv', async () => {
		await seedOwners();
		const share = await seedKeyless();

		expect(await catchBiz(mailShareService.resetAuthKey(ctx(), {
			shareId: share.shareId, action: 'disable'
		}, USER_A))).toBe('SHARE_INVALID_CONFIG');
		// cv 白白 +1 就是白白杀掉一批在飞 Session。
		expect(authKeyColumns(await readShareRow(share.shareId))).toEqual({
			auth_key_enabled: 0, auth_key_hash: null, auth_key_kid: null, credentials_version: 3
		});
	});

	it('never leaks the plaintext into the row, the owner projections or the logs (AC-LEAK-05)', async () => {
		await seedOwners();
		const share = await seedKeyless();
		const lines = [];
		const log = console.log;
		const error = console.error;
		console.log = (...args) => lines.push(args.map(String).join(' '));
		console.error = (...args) => lines.push(args.map(String).join(' '));
		let minted;
		try {
			minted = (await mailShareService.resetAuthKey(v2ctx(), {
				shareId: share.shareId, action: 'enable'
			}, USER_A)).authKey;
			// 明文恰一次：第二条命令回的是一把新的，旧的再也拿不回来。
			const again = await mailShareService.resetAuthKey(ctx(), {
				shareId: share.shareId, action: 'reset'
			}, USER_A);
			expect(again.authKey).not.toBe(minted);
		} finally {
			console.log = log;
			console.error = error;
		}

		expect(lines.join('\n')).not.toContain(minted);
		expect(JSON.stringify(await mailShareService.get(ctx(), { shareId: share.shareId }, USER_A)))
			.not.toContain(minted);
		expect(JSON.stringify(await mailShareService.list(ctx(), {}, USER_A))).not.toContain(minted);
		expect(Object.values(await readShareRow(share.shareId))).not.toContain(minted);
	});
});

describe('resetAuthKey against a live visitor session (T-16)', () => {
	it('enable leaves an established session readable and only guards the new ones (AC-AUTH-07)', async () => {
		await seedOwners();
		const created = await mailShareService.create(workerCtx(), createParams(), USER_A);

		const established = await postSession({ lid: created.lid, sec: created.sec });
		expect(established.code).toBe(200);

		const { authKey } = await mailShareService.resetAuthKey(workerCtx({ SHARE_CAPABILITY_V2: 'true' }), {
			shareId: created.shareId, action: 'enable'
		}, USER_A);

		// 建立时本无 Key 要求，enable 不追溯失效：cv 未动，resolveSession 照常放行。
		expect((await getShareMails(established.data.sessionToken)).code).toBe(200);
		// 新 Session 从此要 Key，且认的就是刚下发的那一把（证明 hash/kid 与 matchAuthKey 同源）。
		expect((await postSession({ lid: created.lid, sec: created.sec })).message).toBe('SHARE_AUTH_REQUIRED');
		expect((await postSession({ lid: created.lid, sec: created.sec, authKey })).code).toBe(200);
	});

	it('reset kills the live session and the old key on the spot (AC-EDGE-05)', async () => {
		await seedOwners();
		const created = await mailShareService.create(workerCtx({ SHARE_CAPABILITY_V2: 'true' }), createParams({
			authKeyEnabled: true
		}), USER_A);
		const established = await postSession({ lid: created.lid, sec: created.sec, authKey: created.authKey });
		expect(established.code).toBe(200);

		const { authKey } = await mailShareService.resetAuthKey(workerCtx(), {
			shareId: created.shareId, action: 'reset'
		}, USER_A);

		expect((await getShareMails(established.data.sessionToken)).message).toBe('SHARE_UNAVAILABLE');
		expect((await postSession({ lid: created.lid, sec: created.sec, authKey: created.authKey })).message)
			.toBe('SHARE_AUTH_REQUIRED');
		const reissued = await postSession({ lid: created.lid, sec: created.sec, authKey });
		expect(reissued.code).toBe(200);
		expect((await getShareMails(reissued.data.sessionToken)).code).toBe(200);
	});

	it('disable kills the live session and stops asking for a key (AC-AUTH-08)', async () => {
		await seedOwners();
		const created = await mailShareService.create(workerCtx({ SHARE_CAPABILITY_V2: 'true' }), createParams({
			authKeyEnabled: true
		}), USER_A);
		const established = await postSession({ lid: created.lid, sec: created.sec, authKey: created.authKey });
		expect(established.code).toBe(200);

		await mailShareService.resetAuthKey(workerCtx(), { shareId: created.shareId, action: 'disable' }, USER_A);

		expect((await getShareMails(established.data.sessionToken)).message).toBe('SHARE_UNAVAILABLE');
		expect((await postSession({ lid: created.lid, sec: created.sec })).code).toBe(200);
		// 多余的旧 Key 被忽略，不得因此报错。
		expect((await postSession({ lid: created.lid, sec: created.sec, authKey: created.authKey })).code).toBe(200);
	});
});

describe('owner API surface for resetAuthKey (T-16)', () => {
	it('serves reset and disable over HTTP with no-store and a single plaintext', async () => {
		await seedOwners();
		const jwt = await ownerJwt();
		const share = await seedKeyed();

		const response = await SELF.fetch('http://example.com/api/mailShare/resetAuthKey', {
			method: 'POST',
			headers: { Authorization: jwt, 'content-type': 'application/json', 'accept-language': 'en' },
			body: JSON.stringify({ shareId: share.shareId, action: 'reset' })
		});
		const rotated = await response.json();

		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(rotated.code).toBe(200);
		expect(rotated.data.authKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(rotated.data).toMatchObject({ shareId: share.shareId, authKeyEnabled: true });

		const disabled = await ownerApi('POST', '/mailShare/resetAuthKey', {
			jwt, body: { shareId: share.shareId, action: 'disable' }
		});
		expect(disabled.json.data.authKeyEnabled).toBe(false);
		expect(disabled.json.data.authKey).toBeUndefined();
		expect(await countAuthKeyInvariantBreaks()).toBe(0);
	});

	it('needs the capability flag flipped for enable and refuses it otherwise (AC-LIFE-11)', async () => {
		await seedOwners();
		const jwt = await ownerJwt();
		const share = await seedKeyless();

		const refused = await ownerApi('POST', '/mailShare/resetAuthKey', {
			jwt, body: { shareId: share.shareId, action: 'enable' }
		});
		expect(refused.json.message).toBe('SHARE_CAPABILITY_NOT_ENABLED');
		expect((await readShareRow(share.shareId)).auth_key_enabled).toBe(0);

		// Worker env 的基线是栅栏关闭态（`wrangler-vitest.toml:41`）；用例自己临时放行再还原，
		// 不改 toml —— 那会把全仓基线从「栅栏关闭」翻过去。
		const saved = env.SHARE_CAPABILITY_V2;
		try {
			env.SHARE_CAPABILITY_V2 = 'true';
			const enabled = await ownerWorker('POST', '/mailShare/resetAuthKey', {
				jwt, body: { shareId: share.shareId, action: 'enable' }
			});
			expect(enabled.json.code).toBe(200);
			expect(enabled.json.data.authKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
		} finally {
			env.SHARE_CAPABILITY_V2 = saved;
		}
		expect(authKeyColumns(await readShareRow(share.shareId))).toMatchObject({
			auth_key_enabled: 1, auth_key_kid: env.SHARE_SEC_PEPPER_KID, credentials_version: 3
		});
	});

	it('refuses an anonymous caller before any column moves (AC-ADMIN-10)', async () => {
		await seedOwners();
		const jwt = await ownerJwt();
		const share = await seedKeyed();
		// 先证明这条路由真的在：否则「匿名被拒」在端点还不存在时也会假绿。
		const owned = await ownerApi('POST', '/mailShare/resetAuthKey', {
			jwt, body: { shareId: share.shareId, action: 'reset' }
		});
		expect(owned.json.code).toBe(200);
		const before = authKeyColumns(await readShareRow(share.shareId));

		const response = await SELF.fetch('http://example.com/api/mailShare/resetAuthKey', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'accept-language': 'en' },
			body: JSON.stringify({ shareId: share.shareId, action: 'disable' })
		});
		const body = await response.json();

		// 今天是 JWT 兜底，T-17 收编 `share:manage` 后会变成 SHARE_FORBIDDEN；断言只钉
		// 「不是成功」，免得 T-17 一落地就把这条打红。
		expect(body.code).not.toBe(200);
		expect(authKeyColumns(await readShareRow(share.shareId))).toEqual(before);
	});
});

// ── T-20a · 换链接（`POST /mailShare/regenerate`）─────────────────────────────
// AC-LIFE-05 / AC-LIFE-11 / AC-SHARE-13 的断言表。语义与 resetAuthKey 同构（状态门 →
// 带 CAS 的条件 UPDATE → 明文恰一次），差别只在轮换的是 `lid`/`sec_hmac` 而不是 AuthKey：
// 这里额外要钉住「**没被**改动的两列」——`expires_at` 与 `window_start_email_id` 一旦
// 跟着动，换链接就悄悄变成了续期 / 重置可见窗口，正是 AC-LIFE-05 要防的那件事。

const REGEN_PRESERVED = ['expires_at', 'window_start_email_id', 'delete_at', 'create_time', 'account_id', 'status'];

function preservedColumns(row) {
	return Object.fromEntries(REGEN_PRESERVED.map((column) => [column, row[column]]));
}

// 全库扫描：明文 sec 不许出现在任何表的任何列里，而不只是 `mail_share`。
// 逐表 `SELECT *` 而不是只查已知列 —— 将来新增一张表忘了脱敏，这条也要红。
async function databaseContains(needle) {
	const tables = await env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
	for (const table of tables.results || []) {
		if (String(table.name).startsWith('sqlite_')) {
			continue;
		}
		const rows = await env.db.prepare(`SELECT * FROM "${table.name}"`).all();
		if (JSON.stringify(rows.results || []).includes(needle)) {
			return table.name;
		}
	}
	return null;
}

// regenerate 的写入走 `c.env.db.batch()`，`ctxStallingUpdate` 那把只包 `.run()` 的
// 探针够不着它；在 batch 提交前插一次并发写入，才是「预读之后、写入之前」这条缝。
function ctxStallingBatch(interfere, overrides = {}) {
	let armed = true;
	const batch = env.db.batch.bind(env.db);
	const db = new Proxy(env.db, {
		get(target, prop) {
			if (prop === 'batch') {
				return async (statements) => {
					if (armed) {
						armed = false;
						await interfere();
					}
					return batch(statements);
				};
			}
			const value = target[prop];
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
	return workerCtx({ db, ...overrides });
}

describe('mailShareService.regenerate (T-20a)', () => {
	it('mints a fresh lid and sec, bumps cv by one and leaves the window and expiry verbatim (AC-LIFE-05)', async () => {
		await seedOwners();
		// 窗口下界与到期时刻都刻意取非默认值:seed 默认的 `window_start_email_id = 0` 会让
		// 「被重置成 0」这种破法在断言里恰好等于「未变」,变异验证证实过这一点。
		const share = await seedKeyless({
			credentialsVersion: 3, windowStartEmailId: 4242, expiresAt: sqlTime(7200)
		});
		const before = await readShareRow(share.shareId);
		expect(before.window_start_email_id).toBe(4242);

		const result = await mailShareService.regenerate(ctx(), { shareId: share.shareId }, USER_A);

		expect(result.lid).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(decodeBase64Url(result.lid).length).toBe(16);
		expect(decodeBase64Url(result.sec).length).toBe(32);
		expect(result.lid).not.toBe(before.lid);
		expect(result.shareUrl).toBe(`https://mail.example.com/s/${result.lid}#${result.sec}`);
		expect(result.shareId).toBe(share.shareId);

		const after = await readShareRow(share.shareId);
		expect(after.lid).toBe(result.lid);
		expect(after.sec_hmac).toBe(await shareAuthService.digestShareSecret(result.sec, PEPPER));
		expect(after.sec_hmac).not.toBe(before.sec_hmac);
		expect(after.pepper_kid).toBe('v2');
		expect(after.credentials_version).toBe(4);
		// 逐字未变：换链接不是续期，也不重置可见窗口。
		expect(preservedColumns(after)).toEqual(preservedColumns(before));
	});

	it('kills the old sec and the live visitor session on the spot, and the new sec works', async () => {
		await seedOwners();
		const created = await mailShareService.create(workerCtx(), createParams(), USER_A);
		const established = await postSession({ lid: created.lid, sec: created.sec });
		expect(established.code).toBe(200);

		const rotated = await mailShareService.regenerate(workerCtx(), { shareId: created.shareId }, USER_A);

		// cv 已 +1 → 在飞会话当场断开。
		expect((await getShareMails(established.data.sessionToken)).message).toBe('SHARE_UNAVAILABLE');
		// 旧 lid 已从表中消失,P4 语义下它是 gone:裸 404 空 body,不再有 JSON 信封。
		const oldLidResponse = await SELF.fetch('http://example.com/api/share/session', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'accept-language': 'en' },
			body: JSON.stringify({ lid: created.lid, sec: created.sec })
		});
		expect(oldLidResponse.status).toBe(404);
		expect(await oldLidResponse.text()).toBe('');
		const reissued = await postSession({ lid: rotated.lid, sec: rotated.sec });
		expect(reissued.code).toBe(200);
		expect((await getShareMails(reissued.data.sessionToken)).code).toBe(200);
	});

	it('refuses an expired or a revoked row and leaves every column alone (AC-LIFE-11)', async () => {
		await seedOwners();
		const revoked = await seedKeyless({ status: 'REVOKED', revokedAt: sqlTime(-60) });
		const expired = await seedKeyless({ expiresAt: '2001-01-01 00:00:00' });

		for (const share of [revoked, expired]) {
			const before = await readShareRow(share.shareId);
			expect(await catchBiz(mailShareService.regenerate(ctx(), { shareId: share.shareId }, USER_A)))
				.toBe('SHARE_NOT_FOUND');
			// 「原地复活」正是这条 AC 禁的:整行一列都不许动。
			expect(await readShareRow(share.shareId)).toEqual(before);
		}
	});

	it('answers SHARE_NOT_FOUND for another owner, a missing row and a malformed id', async () => {
		await seedOwners();
		const theirs = await seedShareRow({ userId: USER_B, accountId: ACC_B });
		await seedBindingRow({ shareId: theirs.shareId, accountId: ACC_B });
		const before = await readShareRow(theirs.shareId);

		for (const shareId of [theirs.shareId, 88881111, 0, -1, 'abc', null, undefined, true]) {
			expect([shareId, await catchBiz(mailShareService.regenerate(ctx(), { shareId }, USER_A))])
				.toEqual([shareId, 'SHARE_NOT_FOUND']);
		}
		expect(await readShareRow(theirs.shareId)).toEqual(before);
	});

	it('loses to a resetAuthKey that lands between the preread and the write (CAS)', async () => {
		await seedOwners();
		const share = await seedKeyed({ credentialsVersion: 3 });
		const before = await readShareRow(share.shareId);

		const stalled = ctxStallingBatch(() => mailShareService.resetAuthKey(workerCtx(), {
			shareId: share.shareId, action: 'reset'
		}, USER_A));

		expect(await catchBiz(mailShareService.regenerate(stalled, { shareId: share.shareId }, USER_A)))
			.toBe('SHARE_UPDATE_CONFLICT');
		// 静默成功是这条用例真正要拦的:凭据只许被轮换一次,lid 不许被盖过去。
		const after = await readShareRow(share.shareId);
		expect(after.lid).toBe(before.lid);
		expect(after.sec_hmac).toBe(before.sec_hmac);
		expect(after.credentials_version).toBe(4);
	});

	it('lets exactly one of two concurrent regenerates win', async () => {
		await seedOwners();
		const share = await seedKeyless({ credentialsVersion: 3 });

		const settled = await Promise.allSettled([
			mailShareService.regenerate(workerCtx(), { shareId: share.shareId }, USER_A),
			mailShareService.regenerate(workerCtx(), { shareId: share.shareId }, USER_A)
		]);

		const won = settled.filter((item) => item.status === 'fulfilled');
		expect(won).toHaveLength(1);
		expect(settled.find((item) => item.status === 'rejected').reason.message).toBe('SHARE_UPDATE_CONFLICT');
		const after = await readShareRow(share.shareId);
		expect(after.lid).toBe(won[0].value.lid);
		expect(after.credentials_version).toBe(4);
	});

	it('never lets the new sec reach any table in the database or the owner projections (AC-SHARE-03)', async () => {
		await seedOwners();
		const share = await seedKeyless();
		const lines = [];
		const log = console.log;
		console.log = (...args) => lines.push(args.map(String).join(' '));
		let sec;
		try {
			sec = (await mailShareService.regenerate(ctx(), {
				shareId: share.shareId, idempotencyKey: 't20a-leak-key'
			}, USER_A)).sec;
		} finally {
			console.log = log;
		}

		expect(await databaseContains(sec)).toBeNull();
		expect(lines.join('\n')).not.toContain(sec);
		expect(JSON.stringify(await mailShareService.get(ctx(), { shareId: share.shareId }, USER_A))).not.toContain(sec);
		expect(JSON.stringify(await mailShareService.list(ctx(), {}, USER_A))).not.toContain(sec);
	});

	// AC-SHARE-13：同 Owner + 同 Key + 同 shareId 在 24h 内重放同一个新 lid，且**不再**下发 sec。
	it('replays the same new lid without the sec when the same Idempotency-Key comes back (AC-SHARE-13)', async () => {
		await seedOwners();
		const share = await seedKeyless({ credentialsVersion: 3 });

		const first = await mailShareService.regenerate(ctx(), {
			shareId: share.shareId, idempotencyKey: 't20a-key'
		}, USER_A);
		const replay = await mailShareService.regenerate(ctx(), {
			shareId: share.shareId, idempotencyKey: 't20a-key'
		}, USER_A);

		expect(replay.lid).toBe(first.lid);
		expect(replay.idempotentReplay).toBe(true);
		expect('sec' in replay).toBe(false);
		expect('shareUrl' in replay).toBe(false);
		// 重放不得再轮换一次凭据 —— 那正是幂等要挡的「重复操作」。
		const after = await readShareRow(share.shareId);
		expect(after.credentials_version).toBe(4);
		expect(after.lid).toBe(first.lid);
	});

	it('answers SHARE_IDEMPOTENCY_CONFLICT when the same key comes back for another share (AC-SHARE-14)', async () => {
		await seedOwners();
		const first = await seedKeyless();
		const second = await seedKeyless();
		await mailShareService.regenerate(ctx(), { shareId: first.shareId, idempotencyKey: 't20a-dup' }, USER_A);
		const before = await readShareRow(second.shareId);

		expect(await catchBiz(mailShareService.regenerate(ctx(), {
			shareId: second.shareId, idempotencyKey: 't20a-dup'
		}, USER_A))).toBe('SHARE_IDEMPOTENCY_CONFLICT');
		expect(await readShareRow(second.shareId)).toEqual(before);
	});

	it('keeps the create and the regenerate idempotency namespaces apart', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), createParams({ idempotencyKey: 't20a-shared' }), USER_A);

		// 同一把 Key 用在 regenerate 上不是冲突：`operation` 是唯一键的一部分。
		const rotated = await mailShareService.regenerate(ctx(), {
			shareId: created.shareId, idempotencyKey: 't20a-shared'
		}, USER_A);
		expect(rotated.lid).not.toBe(created.lid);

		const replayedCreate = await mailShareService.create(ctx(), createParams({ idempotencyKey: 't20a-shared' }), USER_A);
		expect(replayedCreate.idempotentReplay).toBe(true);
		expect(replayedCreate.shareId).toBe(created.shareId);
	});

	it('writes the rotation in one guarded UPDATE that touches neither expires_at nor the window', async () => {
		await seedOwners();
		const share = await seedKeyless();
		const probe = sqlProbe();

		await mailShareService.regenerate({ env: shareEnv({ db: probe.db }) }, { shareId: share.shareId }, USER_A);

		const writes = probe.seen.filter((sql) => /UPDATE\s+mail_share/i.test(sql) && /sec_hmac/i.test(sql));
		expect(writes).toHaveLength(1);
		const [assignments, predicates] = writes[0].split(/\bWHERE\b/i);
		expect(assignments).toMatch(/credentials_version\s*=\s*credentials_version\s*\+\s*1/i);
		expect(assignments).not.toMatch(/expires_at\s*=/i);
		expect(assignments).not.toMatch(/window_start_email_id\s*=/i);
		// CAS 必须在 WHERE 里：预读只挑错误码，谓词才是并发下的防线。
		expect(predicates).toMatch(/credentials_version\s*=\s*\?/i);
		expect(predicates).toMatch(/expires_at\s*=\s*\?/i);
	});
});

describe('owner API surface for regenerate (T-20a)', () => {
	it('serves the rotation over HTTP with no-store and a single plaintext', async () => {
		await seedOwners();
		const jwt = await ownerJwt();
		const share = await seedKeyless();
		const before = await readShareRow(share.shareId);

		const response = await SELF.fetch('http://example.com/api/mailShare/regenerate', {
			method: 'POST',
			headers: {
				Authorization: jwt, 'content-type': 'application/json',
				'accept-language': 'en', 'Idempotency-Key': 't20a-http'
			},
			body: JSON.stringify({ shareId: share.shareId })
		});
		const rotated = await response.json();

		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(rotated.code).toBe(200);
		expect(rotated.data.lid).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(rotated.data.sec).toEqual(expect.any(String));

		// 同一把头再来一次:重放同一个 lid，不再下发 sec。
		const again = await ownerApi('POST', '/mailShare/regenerate', {
			jwt, body: { shareId: share.shareId }
		});
		expect(again.json.code).toBe(200);
		const after = await readShareRow(share.shareId);
		expect(after.expires_at).toBe(before.expires_at);
		expect(after.window_start_email_id).toBe(before.window_start_email_id);
	});

	it('refuses an anonymous caller before any column moves', async () => {
		await seedOwners();
		const jwt = await ownerJwt();
		const share = await seedKeyless();
		// 先证明路由真的在:否则「匿名被拒」在端点不存在时也会假绿。
		const owned = await ownerApi('POST', '/mailShare/regenerate', { jwt, body: { shareId: share.shareId } });
		expect(owned.json.code).toBe(200);
		const before = await readShareRow(share.shareId);

		const response = await SELF.fetch('http://example.com/api/mailShare/regenerate', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'accept-language': 'en' },
			body: JSON.stringify({ shareId: share.shareId })
		});

		expect((await response.json()).code).not.toBe(200);
		expect(await readShareRow(share.shareId)).toEqual(before);
	});
});

// ── T-20b2a · sec 密文持久化接线（ADR-share-credential-recoverability 轨一）───────
// 铸造点已经同时持有明文 `sec` 与新 `lid`，这一包把密文与它的 `kek_kid` 写进**同一条**
// INSERT / UPDATE。两条断言线各自不可省：
// ① 密文真的能解回同一个 sec —— 否则「写进去了」只是多了两列噪声；
// ② KEK 缺失时**零行落库** —— 这是 fail-closed 的全部意义。写了再回滚不算，
//    D1 没有 BEGIN，batch 一提交就没有回头路，而这类行的病征要等 Owner 几天后
//    点开详情才暴露。
// AAD 绑 `lid` 而不是 `share_id`：`share_id` 在 create 的 INSERT 返回之前根本不存在，
// 绑它就只能拆成「先插行、再补密文」两次写入，正是本包要消灭的中间态。`lid` 与 `sec`
// 恒由同一次铸造产生、同一条语句落库（create 与 regenerate 是仅有的两个写入口），
// 所以它同样唯一、同样能让「密文被搬到另一行」验签失败，并且额外让「轮换后残留的旧密文」
// 也解不开 —— 那正好该响，而不该悄悄交回一个已经失效的 sec。

const CURRENT_KEK_KID = env.SHARE_SEC_KEK_KID;

function noKekCtx(overrides = {}) {
	return ctx({ SHARE_SEC_KEK: undefined, SHARE_SEC_KEK_PREV: undefined, ...overrides });
}

async function openSecCipher(row) {
	return decryptShareSec(shareEnv(), { shareId: row.lid, envelope: row.sec_cipher });
}

describe('sec ciphertext persistence (T-20b2a)', () => {
	it('create writes a decryptable envelope plus the current kek_kid, and no plaintext anywhere', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), createParams(), USER_A);

		const row = await readShareRow(created.shareId);
		expect(row.sec_cipher).toEqual(expect.any(String));
		expect(row.sec_cipher).not.toContain(created.sec);
		expect(row.kek_kid).toBe(CURRENT_KEK_KID);
		// 全库扫描复用 T-20a 的守卫：明文 sec 不许出现在任何表的任何列里。
		expect(await databaseContains(created.sec)).toBeNull();

		expect(await openSecCipher(row)).toEqual({
			ok: true, plaintext: created.sec, kekKid: CURRENT_KEK_KID
		});
	});

	it('regenerate replaces the envelope so it decrypts to the new sec, never the old one', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), createParams(), USER_A);
		const before = await readShareRow(created.shareId);

		const rotated = await mailShareService.regenerate(ctx(), { shareId: created.shareId }, USER_A);

		const after = await readShareRow(created.shareId);
		expect(after.sec_cipher).toEqual(expect.any(String));
		expect(after.sec_cipher).not.toBe(before.sec_cipher);
		expect(after.kek_kid).toBe(CURRENT_KEK_KID);
		expect(await openSecCipher(after)).toEqual({
			ok: true, plaintext: rotated.sec, kekKid: CURRENT_KEK_KID
		});
		expect(await databaseContains(rotated.sec)).toBeNull();
		expect(await databaseContains(created.sec)).toBeNull();
	});

	it('refuses to create at all when no KEK is configured, leaving zero rows behind', async () => {
		await seedOwners();
		const errors = [];
		const error = console.error;
		console.error = (...args) => errors.push(args.map(String).join(' '));
		try {
			await expect(mailShareService.create(noKekCtx(), createParams({
				idempotencyKey: 't20b2a-nokek'
			}), USER_A)).rejects.toThrow(/kek/i);
		} finally {
			console.error = error;
		}

		// 「拒绝」的判据是行数，不是异常本身：先写后回滚在 D1 上不存在，
		// 一条半成品行就是一条永远取不回来的分享。
		expect(await countOwnerRows(USER_A)).toEqual({ shares: 0, bindings: 0 });
		const idem = await env.db.prepare('SELECT COUNT(*) AS n FROM share_idempotency WHERE user_id = ?')
			.bind(USER_A).first();
		expect(idem.n).toBe(0);
		// 告警要真的发出去，否则运维只看到一个 500。
		expect(errors.join('\n')).toMatch(/kek/i);
	});

	it('refuses to regenerate when no KEK is configured and leaves every column untouched', async () => {
		await seedOwners();
		const share = await seedKeyless();
		const before = await readShareRow(share.shareId);

		const error = console.error;
		console.error = () => {};
		try {
			await expect(mailShareService.regenerate(noKekCtx(), {
				shareId: share.shareId, idempotencyKey: 't20b2a-nokek-regen'
			}, USER_A)).rejects.toThrow(/kek/i);
		} finally {
			console.error = error;
		}

		expect(await readShareRow(share.shareId)).toEqual(before);
	});

	// 这条钉的是**顺序**,不只是「最终被拒」。铸造点自己也会在 KEK 缺失时抛,所以
	// 「零行落库」在前置探测被删掉后依然成立 —— 变异验证当场证实了这一点,它单独立不住。
	// 幂等重放是那条唯一能把两者分开的缝:探测在重放之前,整条写入面(含重放)一起拒;
	// 探测挪到铸造点里,重放就会绕过它,把一次部署事故藏进一条看着正常的 200 响应。
	it('refuses even an idempotent replay while the KEK is missing, on both write paths', async () => {
		await seedOwners();
		const error = console.error;
		console.error = () => {};
		try {
			const created = await mailShareService.create(ctx(), createParams({
				idempotencyKey: 't20b2a-order-create'
			}), USER_A);
			// 同一把 Key 在 KEK 健在时确实会重放成功,否则下面那条断言测的是别的东西。
			expect((await mailShareService.create(ctx(), createParams({
				idempotencyKey: 't20b2a-order-create'
			}), USER_A)).idempotentReplay).toBe(true);
			await expect(mailShareService.create(noKekCtx(), createParams({
				idempotencyKey: 't20b2a-order-create'
			}), USER_A)).rejects.toThrow(/kek/i);

			const rotated = await mailShareService.regenerate(ctx(), {
				shareId: created.shareId, idempotencyKey: 't20b2a-order-regen'
			}, USER_A);
			expect(rotated.lid).not.toBe(created.lid);
			expect((await mailShareService.regenerate(ctx(), {
				shareId: created.shareId, idempotencyKey: 't20b2a-order-regen'
			}, USER_A)).idempotentReplay).toBe(true);
			await expect(mailShareService.regenerate(noKekCtx(), {
				shareId: created.shareId, idempotencyKey: 't20b2a-order-regen'
			}, USER_A)).rejects.toThrow(/kek/i);
		} finally {
			console.error = error;
		}
	});

	it('keeps the AuthKey unrecoverable: hash and kid only, never an envelope', async () => {
		await seedOwners();
		const created = await mailShareService.create(v2ctx(), createParams({ authKeyEnabled: true }), USER_A);
		const row = await readShareRow(created.shareId);

		expect(created.authKey).toEqual(expect.any(String));
		expect(row.auth_key_hash).toEqual(expect.any(String));
		// 全库扫描：AuthKey 明文不在库里，而且**没有**任何一列能把它解回来。
		expect(await databaseContains(created.authKey)).toBeNull();
		expect(await openSecCipher(row)).toEqual({
			ok: true, plaintext: created.sec, kekKid: CURRENT_KEK_KID
		});
		expect((await openSecCipher(row)).plaintext).not.toBe(created.authKey);
		// 列清单里只多了 sec 这一路的两列，AuthKey 没有对应物。
		expect(Object.keys(row)).not.toContain('auth_key_cipher');
	});

	it('never lets the credential columns reach the owner projections', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), createParams(), USER_A);
		const row = await readShareRow(created.shareId);

		const detail = JSON.stringify(await mailShareService.get(ctx(), { shareId: created.shareId }, USER_A));
		const list = JSON.stringify(await mailShareService.list(ctx(), {}, USER_A));
		for (const payload of [detail, list]) {
			expect(payload).not.toContain(row.sec_cipher);
			expect(payload).not.toContain('secCipher');
			expect(payload).not.toContain('kekKid');
			expect(payload).not.toContain(row.sec_hmac);
		}
	});

	it('writes the ciphertext inside the very statement that writes the row', async () => {
		await seedOwners();
		const probe = sqlProbe();
		const probeCtx = { env: shareEnv({ db: probe.db }) };

		const created = await mailShareService.create(probeCtx, createParams(), USER_A);
		const inserts = probe.seen.filter((sql) => /INSERT\s+INTO\s+mail_share\b/i.test(sql));
		expect(inserts).toHaveLength(1);
		expect(inserts[0]).toMatch(/sec_cipher/i);
		expect(inserts[0]).toMatch(/kek_kid/i);
		// 补写式的第二条语句正是本包禁止的中间态。
		expect(probe.seen.filter((sql) => /UPDATE\s+mail_share[\s\S]*sec_cipher\s*=/i.test(sql))).toHaveLength(0);

		probe.seen.length = 0;
		await mailShareService.regenerate(probeCtx, { shareId: created.shareId }, USER_A);
		const rotations = probe.seen.filter((sql) => /UPDATE\s+mail_share/i.test(sql) && /sec_hmac/i.test(sql));
		expect(rotations).toHaveLength(1);
		expect(rotations[0]).toMatch(/sec_cipher\s*=\s*\?/i);
		expect(rotations[0]).toMatch(/kek_kid\s*=\s*\?/i);
	});
});

// ── T-20b2b · 查看链接（`POST /mailShare/revealSec`）────────────────────────────
// 轨一的读取端。这一包的全部风险都在**失败分类**上：解密模块已经把五种成因分开返回了，
// 端点只要把任意两种折成一句「解不开」，一次部署事故（KEK 没配）或一次数据损坏
// （密文被改写）就会被管理员当成「这条老分享而已」放过去，而这恰恰是 ADR 唯一
// 排除的结局。所以下面每一条失败都单独立一个断言，并且额外有一条「四个码互不相等」
// 的反折叠断言 —— 单看每条用例，把两类映射到同一个码时它们仍会各自通过。

const REVEAL_CODES = {
	absent: 'SHARE_SEC_ABSENT',
	kekMissing: 'SHARE_SEC_UNAVAILABLE',
	retired: 'SHARE_SEC_KEY_RETIRED',
	corrupted: 'SHARE_SEC_CORRUPTED'
};

async function captureLogs(run) {
	const lines = [];
	const log = console.log;
	console.log = (...args) => lines.push(args.map(String).join(' '));
	try {
		return { value: await run(), lines };
	} finally {
		console.log = log;
	}
}

function revealEvents(lines) {
	return lines
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter((entry) => entry && entry.event === SHARE_EVENT.SEC_REVEAL);
}

async function writeSecCipher(shareId, cipher) {
	await env.db.prepare('UPDATE mail_share SET sec_cipher = ? WHERE share_id = ?').bind(cipher, shareId).run();
}

function retireEnvelopeKid(envelope) {
	const parts = String(envelope).split(':');
	parts[1] = 't20b2b-retired-kid';
	return parts.join(':');
}

describe('mailShareService.revealSec (T-20b2b)', () => {
	it('hands the owner back the very URL the create response issued', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), createParams(), USER_A);

		const revealed = await mailShareService.revealSec(ctx(), { shareId: created.shareId }, USER_A);

		// 逐字相等,不是「形状对」:拼错一个字符,管理员复制出去的就是一条坏链接。
		expect(revealed.shareUrl).toBe(created.shareUrl);
		expect(revealed.shareId).toBe(created.shareId);
		expect(revealed.lid).toBe(created.lid);
	});

	it('refuses another owner exactly as it refuses a row that never existed', async () => {
		await seedOwners();
		const theirs = await mailShareService.create(ctx(), createParams({ accountId: ACC_B }), USER_B);

		const foreign = await catchBiz(mailShareService.revealSec(ctx(), { shareId: theirs.shareId }, USER_A));
		const missing = await catchBiz(mailShareService.revealSec(ctx(), { shareId: 88881111 }, USER_A));

		expect(foreign).toBe('SHARE_NOT_FOUND');
		// 两者必须逐字相同,否则错误码本身就是一台存在性探针。
		expect(foreign).toBe(missing);
		for (const shareId of [0, -1, 'abc', null, undefined, true]) {
			expect([shareId, await catchBiz(mailShareService.revealSec(ctx(), { shareId }, USER_A))])
				.toEqual([shareId, 'SHARE_NOT_FOUND']);
		}
	});

	it('tells a pre-feature row apart as a benign, non-alerting outcome', async () => {
		await seedOwners();
		// seedShareRow 不写 sec_cipher —— 正是上线前那批行的形状。
		const share = await seedKeyless();

		const { value, lines } = await captureLogs(
			() => catchBiz(mailShareService.revealSec(ctx(), { shareId: share.shareId }, USER_A))
		);

		expect(value).toBe(REVEAL_CODES.absent);
		expect(revealEvents(lines)).toEqual([expect.objectContaining({
			shareId: share.shareId, userId: USER_A, outcome: 'absent', alert: false
		})]);
	});

	it('reports a missing KEK as a service fault with an alert, not as a benign degradation', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), createParams(), USER_A);

		const { value, lines } = await captureLogs(
			() => catchBiz(mailShareService.revealSec(noKekCtx(), { shareId: created.shareId }, USER_A))
		);

		// 部署事故:既不是 500 崩溃(BizError 才走得到这里),也不是「存量不可恢复」。
		expect(value).toBe(REVEAL_CODES.kekMissing);
		expect(value).not.toBe(REVEAL_CODES.absent);
		expect(revealEvents(lines)).toEqual([expect.objectContaining({
			shareId: created.shareId, outcome: 'kek_missing', alert: true
		})]);
	});

	it('reports a kid that has left the ring as recoverable-by-regenerate, without alerting', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), createParams(), USER_A);
		const row = await readShareRow(created.shareId);
		await writeSecCipher(created.shareId, retireEnvelopeKid(row.sec_cipher));

		const { value, lines } = await captureLogs(
			() => catchBiz(mailShareService.revealSec(ctx(), { shareId: created.shareId }, USER_A))
		);

		expect(value).toBe(REVEAL_CODES.retired);
		expect(revealEvents(lines)).toEqual([expect.objectContaining({
			outcome: 'unknown_kid', alert: false, kekKid: 't20b2b-retired-kid'
		})]);
	});

	it('treats an envelope lifted off another row as a data-integrity incident', async () => {
		await seedOwners();
		const mine = await mailShareService.create(ctx(), createParams({ name: 'mine' }), USER_A);
		const other = await mailShareService.create(ctx(), createParams({ name: 'other' }), USER_A);
		// AAD 绑 lid,所以搬到另一行的密文过不了 tag 校验 —— 这正是绑定要抓的事。
		await writeSecCipher(mine.shareId, (await readShareRow(other.shareId)).sec_cipher);

		const { value, lines } = await captureLogs(
			() => catchBiz(mailShareService.revealSec(ctx(), { shareId: mine.shareId }, USER_A))
		);

		expect(value).toBe(REVEAL_CODES.corrupted);
		expect(revealEvents(lines)).toEqual([expect.objectContaining({
			outcome: 'auth_failed', alert: true
		})]);
	});

	it('keeps a malformed envelope apart from a tampered one in the event, though the admin sees one message', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), createParams(), USER_A);
		await writeSecCipher(created.shareId, 'not-an-envelope-at-all');

		const { value, lines } = await captureLogs(
			() => catchBiz(mailShareService.revealSec(ctx(), { shareId: created.shareId }, USER_A))
		);

		// 对管理员同 AUTH_FAILED(都是「凭据数据异常」),但成因在写入侧,事件里必须分得开。
		expect(value).toBe(REVEAL_CODES.corrupted);
		expect(revealEvents(lines)).toEqual([expect.objectContaining({
			outcome: 'malformed', alert: true
		})]);
	});

	// 反折叠闸门:上面五条各自看,把任意两类映射到同一个码时它们仍然全绿。
	it('never folds the five outcomes into one undistinguishable answer', async () => {
		await seedOwners();
		const legacy = await seedKeyless();
		const live = await mailShareService.create(ctx(), createParams(), USER_A);
		const retired = await mailShareService.create(ctx(), createParams({ name: 'retired' }), USER_A);
		await writeSecCipher(retired.shareId, retireEnvelopeKid((await readShareRow(retired.shareId)).sec_cipher));
		const broken = await mailShareService.create(ctx(), createParams({ name: 'broken' }), USER_A);
		await writeSecCipher(broken.shareId, 'not-an-envelope-at-all');

		const codes = [
			await catchBiz(mailShareService.revealSec(ctx(), { shareId: legacy.shareId }, USER_A)),
			await catchBiz(mailShareService.revealSec(noKekCtx(), { shareId: live.shareId }, USER_A)),
			await catchBiz(mailShareService.revealSec(ctx(), { shareId: retired.shareId }, USER_A)),
			await catchBiz(mailShareService.revealSec(ctx(), { shareId: broken.shareId }, USER_A))
		];

		expect(codes).toEqual([
			REVEAL_CODES.absent, REVEAL_CODES.kekMissing, REVEAL_CODES.retired, REVEAL_CODES.corrupted
		]);
		expect(new Set(codes).size).toBe(4);
	});

	it('audits every call without ever writing the plaintext or the ciphertext', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), createParams(), USER_A);
		const row = await readShareRow(created.shareId);

		const { value, lines } = await captureLogs(
			() => mailShareService.revealSec(ctx(), { shareId: created.shareId }, USER_A)
		);
		const joined = lines.join('\n');

		expect(revealEvents(lines)).toEqual([expect.objectContaining({
			shareId: created.shareId, userId: USER_A, outcome: 'ok', alert: false
		})]);
		expect(joined).not.toContain(created.sec);
		expect(joined).not.toContain(value.shareUrl);
		expect(joined).not.toContain(row.sec_cipher);
		// 取回明文不得让它落库:全库扫描复用 T-20a 的守卫。
		expect(await databaseContains(created.sec)).toBeNull();
	});

	it('audits a refused call too, without telling the caller anything extra', async () => {
		await seedOwners();
		const theirs = await mailShareService.create(ctx(), createParams({ accountId: ACC_B }), USER_B);

		const { value, lines } = await captureLogs(
			() => catchBiz(mailShareService.revealSec(ctx(), { shareId: theirs.shareId }, USER_A))
		);

		expect(value).toBe('SHARE_NOT_FOUND');
		expect(revealEvents(lines)).toEqual([expect.objectContaining({
			shareId: theirs.shareId, userId: USER_A, outcome: 'denied', alert: false
		})]);
	});

	// 裁决:查看不等于使用。过期 / 撤销的行,其链接在访客侧恒被拒(`consumeSessionQuota`
	// 的 ACTIVE + 未过期谓词),而且没有任何路径能让它复活 —— regenerate 与 update 都只
	// 认 ACTIVE 且未过期的行。所以交回这条链接不给出任何可用能力,却是 AC-ADMIN-09
	// 「非 ACTIVE 行仍可读可审计」的一部分:管理员正是在这些行上排查「当初发的是哪条」。
	it('still reveals an expired or a revoked share, because that link can no longer be used', async () => {
		await seedOwners();
		const expired = await mailShareService.create(ctx(), createParams({ name: 'exp' }), USER_A);
		const revoked = await mailShareService.create(ctx(), createParams({ name: 'rev' }), USER_A);
		await env.db.prepare("UPDATE mail_share SET expires_at = '2001-01-01 00:00:00' WHERE share_id = ?")
			.bind(expired.shareId).run();
		await mailShareService.revoke(ctx(), { shareId: revoked.shareId }, USER_A);

		expect((await mailShareService.revealSec(ctx(), { shareId: expired.shareId }, USER_A)).shareUrl)
			.toBe(expired.shareUrl);
		expect((await mailShareService.revealSec(ctx(), { shareId: revoked.shareId }, USER_A)).shareUrl)
			.toBe(revoked.shareUrl);
	});

	it('hands back the rotated link after a regenerate, never the retired one', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), createParams(), USER_A);
		const rotated = await mailShareService.regenerate(ctx(), { shareId: created.shareId }, USER_A);

		const revealed = await mailShareService.revealSec(ctx(), { shareId: created.shareId }, USER_A);

		expect(revealed.shareUrl).toBe(rotated.shareUrl);
		expect(revealed.shareUrl).not.toBe(created.shareUrl);
		expect(revealed.shareUrl).not.toContain(created.sec);
	});

	it('reads the row exactly once and writes nothing', async () => {
		await seedOwners();
		const created = await mailShareService.create(ctx(), createParams(), USER_A);
		const before = await readShareRow(created.shareId);
		const probe = sqlProbe();

		await mailShareService.revealSec({ env: shareEnv({ db: probe.db }) }, { shareId: created.shareId }, USER_A);

		expect(probe.seen.filter((sql) => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql))).toEqual([]);
		expect(await readShareRow(created.shareId)).toEqual(before);
	});
});

describe('owner API surface for revealSec (T-20b2b)', () => {
	afterEach(() => {
		delete env.SHARE_REVEAL_RATE_LIMITER;
	});

	// 建与取回必须走同一份 env:`SHARE_PUBLIC_ORIGIN` 在 Worker 侧没配(回落请求 origin),
	// 在测试 ctx 里配了 —— 用服务层建、用 HTTP 取回,两条链接会因为 origin 不同而不等,
	// 而那是测试自己造出来的差异,不是产品的。
	async function httpCreate(jwt) {
		const created = await ownerApi('POST', '/mailShare/create', {
			jwt, body: { accountId: ACC_A, durationSeconds: 3600, name: 't20b2b', remark: '' }
		});
		expect(created.json.code).toBe(200);
		return created.json.data;
	}

	it('serves the link over HTTP with no-store', async () => {
		await seedOwners();
		const jwt = await ownerJwt();
		const created = await httpCreate(jwt);

		const response = await SELF.fetch('http://example.com/api/mailShare/revealSec', {
			method: 'POST',
			headers: { Authorization: jwt, 'content-type': 'application/json', 'accept-language': 'en' },
			body: JSON.stringify({ shareId: created.shareId })
		});
		const body = await response.json();

		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(body.code).toBe(200);
		expect(body.data.shareUrl).toBe(created.shareUrl);
	});

	it('refuses a share that belongs to another owner over HTTP', async () => {
		await seedOwners();
		const jwt = await ownerJwt();
		const theirs = await mailShareService.create(ctx(), createParams({ accountId: ACC_B }), USER_B);

		const denied = await ownerApi('POST', '/mailShare/revealSec', {
			jwt, body: { shareId: theirs.shareId }
		});

		expect(denied.json.code).not.toBe(200);
		expect(denied.json.message).toBe('SHARE_NOT_FOUND');
		expect(JSON.stringify(denied.json)).not.toContain(theirs.sec);
	});

	it('answers 429 with Retry-After when the owner limiter denies, without revealing anything', async () => {
		await seedOwners();
		const jwt = await ownerJwt();
		const created = await httpCreate(jwt);
		const keys = [];
		env.SHARE_REVEAL_RATE_LIMITER = {
			async limit({ key }) {
				keys.push(key);
				return { success: false };
			}
		};

		const response = await worker.fetch(new Request('http://example.com/api/mailShare/revealSec', {
			method: 'POST',
			headers: { Authorization: jwt, 'content-type': 'application/json', 'accept-language': 'en' },
			body: JSON.stringify({ shareId: created.shareId })
		}), env, {});
		const body = await response.json();

		expect(response.status).toBe(429);
		expect(response.headers.get('Retry-After')).toBe('60');
		expect(body.message).toBe('RATE_LIMITED');
		expect(JSON.stringify(body)).not.toContain(created.sec);
		// Owner 是已鉴权主体,按 userId 计而不是按 IP —— 换个出口 IP 不该换来一份新配额。
		expect(keys).toEqual([String(USER_A)]);
	});

	it('lets the call through when the limiter allows', async () => {
		await seedOwners();
		const jwt = await ownerJwt();
		const created = await httpCreate(jwt);
		env.SHARE_REVEAL_RATE_LIMITER = { async limit() { return { success: true }; } };

		const response = await worker.fetch(new Request('http://example.com/api/mailShare/revealSec', {
			method: 'POST',
			headers: { Authorization: jwt, 'content-type': 'application/json', 'accept-language': 'en' },
			body: JSON.stringify({ shareId: created.shareId })
		}), env, {});

		expect(response.status).toBe(200);
		expect((await response.json()).data.shareUrl).toBe(created.shareUrl);
	});

	it('declares the limiter binding in the production wrangler.toml', () => {
		// 绑定缺失时中间件 fail-open(share-rate-limit.js:56)——限流「装了但没生效」
		// 只会在 toml 里看得出来,运行时是静默的。
		expect(wranglerToml).toContain('SHARE_REVEAL_RATE_LIMITER');
	});
});
