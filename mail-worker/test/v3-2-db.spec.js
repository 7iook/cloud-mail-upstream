import { env } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { dbInit } from '../src/init/init.js';
import { isDel } from '../src/const/entity-const.js';

const c = { env };

let seq = 0;
function nextId() {
	seq += 1;
	return 930000 + seq;
}

async function columnInfo(table) {
	const rows = await env.db.prepare(`SELECT * FROM pragma_table_info('${table}')`).all();
	return Object.fromEntries((rows.results || []).map((r) => [r.name, r]));
}

async function objectExists(type, name) {
	const row = await env.db.prepare(
		`SELECT name FROM sqlite_master WHERE type = ? AND name = ?`
	).bind(type, name).first();
	return Boolean(row);
}

async function insertAccount({ accountId, userId, deleted = false }) {
	await env.db.prepare(`
		INSERT INTO account (account_id, email, name, status, user_id, is_del)
		VALUES (?, ?, ?, 0, ?, ?)
	`).bind(
		accountId,
		`v32-${accountId}@example.com`,
		`v32-${accountId}`,
		userId,
		deleted ? isDel.DELETE : isDel.NORMAL
	).run();
	return accountId;
}

// v3_1 形状旧行：只有主表 account_id，没有 Binding —— 与旧 Worker 的写入一致
async function insertLegacyShare({ userId, accountId, accessCount = 0, windowStartEmailId = 0, status = 'ACTIVE' }) {
	const lid = `lid-v32-${nextId()}`;
	const row = await env.db.prepare(`
		INSERT INTO mail_share (
			lid, sec_hmac, pepper_kid, user_id, account_id, status,
			window_start_email_id, expires_at, delete_at, access_count
		) VALUES (?, 'hmac', 'kid-1', ?, ?, ?, ?, '2099-01-01 00:00:00', '2099-01-02 00:00:00', ?)
		RETURNING share_id
	`).bind(lid, userId, accountId, status, windowStartEmailId, accessCount).first();
	return row.share_id;
}

async function share(shareId) {
	return env.db.prepare(
		'SELECT share_id, status, revoked_at, access_count, account_id, user_id, window_start_email_id FROM mail_share WHERE share_id = ?'
	).bind(shareId).first();
}

async function bindings(shareId) {
	const rows = await env.db.prepare(
		'SELECT binding_id, share_id, account_id, window_start_email_id, create_time FROM mail_share_binding WHERE share_id = ? ORDER BY binding_id'
	).bind(shareId).all();
	return rows.results || [];
}

async function illegalBindingCount() {
	const row = await env.db.prepare(`
		SELECT COUNT(*) AS total
		FROM mail_share_binding b
		JOIN mail_share ms ON ms.share_id = b.share_id
		WHERE NOT EXISTS (
			SELECT 1 FROM account a
			WHERE a.account_id = b.account_id AND a.is_del = 0 AND a.user_id = ms.user_id
		)
	`).first();
	return row.total;
}

function migrateLogs(spy) {
	return spy.mock.calls
		.map(([first]) => {
			if (typeof first !== 'string') return null;
			try {
				return JSON.parse(first);
			} catch {
				return null;
			}
		})
		.filter((entry) => entry && entry.event === 'share.migrate.invalid_row');
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('v3_2DB DDL (design.md Data Models · expand-only)', () => {
	it('adds the 11 new mail_share columns and keeps every legacy column', async () => {
		const cols = await columnInfo('mail_share');

		expect(cols.max_sessions).toBeTruthy();
		expect(cols.max_sessions.notnull).toBe(0);
		expect(cols.message_limit).toBeTruthy();
		expect(cols.message_limit.notnull).toBe(0);
		expect(cols.only_messages_after_created.notnull).toBe(1);
		expect(cols.only_messages_after_created.dflt_value).toBe('1');
		expect(cols.otp_extraction_enabled.notnull).toBe(1);
		expect(cols.otp_extraction_enabled.dflt_value).toBe('1');
		expect(cols.auto_refresh.notnull).toBe(1);
		expect(cols.auto_refresh.dflt_value).toBe('1');
		expect(cols.refresh_interval_ms.notnull).toBe(1);
		expect(cols.refresh_interval_ms.dflt_value).toBe('3000');
		expect(cols.show_full_address.notnull).toBe(1);
		expect(cols.show_full_address.dflt_value).toBe('0');
		expect(cols.auth_key_enabled.notnull).toBe(1);
		expect(cols.auth_key_enabled.dflt_value).toBe('0');
		expect(cols.auth_key_hash).toBeTruthy();
		expect(cols.auth_key_hash.notnull).toBe(0);
		expect(cols.auth_key_kid).toBeTruthy();
		expect(cols.auth_key_kid.notnull).toBe(0);
		expect(cols.credentials_version.notnull).toBe(1);
		expect(cols.credentials_version.dflt_value).toBe('0');

		// 遗留列语义：零 RENAME 零 DROP
		expect(cols.access_count).toBeTruthy();
		expect(cols.account_id).toBeTruthy();
		expect(cols.window_start_email_id).toBeTruthy();
		expect(cols.share_type).toBeUndefined();
	});

	it('creates mail_share_binding with both indexes and never creates mail_share_auth_fail', async () => {
		expect(await objectExists('table', 'mail_share_binding')).toBe(true);
		expect(await objectExists('table', 'mail_share_auth_fail')).toBe(false);
		expect(await objectExists('index', 'idx_msb_share_account')).toBe(true);
		expect(await objectExists('index', 'idx_msb_account')).toBe(true);

		const cols = await columnInfo('mail_share_binding');
		expect(Object.keys(cols).sort()).toEqual([
			'account_id',
			'binding_id',
			'create_time',
			'share_id',
			'window_start_email_id',
		]);
		expect(cols.binding_id.pk).toBe(1);
		expect(cols.share_id.notnull).toBe(1);
		expect(cols.account_id.notnull).toBe(1);
		expect(cols.window_start_email_id.notnull).toBe(1);
		expect(cols.window_start_email_id.dflt_value).toBe('0');
		expect(cols.create_time.notnull).toBe(1);
	});

	it('enforces UNIQUE(share_id, account_id) on mail_share_binding', async () => {
		const userId = nextId();
		const accountId = await insertAccount({ accountId: nextId(), userId });
		const shareId = await insertLegacyShare({ userId, accountId });

		await env.db.prepare(
			'INSERT INTO mail_share_binding (share_id, account_id) VALUES (?, ?)'
		).bind(shareId, accountId).run();

		await expect(
			env.db.prepare('INSERT INTO mail_share_binding (share_id, account_id) VALUES (?, ?)')
				.bind(shareId, accountId).run()
		).rejects.toThrow();
	});
});

// v3_3DB:sec 密文持久化的两列。迁移由人工访问 `GET /api/init/{jwt_secret}` 触发,
// 所以「重复跑」不是假想场景 —— 运维每次升级都会再点一次同一个链接。
describe('v3_3DB DDL (ADR-share-credential-recoverability · expand-only)', () => {
	it('adds sec_cipher and kek_kid as nullable text and touches nothing else', async () => {
		const cols = await columnInfo('mail_share');

		expect(cols.sec_cipher).toBeTruthy();
		expect(cols.sec_cipher.type.toUpperCase()).toBe('TEXT');
		// 存量行没有密文,NOT NULL 会让 ALTER 在有数据的表上直接失败。
		expect(cols.sec_cipher.notnull).toBe(0);
		expect(cols.sec_cipher.dflt_value).toBeNull();
		expect(cols.kek_kid).toBeTruthy();
		expect(cols.kek_kid.type.toUpperCase()).toBe('TEXT');
		expect(cols.kek_kid.notnull).toBe(0);

		// expand-only:零 RENAME 零 DROP,凭据旧列原样还在。
		expect(cols.sec_hmac).toBeTruthy();
		expect(cols.pepper_kid).toBeTruthy();
		expect(cols.auth_key_hash).toBeTruthy();
		// AuthKey 不纳入可逆范围。
		expect(cols.auth_key_cipher).toBeUndefined();
	});

	it('is idempotent: reruns neither throw nor duplicate the columns', async () => {
		const before = await columnInfo('mail_share');
		const beforeNames = Object.keys(before);

		await dbInit.v3_3DB(c);
		await dbInit.v3_3DB(c);

		const after = await columnInfo('mail_share');
		expect(Object.keys(after)).toEqual(beforeNames);
		expect(after.sec_cipher.cid).toBe(before.sec_cipher.cid);
		expect(after.kek_kid.cid).toBe(before.kek_kid.cid);
	});

	it('leaves ciphertext already on a row untouched across a rerun', async () => {
		const ownerId = nextId();
		const accountId = await insertAccount({ accountId: nextId(), userId: ownerId });
		const shareId = await insertLegacyShare({ userId: ownerId, accountId });
		await env.db.prepare('UPDATE mail_share SET sec_cipher = ?, kek_kid = ? WHERE share_id = ?')
			.bind('v1:k1:nonce:ct', 'k1', shareId).run();

		await dbInit.v3_3DB(c);

		const row = await env.db.prepare('SELECT sec_cipher, kek_kid FROM mail_share WHERE share_id = ?')
			.bind(shareId).first();
		expect(row.sec_cipher).toBe('v1:k1:nonce:ct');
		expect(row.kek_kid).toBe('k1');
	});
});

describe('v3_2DB backfill gate (R2-A4 · AC-BIND-09/11)', () => {
	it('backfills exactly one Binding for a legal v3_1 row and preserves access_count', async () => {
		const userId = nextId();
		const accountId = await insertAccount({ accountId: nextId(), userId });
		const shareId = await insertLegacyShare({
			userId,
			accountId,
			accessCount: 7,
			windowStartEmailId: 4242,
		});

		await dbInit.v3_2DB(c);

		const rows = await bindings(shareId);
		expect(rows).toHaveLength(1);
		expect(rows[0].account_id).toBe(accountId);
		expect(rows[0].window_start_email_id).toBe(4242);

		const row = await share(shareId);
		expect(row.status).toBe('ACTIVE');
		expect(row.revoked_at).toBeNull();
		expect(row.access_count).toBe(7);
		expect(await illegalBindingCount()).toBe(0);
	});

	it('revokes the three dirty shapes with revoked_at and zero Bindings', async () => {
		const ownerId = nextId();
		const strangerId = nextId();

		const deletedAccountId = await insertAccount({ accountId: nextId(), userId: ownerId, deleted: true });
		const strangerAccountId = await insertAccount({ accountId: nextId(), userId: strangerId });
		const missingAccountId = nextId();

		const deletedShare = await insertLegacyShare({ userId: ownerId, accountId: deletedAccountId, accessCount: 3 });
		const mismatchShare = await insertLegacyShare({ userId: ownerId, accountId: strangerAccountId, accessCount: 5 });
		const missingShare = await insertLegacyShare({ userId: ownerId, accountId: missingAccountId, accessCount: 9 });

		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		await dbInit.v3_2DB(c);

		for (const [shareId, expectedCount] of [[deletedShare, 3], [mismatchShare, 5], [missingShare, 9]]) {
			const row = await share(shareId);
			expect(row.status).toBe('REVOKED');
			expect(row.revoked_at).toBeTruthy();
			expect(row.access_count).toBe(expectedCount);
			expect(await bindings(shareId)).toHaveLength(0);
		}

		const logged = migrateLogs(logSpy);
		const loggedShareIds = logged.map((entry) => entry.shareId);
		expect(loggedShareIds).toEqual(expect.arrayContaining([deletedShare, mismatchShare, missingShare]));
		// 发布门槛点名必须告警的三个事件之一。它曾绕过统一出口手写 console.log,字段形状与
		// 其余五个事件不同,按 requestId 过滤的规则会把它整类漏掉 —— 迁移确实没有请求可关联,
		// 所以要的是「键在、值为 null」,不是「没这个键」。
		for (const entry of logged) {
			expect(entry).toHaveProperty('requestId');
			expect(entry.ts).toEqual(expect.any(String));
			expect(entry.migration).toBe('v3_2DB');
			expect(entry.reason).toBe('account_gate_failed');
		}
		expect(await illegalBindingCount()).toBe(0);
	});

	it('is idempotent across reruns: no duplicate Binding, stable revoked_at, untouched access_count', async () => {
		const ownerId = nextId();
		const liveAccountId = await insertAccount({ accountId: nextId(), userId: ownerId });
		const deadAccountId = await insertAccount({ accountId: nextId(), userId: ownerId, deleted: true });

		const legalShare = await insertLegacyShare({ userId: ownerId, accountId: liveAccountId, accessCount: 11 });
		const dirtyShare = await insertLegacyShare({ userId: ownerId, accountId: deadAccountId, accessCount: 12 });

		await dbInit.v3_2DB(c);
		const firstBinding = (await bindings(legalShare))[0];
		const firstRevoked = (await share(dirtyShare)).revoked_at;

		await dbInit.v3_2DB(c);
		await dbInit.v3_2DB(c);

		const afterBindings = await bindings(legalShare);
		expect(afterBindings).toHaveLength(1);
		expect(afterBindings[0].binding_id).toBe(firstBinding.binding_id);
		expect((await share(legalShare)).access_count).toBe(11);
		expect((await share(legalShare)).status).toBe('ACTIVE');

		const dirtyRow = await share(dirtyShare);
		expect(dirtyRow.status).toBe('REVOKED');
		expect(dirtyRow.revoked_at).toBe(firstRevoked);
		expect(dirtyRow.access_count).toBe(12);
		expect(await bindings(dirtyShare)).toHaveLength(0);
		expect(await illegalBindingCount()).toBe(0);
	});

	it('leaves already REVOKED rows alone', async () => {
		const ownerId = nextId();
		const accountId = await insertAccount({ accountId: nextId(), userId: ownerId });
		const shareId = await insertLegacyShare({ userId: ownerId, accountId, status: 'REVOKED' });

		await dbInit.v3_2DB(c);

		const row = await share(shareId);
		expect(row.status).toBe('REVOKED');
		expect(row.revoked_at).toBeNull();
	});
});

// R3-A2：无效行 UPDATE 只依据 account 事实，与「是否已有 Binding」解耦。
// 旧 Worker 的晚写可能落在迁移的任意时点，合法行绝不能被误置终态 REVOKED。
describe('v3_2DB interleaving with old-worker late writes (R3-A2 · AC-BIND-11)', () => {
	async function seedPair() {
		const ownerId = nextId();
		const liveAccountId = await insertAccount({ accountId: nextId(), userId: ownerId });
		const deadAccountId = await insertAccount({ accountId: nextId(), userId: ownerId, deleted: true });
		return { ownerId, liveAccountId, deadAccountId };
	}

	it('late write before the backfill INSERT: legal row gets its Binding, dirty row is revoked', async () => {
		const { ownerId, liveAccountId, deadAccountId } = await seedPair();
		const legalShare = await insertLegacyShare({ userId: ownerId, accountId: liveAccountId });
		const dirtyShare = await insertLegacyShare({ userId: ownerId, accountId: deadAccountId });

		await dbInit.backfillShareBindings(c);
		await dbInit.revokeInvalidShares(c);

		expect(await bindings(legalShare)).toHaveLength(1);
		expect((await share(legalShare)).status).toBe('ACTIVE');
		expect((await share(dirtyShare)).status).toBe('REVOKED');
		expect(await bindings(dirtyShare)).toHaveLength(0);
	});

	it('late write between INSERT and UPDATE: legal zero-Binding row stays ACTIVE and is adopted on rerun', async () => {
		const { ownerId, liveAccountId, deadAccountId } = await seedPair();

		await dbInit.backfillShareBindings(c);
		const legalShare = await insertLegacyShare({ userId: ownerId, accountId: liveAccountId, windowStartEmailId: 77 });
		const dirtyShare = await insertLegacyShare({ userId: ownerId, accountId: deadAccountId });
		await dbInit.revokeInvalidShares(c);

		const legalRow = await share(legalShare);
		expect(legalRow.status).toBe('ACTIVE');
		expect(legalRow.revoked_at).toBeNull();
		expect(await bindings(legalShare)).toHaveLength(0);
		expect((await share(dirtyShare)).status).toBe('REVOKED');

		await dbInit.backfillShareBindings(c);
		const adopted = await bindings(legalShare);
		expect(adopted).toHaveLength(1);
		expect(adopted[0].account_id).toBe(liveAccountId);
		expect(adopted[0].window_start_email_id).toBe(77);
		expect((await share(legalShare)).status).toBe('ACTIVE');
	});

	it('late write after the UPDATE: legal row untouched, adopted by the closing rerun', async () => {
		const { ownerId, liveAccountId, deadAccountId } = await seedPair();

		await dbInit.backfillShareBindings(c);
		await dbInit.revokeInvalidShares(c);

		const legalShare = await insertLegacyShare({ userId: ownerId, accountId: liveAccountId });
		const dirtyShare = await insertLegacyShare({ userId: ownerId, accountId: deadAccountId });

		expect((await share(legalShare)).status).toBe('ACTIVE');
		expect(await bindings(legalShare)).toHaveLength(0);

		await dbInit.backfillShareBindings(c);
		await dbInit.revokeInvalidShares(c);

		expect(await bindings(legalShare)).toHaveLength(1);
		expect((await share(legalShare)).status).toBe('ACTIVE');
		expect((await share(dirtyShare)).status).toBe('REVOKED');
		expect(await bindings(dirtyShare)).toHaveLength(0);
	});

	it('late write after a task restart: full v3_2DB rerun adopts it without revoking', async () => {
		const { ownerId, liveAccountId, deadAccountId } = await seedPair();

		await dbInit.v3_2DB(c);

		const legalShare = await insertLegacyShare({ userId: ownerId, accountId: liveAccountId, accessCount: 4 });
		const dirtyShare = await insertLegacyShare({ userId: ownerId, accountId: deadAccountId });

		await dbInit.v3_2DB(c);

		const legalRow = await share(legalShare);
		expect(legalRow.status).toBe('ACTIVE');
		expect(legalRow.revoked_at).toBeNull();
		expect(legalRow.access_count).toBe(4);
		expect(await bindings(legalShare)).toHaveLength(1);
		expect((await share(dirtyShare)).status).toBe('REVOKED');
		expect(await illegalBindingCount()).toBe(0);
	});

	it('an account deleted after its Binding was backfilled is revoked on the next run', async () => {
		const ownerId = nextId();
		const accountId = await insertAccount({ accountId: nextId(), userId: ownerId });
		const shareId = await insertLegacyShare({ userId: ownerId, accountId });

		await dbInit.v3_2DB(c);
		expect(await bindings(shareId)).toHaveLength(1);

		await env.db.prepare('UPDATE account SET is_del = ? WHERE account_id = ?')
			.bind(isDel.DELETE, accountId).run();

		await dbInit.v3_2DB(c);

		expect((await share(shareId)).status).toBe('REVOKED');
		expect((await share(shareId)).revoked_at).toBeTruthy();
	});
});
