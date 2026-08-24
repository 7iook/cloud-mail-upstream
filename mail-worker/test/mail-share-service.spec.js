import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { emailConst, isDel } from '../src/const/entity-const';
import shareAuthService from '../src/service/share-auth-service';
import mailShareService, {
	SHARE_BINDING_LIMIT,
	SHARE_EVENT,
	SHARE_V2_INTENT,
	assertCapabilityV2,
	logShareEvent,
	syncPrimaryAccountId
} from '../src/service/mail-share-service';
import shareResult from '../src/model/share-result';
import initSource from '../src/init/init.js?raw';
import wranglerToml from '../wrangler.toml?raw';
import { seedBindingRow, seedShareRow } from './setup.js';

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
	])('rejects %s with SHARE_INVALID_CONFIG and leaves zero rows', async (_label, overrides) => {
		await seedOwners();
		const message = await catchBiz(mailShareService.create(ctx(), createParams(overrides), USER_A));

		expect(message).toBe('SHARE_INVALID_CONFIG');
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

	it.each(GATED_INTENTS)('rejects %s with SHARE_INVALID_CONFIG when the flag is missing', (intent) => {
		const err = catchBizSync(() => assertCapabilityV2({ env: {} }, intent));
		expect(err.message).toBe('SHARE_INVALID_CONFIG');
		expect(err.code).toBe(501);
	});

	it.each(GATED_INTENTS)('rejects %s when the flag is explicitly off', (intent) => {
		for (const flag of ['false', '0', 0, false, '']) {
			const err = catchBizSync(() => assertCapabilityV2(ctx({ SHARE_CAPABILITY_V2: flag }), intent));
			expect(err.message).toBe('SHARE_INVALID_CONFIG');
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
		expect(err.message).toBe('SHARE_INVALID_CONFIG');
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
			SYSTEM_ERROR: 'share.system.error'
		});
	});

	it('emits one JSON line carrying requestId and shareId even when unset', () => {
		const lines = [];
		const log = console.log;
		console.log = (...args) => lines.push(args.map(String).join(' '));
		try {
			logShareEvent(SHARE_EVENT.SESSION_DENIED_QUOTA, { shareId: 42, reason: 'quota_exhausted' });
			logShareEvent(SHARE_EVENT.SYSTEM_ERROR, {});
		} finally {
			console.log = log;
		}
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
		const lines = [];
		const log = console.log;
		console.log = (...args) => lines.push(args.map(String).join(' '));
		try {
			logShareEvent(SHARE_EVENT.SESSION_DENIED_AUTH, {
				event: 'overridden',
				ts: 'overridden',
				shareId: 7,
				reason: 'bad_sec'
			});
		} finally {
			console.log = log;
		}
		const parsed = JSON.parse(lines[0]);
		expect(parsed.event).toBe('share.session.denied_auth');
		expect(parsed.ts).not.toBe('overridden');
		expect(parsed).toMatchObject({ requestId: null, shareId: 7, reason: 'bad_sec' });
	});

	it('keeps init.js on its own literal instead of importing service constants', () => {
		expect(initSource).toContain("event: 'share.migrate.invalid_row'");
		expect(initSource).not.toMatch(/from\s+['"].*mail-share-service/);
	});
});
