import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { isDel } from '../src/const/entity-const';
import KvConst from '../src/const/kv-const';
import mailShareService from '../src/service/mail-share-service';
import accountService from '../src/service/account-service';
import { PROVISION_DENIED, ProvisionDenied, configuredDomains, planMailboxProvision } from '../src/service/mailbox-provision';

// share-fullchain P2:向导只说完整地址(不预注册),V2=false 批量分流成 N 条单分享。
// 所有写入进同一个 D1 batch;建号不变量单一真源在 mailbox-provision.js。

const PEPPER = 'p2-pepper-fixed-test-value';
const USER_A = 909201;
const USER_B = 909202;
const ROLE_TIGHT = 909301;
const MAIL_OWNER_A = 'p2-owner-a@example.com';
const MAIL_OWNER_B = 'p2-owner-b@example.com';

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

function v2ctx(overrides = {}) {
	return ctx({ SHARE_CAPABILITY_V2: 'true', ...overrides });
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

async function seedUser({ userId, email, type = 1 }) {
	await env.db.prepare('DELETE FROM user WHERE user_id = ? OR email = ?').bind(userId, email).run();
	await env.db.prepare(`
		INSERT INTO user (user_id, email, type, password, salt, status, is_del)
		VALUES (?, ?, ?, 'p2-hash', 'p2-salt', 0, ${isDel.NORMAL})
	`).bind(userId, email, type).run();
}

async function seedAccount({ email, userId, del = isDel.NORMAL }) {
	await env.db.prepare('DELETE FROM account WHERE email = ?').bind(email).run();
	const row = await env.db.prepare(`
		INSERT INTO account (email, name, user_id, is_del)
		VALUES (?, 'p2', ?, ?)
		RETURNING account_id
	`).bind(email, userId, del).first();
	return row.account_id;
}

async function seedOwner() {
	await seedUser({ userId: USER_A, email: MAIL_OWNER_A });
	return seedAccount({ email: MAIL_OWNER_A, userId: USER_A });
}

async function accountRows(like) {
	const rows = await env.db.prepare('SELECT account_id, email, user_id, is_del FROM account WHERE email LIKE ?')
		.bind(like).all();
	return rows.results || [];
}

async function shareRows(userId) {
	const rows = await env.db.prepare('SELECT * FROM mail_share WHERE user_id = ? ORDER BY share_id ASC')
		.bind(userId).all();
	return rows.results || [];
}

async function bindingsOf(shareId) {
	const rows = await env.db.prepare(`
		SELECT binding_id, account_id FROM mail_share_binding WHERE share_id = ? ORDER BY binding_id ASC
	`).bind(shareId).all();
	return rows.results || [];
}

async function readSetting() {
	return env.kv.get(KvConst.SETTING, { type: 'json' });
}

async function patchSetting(patch) {
	const current = await readSetting();
	await env.kv.put(KvConst.SETTING, JSON.stringify({ ...current, ...patch }));
	return current;
}

async function restoreSetting(saved) {
	await env.kv.put(KvConst.SETTING, JSON.stringify(saved));
}

// 只数 db.batch 的调用次数;语句原样透传底层 D1。
function batchProbe(overrides = {}) {
	const calls = [];
	const db = new Proxy(env.db, {
		get(target, prop) {
			if (prop === 'batch') {
				return async (statements) => {
					calls.push(statements.length);
					if (overrides.beforeBatch) {
						await overrides.beforeBatch(calls.length);
					}
					return target.batch(statements);
				};
			}
			const value = target[prop];
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
	return { calls, db };
}

async function cleanup() {
	await env.db.prepare(`
		DELETE FROM mail_share_binding
		WHERE share_id IN (SELECT share_id FROM mail_share WHERE user_id IN (?, ?))
	`).bind(USER_A, USER_B).run();
	await env.db.prepare('DELETE FROM share_idempotency WHERE user_id IN (?, ?)').bind(USER_A, USER_B).run();
	await env.db.prepare('DELETE FROM mail_share WHERE user_id IN (?, ?)').bind(USER_A, USER_B).run();
	await env.db.prepare('DELETE FROM account WHERE email LIKE ?').bind('p2-%').run();
	await env.db.prepare('DELETE FROM user WHERE user_id IN (?, ?)').bind(USER_A, USER_B).run();
	await env.db.prepare('DELETE FROM role WHERE role_id = ?').bind(ROLE_TIGHT).run();
}

afterEach(async () => {
	await cleanup();
});

function createParams(overrides = {}) {
	return {
		durationSeconds: 3600,
		name: 'by email',
		remark: '',
		...overrides
	};
}

describe('mailShareService.create with emails[] (P2)', () => {
	it('provisions an unregistered full address and shares it in one request (V2=false)', async () => {
		await seedOwner();
		const created = await mailShareService.create(ctx(), createParams({
			emails: ['p2-fresh@example.com']
		}), USER_A);

		expect(created.lid).toEqual(expect.any(String));
		expect(created.sec).toEqual(expect.any(String));
		expect(created.shareUrl).toBe(`https://mail.example.com/s/${created.lid}#${created.sec}`);
		expect(created.shareType).toBe('single');
		expect(created.mailbox).toBe('p2-fresh@example.com');

		const accounts = await accountRows('p2-fresh@%');
		expect(accounts.length).toBe(1);
		expect(accounts[0].user_id).toBe(USER_A);
		expect(accounts[0].is_del).toBe(isDel.NORMAL);

		const bindings = await bindingsOf(created.shareId);
		expect(bindings.length).toBe(1);
		expect(bindings[0].account_id).toBe(accounts[0].account_id);

		const share = await env.db.prepare('SELECT account_id FROM mail_share WHERE share_id = ?')
			.bind(created.shareId).first();
		expect(share.account_id).toBe(accounts[0].account_id);
	});

	it('reuses the caller-owned account instead of erroring or double-provisioning', async () => {
		const accountId = await seedOwner();
		const created = await mailShareService.create(ctx(), createParams({
			emails: [MAIL_OWNER_A]
		}), USER_A);

		const accounts = await accountRows('p2-owner-a@%');
		expect(accounts.length).toBe(1);
		const bindings = await bindingsOf(created.shareId);
		expect(bindings.map((row) => row.account_id)).toEqual([accountId]);
	});

	it('normalizes case/whitespace and dedupes before anything else', async () => {
		await seedOwner();
		const created = await mailShareService.create(ctx(), createParams({
			emails: ['  P2-Fresh@Example.com ', 'p2-fresh@example.com']
		}), USER_A);
		// 去重后只剩一枚地址 → 单对象响应,不是 shares[]。
		expect(created.shares).toBeUndefined();
		expect(created.mailbox).toBe('p2-fresh@example.com');
		expect((await accountRows('p2-fresh@%')).length).toBe(1);
	});

	it('splits a V2=false batch into N single shares in one db.batch, never a multi binding', async () => {
		await seedOwner();
		const probe = batchProbe();
		const created = await mailShareService.create({ env: shareEnv({ db: probe.db }) }, createParams({
			emails: ['p2-batch-a@example.com', 'p2-batch-b@example.com'],
			idempotencyKey: 'p2-batch-key'
		}), USER_A);

		expect(probe.calls.length).toBe(1);
		expect(Array.isArray(created.shares)).toBe(true);
		expect(created.shares.length).toBe(2);
		const lids = new Set(created.shares.map((share) => share.lid));
		expect(lids.size).toBe(2);
		for (const share of created.shares) {
			expect(share.sec).toEqual(expect.any(String));
			expect(share.shareUrl).toContain(`/s/${share.lid}#`);
			expect(share.shareType).toBe('single');
			const bindings = await bindingsOf(share.shareId);
			expect(bindings.length).toBe(1);
		}
		expect(created.shares.map((share) => share.mailbox))
			.toEqual(['p2-batch-a@example.com', 'p2-batch-b@example.com']);
		expect((await shareRows(USER_A)).length).toBe(2);
	});

	it('creates one multi share when V2 is on and multiple emails arrive (AC-LIFE-11)', async () => {
		await seedOwner();
		const created = await mailShareService.create(v2ctx(), createParams({
			emails: ['p2-multi-a@example.com', 'p2-multi-b@example.com']
		}), USER_A);

		expect(created.shares).toBeUndefined();
		expect(created.shareType).toBe('multi');
		const bindings = await bindingsOf(created.shareId);
		expect(bindings.length).toBe(2);
		expect((await shareRows(USER_A)).length).toBe(1);
	});

	it('rejects an unconfigured domain with SHARE_DOMAIN_NOT_CONFIGURED and zero writes', async () => {
		await seedOwner();
		const message = await catchBiz(mailShareService.create(ctx(), createParams({
			emails: ['p2-good@example.com', 'p2-bad@not-configured.org']
		}), USER_A));
		expect(message).toBe('SHARE_DOMAIN_NOT_CONFIGURED');
		expect((await shareRows(USER_A)).length).toBe(0);
		// 整单失败:同批的合法地址也一只都不建号。
		expect((await accountRows('p2-good@%')).length).toBe(0);
		expect((await accountRows('p2-bad@%')).length).toBe(0);
	});

	it('rejects a malformed address with SHARE_EMAIL_INVALID and zero writes', async () => {
		await seedOwner();
		const message = await catchBiz(mailShareService.create(ctx(), createParams({
			emails: ['not-an-email']
		}), USER_A));
		expect(message).toBe('SHARE_EMAIL_INVALID');
		expect((await shareRows(USER_A)).length).toBe(0);
	});

	it('refuses an address owned by another user with SHARE_ACCOUNT_FORBIDDEN', async () => {
		await seedOwner();
		await seedUser({ userId: USER_B, email: MAIL_OWNER_B });
		await seedAccount({ email: MAIL_OWNER_B, userId: USER_B });
		const message = await catchBiz(mailShareService.create(ctx(), createParams({
			emails: [MAIL_OWNER_B]
		}), USER_A));
		expect(message).toBe('SHARE_ACCOUNT_FORBIDDEN');
		expect((await shareRows(USER_A)).length).toBe(0);
	});

	it('refuses a soft-deleted address with SHARE_ACCOUNT_FORBIDDEN', async () => {
		await seedOwner();
		await seedAccount({ email: 'p2-dead@example.com', userId: USER_A, del: isDel.DELETE });
		const message = await catchBiz(mailShareService.create(ctx(), createParams({
			emails: ['p2-dead@example.com']
		}), USER_A));
		expect(message).toBe('SHARE_ACCOUNT_FORBIDDEN');
		expect((await shareRows(USER_A)).length).toBe(0);
	});

	it('enforces the settings-page prefix rules on the share entry too (single invariant source)', async () => {
		await seedOwner();
		const saved = await patchSetting({ minEmailPrefix: 5, emailPrefixFilter: 'spam' });
		try {
			const tooShort = await catchBiz(mailShareService.create(ctx(), createParams({
				emails: ['p2xx@example.com']
			}), USER_A));
			expect(tooShort).toBe('SHARE_EMAIL_INVALID');
			const banned = await catchBiz(mailShareService.create(ctx(), createParams({
				emails: ['p2-spam-inbox@example.com']
			}), USER_A));
			expect(banned).toBe('SHARE_EMAIL_INVALID');
			expect((await shareRows(USER_A)).length).toBe(0);
		} finally {
			await restoreSetting(saved);
		}
	});

	it('enforces role account quota when the address needs provisioning', async () => {
		await seedOwner();
		await env.db.prepare(`
			INSERT INTO role (role_id, name, send_type, account_count, avail_domain, ban_email)
			VALUES (?, 'p2-tight', 'ban', 1, '', '')
		`).bind(ROLE_TIGHT).run();
		await env.db.prepare('UPDATE user SET type = ? WHERE user_id = ?').bind(ROLE_TIGHT, USER_A).run();

		// 已占 1/1 配额;分享已注册地址仍可(不建号),新地址被拒。
		const reuse = await mailShareService.create(ctx(), createParams({ emails: [MAIL_OWNER_A] }), USER_A);
		expect(reuse.shareId).toEqual(expect.any(Number));
		const message = await catchBiz(mailShareService.create(ctx(), createParams({
			emails: ['p2-over-quota@example.com']
		}), USER_A));
		expect(message).toBe('SHARE_ACCOUNT_FORBIDDEN');
		expect((await accountRows('p2-over-quota@%')).length).toBe(0);
	});

	it('enforces the role avail-domain whitelist when provisioning', async () => {
		await seedOwner();
		await env.db.prepare(`
			INSERT INTO role (role_id, name, send_type, account_count, avail_domain, ban_email)
			VALUES (?, 'p2-tight', 'ban', 0, 'elsewhere.com', '')
		`).bind(ROLE_TIGHT).run();
		await env.db.prepare('UPDATE user SET type = ? WHERE user_id = ?').bind(ROLE_TIGHT, USER_A).run();

		const message = await catchBiz(mailShareService.create(ctx(), createParams({
			emails: ['p2-not-allowed@example.com']
		}), USER_A));
		expect(message).toBe('SHARE_ACCOUNT_FORBIDDEN');
		expect((await accountRows('p2-not-allowed@%')).length).toBe(0);
	});

	it('refuses to provision when the owner has no role row (fail-closed)', async () => {
		await seedUser({ userId: USER_A, email: MAIL_OWNER_A, type: 909999 });
		try {
			await planMailboxProvision({ env: shareEnv() }, {
				emails: ['p2-norole@example.com'],
				userId: USER_A
			});
			throw new Error('expected ProvisionDenied');
		} catch (err) {
			expect(err).toBeInstanceOf(ProvisionDenied);
			expect(err.reason).toBe(PROVISION_DENIED.QUOTA_EXCEEDED);
		}
		const message = await catchBiz(mailShareService.create(ctx(), createParams({
			emails: ['p2-norole@example.com']
		}), USER_A));
		expect(message).toBe('SHARE_ACCOUNT_FORBIDDEN');
		expect((await accountRows('p2-norole@%')).length).toBe(0);
	});

	it('replays a V2=false batch as shares[] without any plaintext sec', async () => {
		await seedOwner();
		const params = createParams({
			emails: ['p2-replay-a@example.com', 'p2-replay-b@example.com'],
			idempotencyKey: 'p2-replay-key'
		});
		const first = await mailShareService.create(ctx(), params, USER_A);
		const replay = await mailShareService.create(ctx(), params, USER_A);

		expect(replay.idempotentReplay).toBe(true);
		expect(Array.isArray(replay.shares)).toBe(true);
		expect(replay.shares.length).toBe(2);
		expect(new Set(replay.shares.map((share) => share.lid)))
			.toEqual(new Set(first.shares.map((share) => share.lid)));
		for (const share of replay.shares) {
			expect(share.sec).toBeUndefined();
			expect(share.shareUrl).toBeUndefined();
		}
		expect((await shareRows(USER_A)).length).toBe(2);
	});

	it('does not treat a truncated batch as an idempotent replay', async () => {
		await seedOwner();
		const params = createParams({
			emails: ['p2-partial-a@example.com', 'p2-partial-b@example.com'],
			idempotencyKey: 'p2-partial-replay-key'
		});
		const first = await mailShareService.create(ctx(), params, USER_A);
		const dropped = first.shares[1].lid;
		await env.db.prepare('DELETE FROM mail_share_binding WHERE share_id IN (SELECT share_id FROM mail_share WHERE lid = ?)').bind(dropped).run();
		await env.db.prepare('DELETE FROM mail_share WHERE lid = ?').bind(dropped).run();

		const message = await catchBiz(mailShareService.create(ctx(), params, USER_A));
		expect(message).toBe('SHARE_NOT_FOUND');
	});

	it('keeps an empty emails array out of the fingerprint (rolling-deploy compat)', async () => {
		const accountId = await seedOwner();
		const created = await mailShareService.create(ctx(), {
			accountId,
			durationSeconds: 3600,
			name: 'legacy',
			remark: '',
			emails: [],
			idempotencyKey: 'p2-empty-emails-key'
		}, USER_A);
		expect(created.sec).toEqual(expect.any(String));

		// 同一把钥匙、去掉 emails 键 —— 必须重放,不许 CONFLICT。
		const replay = await mailShareService.create(ctx(), {
			accountId,
			durationSeconds: 3600,
			name: 'legacy',
			remark: '',
			idempotencyKey: 'p2-empty-emails-key'
		}, USER_A);
		expect(replay.idempotentReplay).toBe(true);
		expect(replay.shareId).toBe(created.shareId);
	});

	it('lets a default-config single email replay against the accountId shape it resolves to', async () => {
		const accountId = await seedOwner();
		const first = await mailShareService.create(ctx(), {
			accountId,
			durationSeconds: 3600,
			name: 'same intent',
			remark: '',
			idempotencyKey: 'p2-bridge-key'
		}, USER_A);
		const replay = await mailShareService.create(ctx(), {
			emails: [MAIL_OWNER_A],
			durationSeconds: 3600,
			name: 'same intent',
			remark: '',
			idempotencyKey: 'p2-bridge-key'
		}, USER_A);
		expect(replay.idempotentReplay).toBe(true);
		expect(replay.shareId).toBe(first.shareId);
		expect((await shareRows(USER_A)).length).toBe(1);
	});

	it('retries the whole batch once after a UNIQUE race and reuses the row the winner left (own)', async () => {
		await seedOwner();
		let competitorId = 0;
		const probe = batchProbe({
			async beforeBatch(call) {
				if (call === 1) {
					// 模拟并发方在预校验之后、batch 之前抢注同一地址(属当前用户)。
					competitorId = await seedAccount({ email: 'p2-race@example.com', userId: USER_A });
					throw new Error('UNIQUE constraint failed: account.email');
				}
			}
		});
		const created = await mailShareService.create({ env: shareEnv({ db: probe.db }) }, createParams({
			emails: ['p2-race@example.com']
		}), USER_A);

		expect(probe.calls.length).toBe(2);
		const bindings = await bindingsOf(created.shareId);
		expect(bindings.map((row) => row.account_id)).toEqual([competitorId]);
		expect((await accountRows('p2-race@%')).length).toBe(1);
	});

	it('turns the retry into SHARE_ACCOUNT_FORBIDDEN when the race winner is another user', async () => {
		await seedOwner();
		await seedUser({ userId: USER_B, email: MAIL_OWNER_B });
		const probe = batchProbe({
			async beforeBatch(call) {
				if (call === 1) {
					await seedAccount({ email: 'p2-race-lost@example.com', userId: USER_B });
					throw new Error('UNIQUE constraint failed: account.email');
				}
			}
		});
		const message = await catchBiz(mailShareService.create({ env: shareEnv({ db: probe.db }) }, createParams({
			emails: ['p2-race-lost@example.com']
		}), USER_A));
		expect(message).toBe('SHARE_ACCOUNT_FORBIDDEN');
		expect((await shareRows(USER_A)).length).toBe(0);
	});

	it('still fences AuthKey / quotas behind V2 for the emails path (single share included)', async () => {
		await seedOwner();
		const message = await catchBiz(mailShareService.create(ctx(), createParams({
			emails: ['p2-gated@example.com'],
			authKeyEnabled: true
		}), USER_A));
		expect(message).toBe('SHARE_CAPABILITY_NOT_ENABLED');
		expect((await accountRows('p2-gated@%')).length).toBe(0);
	});

	it('keeps the legacy accountId payload working unchanged (AC-CAP-10)', async () => {
		const accountId = await seedOwner();
		const created = await mailShareService.create(ctx(), {
			accountId,
			durationSeconds: 3600,
			name: 'sharedialog',
			remark: ''
		}, USER_A);
		expect(created.sec).toEqual(expect.any(String));
		expect(created.shareType).toBe('single');
	});
});

describe('accountService.add wired through mailbox-provision (P2 SSOT)', () => {
	it('creates the account via the provision module and keeps the legacy response shape', async () => {
		await seedUser({ userId: USER_A, email: MAIL_OWNER_A });
		const row = await accountService.add({ env: shareEnv() }, { email: 'p2-added@example.com' }, USER_A);
		expect(row.accountId).toEqual(expect.any(Number));
		expect(row.email).toBe('p2-added@example.com');
		expect(row.name).toBe('p2-added');
		expect(row.userId).toBe(USER_A);
		expect(row.addVerifyOpen).toBe(false);
	});

	it('keeps the settings-page vocabulary for duplicates and unknown domains', async () => {
		await seedUser({ userId: USER_A, email: MAIL_OWNER_A });
		await seedAccount({ email: MAIL_OWNER_A, userId: USER_A });
		const dup = await catchBiz(accountService.add({ env: shareEnv() }, { email: MAIL_OWNER_A }, USER_A));
		expect(dup.length).toBeGreaterThan(0);
		const unknown = await catchBiz(accountService.add({ env: shareEnv() }, { email: 'p2-x@not-configured.org' }, USER_A));
		expect(unknown.length).toBeGreaterThan(0);
		expect(dup).not.toBe(unknown);
		expect((await accountRows('p2-x@%')).length).toBe(0);
	});
});

describe('configuredDomains (P2 domain SSOT)', () => {
	it('parses a JSON-string domain var instead of substring matching', () => {
		const c = { env: { domain: '["Example.com","other.io"]' } };
		expect(configuredDomains(c)).toEqual(['example.com', 'other.io']);
	});

	it('passes an actual array through, lowercased', () => {
		const c = { env: { domain: ['EXAMPLE.com'] } };
		expect(configuredDomains(c)).toEqual(['example.com']);
	});

	it('never lets a substring of the JSON text pass as a configured domain', async () => {
		await seedUser({ userId: USER_A, email: MAIL_OWNER_A });
		// 'xample.co' 是 '["example.com"]' 的子串 —— 子串匹配会放行,精确匹配必须拒。
		const message = await catchBiz(mailShareService.create(ctx({ domain: '["example.com"]' }), createParams({
			emails: ['p2-sub@xample.co']
		}), USER_A));
		expect(message).toBe('SHARE_DOMAIN_NOT_CONFIGURED');
	});

	it('denies with machine reasons the two entries can map independently', async () => {
		await seedUser({ userId: USER_A, email: MAIL_OWNER_A });
		try {
			await planMailboxProvision({ env: shareEnv() }, { emails: ['bad'], userId: USER_A });
			throw new Error('expected ProvisionDenied');
		} catch (err) {
			expect(err).toBeInstanceOf(ProvisionDenied);
			expect(err.reason).toBe(PROVISION_DENIED.EMAIL_INVALID);
		}
	});
});
