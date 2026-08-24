import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emailConst, isDel } from '../src/const/entity-const';
import shareScopedEmailRepository from '../src/service/share-scoped-email-repository';

// ShareContext 由用例自造（T-09 冻结形状），不经 resolveSession，也不读 mail_share.account_id。
// 权威形状：.agent-workspace/.archive/2026-08-24/mailbox-share-capability/share-context-freeze.md

const ACCOUNT_A = 900042;
const ACCOUNT_B = 900043;
const ACCOUNT_OUT = 900044; // 有邮件，但永不进任何 ctx.bindings
const ACCOUNT_EMPTY = 900045; // 进 bindings，但零邮件
const USER_ID = 900001;

const WINDOW_A = 900010;
const WINDOW_B = 900030;

const BINDING_A = 7001;
const BINDING_B = 7002;
const BINDING_EMPTY = 7003;
const BINDING_UNKNOWN = 7999;

const A = {
	first: 900011,
	second: 900012,
	third: 900013,
	arrived: 900014 // 只在最后一个用例插入
};

const B = {
	first: 900031,
	second: 900032,
	third: 900033
};

const POISON = {
	orphanAccountZero: 900020,
	belowWindowA: 900005,
	belowWindowB: 900029, // > WINDOW_A 但 < WINDOW_B：单一标量下界会漏它
	otherAccount: 900021,
	savingDeleted: 900022,
	savingNormal: 900023,
	userDeleted: 900024
};

const ALL_SEEDED_IDS = [
	...Object.values(A),
	...Object.values(B),
	...Object.values(POISON)
];

const c = { env };

function bindingA(windowStartEmailId = WINDOW_A) {
	return { bindingId: BINDING_A, accountId: ACCOUNT_A, windowStartEmailId };
}

function bindingB(windowStartEmailId = WINDOW_B) {
	return { bindingId: BINDING_B, accountId: ACCOUNT_B, windowStartEmailId };
}

/**
 * bindings 存在时 shim 默认由 bindings[0] 派生（与 buildShareContext 一致）；
 * 显式传 shim 用于「垫片与 bindings 冲突时以 bindings 为准」的负向用例。
 */
function context({ bindings = null, messageLimit = null, shim = null } = {}) {
	const ctx = {
		shareId: 900009,
		messageLimit,
		otpExtractionEnabled: true,
		showFullAddress: false,
		expiresAt: '2099-01-01 00:00:00',
		effectiveStatus: 'ACTIVE'
	};
	if (bindings) {
		ctx.bindings = bindings;
	}
	const head = shim || (bindings && bindings[0]);
	if (head) {
		ctx.accountId = head.accountId;
		ctx.windowStartEmailId = head.windowStartEmailId;
	}
	return ctx;
}

function ids(rows) {
	return rows.map((row) => row.emailId);
}

async function insertEmail({ emailId, accountId, isDelValue, status, subject }) {
	await env.db.prepare(`
		INSERT INTO email (email_id, account_id, user_id, subject, is_del, status, type, send_email)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		emailId,
		accountId,
		USER_ID,
		subject,
		isDelValue,
		status,
		emailConst.type.RECEIVE,
		't10-scope@example.com'
	).run();
}

async function insertVisible(emailId, accountId, subject) {
	await insertEmail({
		emailId,
		accountId,
		isDelValue: isDel.NORMAL,
		status: emailConst.status.RECEIVE,
		subject
	});
}

async function deleteSeeded() {
	const placeholders = ALL_SEEDED_IDS.map(() => '?').join(', ');
	await env.db.prepare(
		`DELETE FROM email WHERE email_id IN (${placeholders}) OR subject LIKE 't10-scope-%'`
	).bind(...ALL_SEEDED_IDS).run();
}

describe('shareScopedEmailRepository', () => {
	beforeAll(async () => {
		await deleteSeeded();
		await insertVisible(A.first, ACCOUNT_A, 't10-scope-a-1');
		await insertVisible(A.second, ACCOUNT_A, 't10-scope-a-2');
		await insertVisible(A.third, ACCOUNT_A, 't10-scope-a-3');
		await insertVisible(B.first, ACCOUNT_B, 't10-scope-b-1');
		await insertVisible(B.second, ACCOUNT_B, 't10-scope-b-2');
		await insertVisible(B.third, ACCOUNT_B, 't10-scope-b-3');
		await insertVisible(POISON.belowWindowA, ACCOUNT_A, 't10-scope-below-window-a');
		await insertVisible(POISON.belowWindowB, ACCOUNT_B, 't10-scope-below-window-b');
		await insertVisible(POISON.orphanAccountZero, 0, 't10-scope-orphan-account-0');
		await insertVisible(POISON.otherAccount, ACCOUNT_OUT, 't10-scope-other-account');
		await insertEmail({
			emailId: POISON.savingDeleted,
			accountId: ACCOUNT_A,
			isDelValue: isDel.DELETE,
			status: emailConst.status.SAVING,
			subject: 't10-scope-saving-deleted'
		});
		await insertEmail({
			emailId: POISON.savingNormal,
			accountId: ACCOUNT_A,
			isDelValue: isDel.NORMAL,
			status: emailConst.status.SAVING,
			subject: 't10-scope-saving-normal'
		});
		await insertEmail({
			emailId: POISON.userDeleted,
			accountId: ACCOUNT_A,
			isDelValue: isDel.DELETE,
			status: emailConst.status.RECEIVE,
			subject: 't10-scope-user-deleted'
		});
	});

	afterAll(async () => {
		await deleteSeeded();
	});

	it('only yields rows inside the binding set for every ctx/param combination (P-BIND-01)', async () => {
		const variants = [
			context({ bindings: [bindingA(), bindingB()] }),
			context({ bindings: [bindingA(), bindingB()], messageLimit: 1 }),
			context({ bindings: [bindingA(), bindingB()], messageLimit: 2 }),
			context({ bindings: [bindingA(0), bindingB(0)], messageLimit: 2 }),
			context({ bindings: [bindingA()] }),
			context({ bindings: [bindingB()], shim: { accountId: ACCOUNT_OUT, windowStartEmailId: 0 } }),
			context({ shim: { accountId: ACCOUNT_A, windowStartEmailId: WINDOW_A } })
		];
		const cursors = [null, A.third, 'not-a-number'];
		const limits = [undefined, 1, 100];

		for (const ctx of variants) {
			const scopes = ctx.bindings || [{ accountId: ctx.accountId, windowStartEmailId: ctx.windowStartEmailId }];
			const windows = new Map(scopes.map((scope) => [scope.accountId, scope.windowStartEmailId]));

			for (const cursor of cursors) {
				for (const limit of limits) {
					const rows = await shareScopedEmailRepository.list(c, ctx, cursor, limit);
					const rowIds = ids(rows);

					expect(rowIds).toEqual([...rowIds].sort((x, y) => y - x));
					expect(rows.length).toBeLessThanOrEqual(Math.min(50, limit == null ? 20 : limit));

					for (const row of rows) {
						expect(windows.has(row.accountId)).toBe(true);
						expect(row.emailId).toBeGreaterThan(windows.get(row.accountId));
						expect(row.accountId).toBeGreaterThan(0);
						expect(row.isDel).toBe(isDel.NORMAL);
						expect(row.status).not.toBe(emailConst.status.SAVING);
					}
				}
			}
		}
	});

	it('applies each binding its own lower bound instead of one shared scalar (AC-MAIL-02)', async () => {
		const ctx = context({ bindings: [bindingA(), bindingB()] });
		const rowIds = ids(await shareScopedEmailRepository.list(c, ctx, null, 50));

		expect(rowIds).toEqual([B.third, B.second, B.first, A.third, A.second, A.first]);
		expect(rowIds).not.toContain(POISON.belowWindowB);
		expect(rowIds).not.toContain(POISON.belowWindowA);
	});

	it('excludes orphan, mid-write, deleted and unbound-account rows (AC-MAIL-01 / AC-MAIL-06)', async () => {
		const ctx = context({ bindings: [bindingA(0), bindingB(0)] });
		const rowIds = ids(await shareScopedEmailRepository.list(c, ctx, null, 50));

		expect(rowIds).not.toContain(POISON.orphanAccountZero);
		expect(rowIds).not.toContain(POISON.otherAccount);
		expect(rowIds).not.toContain(POISON.savingDeleted);
		expect(rowIds).not.toContain(POISON.savingNormal);
		expect(rowIds).not.toContain(POISON.userDeleted);
		expect(rowIds).toEqual([
			B.third, B.second, B.first, POISON.belowWindowB,
			A.third, A.second, A.first, POISON.belowWindowA
		]);
	});

	it('truncates each mailbox to its own latest N in DESC order (AC-MAIL-03 / P-SCOPE-03)', async () => {
		const two = context({ bindings: [bindingA(), bindingB()], messageLimit: 2 });
		expect(ids(await shareScopedEmailRepository.list(c, two, null, 50)))
			.toEqual([B.third, B.second, A.third, A.second]);

		const one = context({ bindings: [bindingA(), bindingB()], messageLimit: 1 });
		expect(ids(await shareScopedEmailRepository.list(c, one, null, 50)))
			.toEqual([B.third, A.third]);
	});

	it('keeps the N truncation when the window lower bound is 0 (AC-MAIL-09)', async () => {
		const ctx = context({ bindings: [bindingA(0), bindingB(0)], messageLimit: 2 });
		expect(ids(await shareScopedEmailRepository.list(c, ctx, null, 50)))
			.toEqual([B.third, B.second, A.third, A.second]);
	});

	it('returns an empty array for a binding with zero mail (AC-EDGE-07)', async () => {
		const ctx = context({
			bindings: [{ bindingId: BINDING_EMPTY, accountId: ACCOUNT_EMPTY, windowStartEmailId: 0 }]
		});
		expect(await shareScopedEmailRepository.list(c, ctx, null, 50)).toEqual([]);
		expect(await shareScopedEmailRepository.listForBinding(c, ctx, BINDING_EMPTY, null, 50)).toEqual([]);
	});

	it('listForBinding scopes to one binding and leaks nothing for unknown bindingIds', async () => {
		const ctx = context({ bindings: [bindingA(), bindingB()] });

		expect(ids(await shareScopedEmailRepository.listForBinding(c, ctx, BINDING_A, null, 50)))
			.toEqual([A.third, A.second, A.first]);
		expect(ids(await shareScopedEmailRepository.listForBinding(c, ctx, BINDING_B, null, 50)))
			.toEqual([B.third, B.second, B.first]);

		for (const bindingId of [BINDING_UNKNOWN, BINDING_EMPTY, null, undefined, 0, -1, 'x', {}]) {
			expect(await shareScopedEmailRepository.listForBinding(c, ctx, bindingId, null, 50)).toEqual([]);
		}
		expect(await shareScopedEmailRepository.listForBinding(c, null, BINDING_A, null, 50)).toEqual([]);
	});

	it('listForBinding caps rows at min(limit, 50, messageLimit) (AC-EDGE-06)', async () => {
		const ctx = context({ bindings: [bindingA(), bindingB()], messageLimit: 1 });
		expect(ids(await shareScopedEmailRepository.listForBinding(c, ctx, BINDING_A, null, 50)))
			.toEqual([A.third]);

		const unbounded = context({ bindings: [bindingA()] });
		expect(ids(await shareScopedEmailRepository.listForBinding(c, unbounded, BINDING_A, null, 2)))
			.toEqual([A.third, A.second]);
	});

	it('refuses to retrieve rows when ctx is missing or accountId is 0', async () => {
		for (const ctx of [
			null,
			undefined,
			{},
			context({ shim: { accountId: 0, windowStartEmailId: WINDOW_A } }),
			context({ bindings: [{ bindingId: BINDING_A, accountId: 0, windowStartEmailId: 0 }] })
		]) {
			expect(await shareScopedEmailRepository.list(c, ctx, null, 100)).toEqual([]);
			expect(await shareScopedEmailRepository.getById(c, ctx, A.first)).toBeNull();
			expect(await shareScopedEmailRepository.getById(c, ctx, POISON.orphanAccountZero)).toBeNull();
		}
	});

	it('ignores the deprecated shim when bindings is non-empty', async () => {
		const ctx = context({
			bindings: [bindingB()],
			shim: { accountId: ACCOUNT_A, windowStartEmailId: WINDOW_A }
		});

		expect(ids(await shareScopedEmailRepository.list(c, ctx, null, 50)))
			.toEqual([B.third, B.second, B.first]);
		expect(await shareScopedEmailRepository.getById(c, ctx, A.first)).toBeNull();
	});

	it('honours the shim as a single scope when bindings is absent or empty', async () => {
		for (const ctx of [
			context({ shim: { accountId: ACCOUNT_A, windowStartEmailId: WINDOW_A } }),
			{ ...context({ shim: { accountId: ACCOUNT_A, windowStartEmailId: WINDOW_A } }), bindings: [] }
		]) {
			expect(ids(await shareScopedEmailRepository.list(c, ctx, null, 50)))
				.toEqual([A.third, A.second, A.first]);
			expect(await shareScopedEmailRepository.getById(c, ctx, A.first)).toMatchObject({
				emailId: A.first,
				accountId: ACCOUNT_A
			});
			expect(await shareScopedEmailRepository.getById(c, ctx, B.first)).toBeNull();
		}
	});

	it('getById honours window, binding set and the latest-N truncation (AC-MAIL-05 / AC-VISIT-09)', async () => {
		const ctx = context({ bindings: [bindingA(), bindingB()] });

		expect(await shareScopedEmailRepository.getById(c, ctx, A.first)).toMatchObject({
			emailId: A.first,
			accountId: ACCOUNT_A
		});
		expect(await shareScopedEmailRepository.getById(c, ctx, B.third)).toMatchObject({
			emailId: B.third,
			accountId: ACCOUNT_B
		});

		for (const mailId of [
			POISON.orphanAccountZero,
			POISON.belowWindowA,
			POISON.belowWindowB,
			POISON.otherAccount,
			POISON.savingDeleted,
			POISON.savingNormal,
			POISON.userDeleted,
			999999,
			0,
			-1,
			null,
			'x'
		]) {
			expect(await shareScopedEmailRepository.getById(c, ctx, mailId)).toBeNull();
		}

		const truncated = context({ bindings: [bindingA(), bindingB()], messageLimit: 1 });
		expect(await shareScopedEmailRepository.getById(c, truncated, A.third)).toMatchObject({ emailId: A.third });
		expect(await shareScopedEmailRepository.getById(c, truncated, A.second)).toBeNull();
		expect(await shareScopedEmailRepository.getById(c, truncated, A.first)).toBeNull();
		expect(await shareScopedEmailRepository.getById(c, truncated, B.third)).toMatchObject({ emailId: B.third });
		expect(await shareScopedEmailRepository.getById(c, truncated, B.first)).toBeNull();
	});

	it('pages strictly older than the cursor and stays stable when new mail arrives (AC-RT-09)', async () => {
		const ctx = context({ bindings: [bindingA()] });

		const first = await shareScopedEmailRepository.list(c, ctx, A.third, 50);
		expect(ids(first)).toEqual([A.second, A.first]);
		expect(ids(await shareScopedEmailRepository.list(c, ctx, A.third, 50))).toEqual(ids(first));

		await insertVisible(A.arrived, ACCOUNT_A, 't10-scope-a-4');

		expect(ids(await shareScopedEmailRepository.list(c, ctx, A.third, 50))).toEqual([A.second, A.first]);
		expect(ids(await shareScopedEmailRepository.list(c, ctx, null, 50)))
			.toEqual([A.arrived, A.third, A.second, A.first]);

		let cursor = null;
		const walked = [];
		for (let i = 0; i < 8; i++) {
			const page = await shareScopedEmailRepository.list(c, ctx, cursor, 1);
			if (page.length === 0) {
				break;
			}
			expect(page).toHaveLength(1);
			if (cursor != null) {
				expect(page[0].emailId).toBeLessThan(cursor);
			}
			walked.push(page[0].emailId);
			cursor = page[0].emailId;
		}
		expect(walked).toEqual([A.arrived, A.third, A.second, A.first]);
		expect(new Set(walked).size).toBe(walked.length);

		// N 滚动：新邮件到达后最旧一封滚出可见集（AC-MAIL-04）
		const rolling = context({ bindings: [bindingA()], messageLimit: 3 });
		expect(ids(await shareScopedEmailRepository.list(c, rolling, null, 50)))
			.toEqual([A.arrived, A.third, A.second]);
		expect(await shareScopedEmailRepository.getById(c, rolling, A.first)).toBeNull();
	});

	// ── T-14 · 每 Binding 水位（status 端点的唯一读者）──────────────────────────
	// isolatedStorage 每条用例回滚一次，所以上一条插入的 A.arrived 在这里已不存在：
	// A 的可见最新一封恒为 A.third。

	it('latestByBinding reports the newest visible mail of every binding (AC-OTP-09)', async () => {
		const ctx = context({ bindings: [bindingA(), bindingB()] });

		expect(await shareScopedEmailRepository.latestByBinding(c, ctx)).toEqual([
			{ bindingId: BINDING_A, latestEmailId: A.third, latestReceivedAt: expect.any(String) },
			{ bindingId: BINDING_B, latestEmailId: B.third, latestReceivedAt: expect.any(String) }
		]);
	});

	it('latestByBinding returns null for a binding with zero visible mail (AC-EDGE-07)', async () => {
		const empty = { bindingId: BINDING_EMPTY, accountId: ACCOUNT_EMPTY, windowStartEmailId: 0 };

		expect(await shareScopedEmailRepository.latestByBinding(c, context({ bindings: [empty] })))
			.toEqual([{ bindingId: BINDING_EMPTY, latestEmailId: null, latestReceivedAt: null }]);
		expect(await shareScopedEmailRepository.latestByBinding(c, context({
			bindings: [bindingA(), empty, bindingB()]
		}))).toEqual([
			{ bindingId: BINDING_A, latestEmailId: A.third, latestReceivedAt: expect.any(String) },
			{ bindingId: BINDING_EMPTY, latestEmailId: null, latestReceivedAt: null },
			{ bindingId: BINDING_B, latestEmailId: B.third, latestReceivedAt: expect.any(String) }
		]);
	});

	it('latestByBinding never lets excluded mail move the watermark (AC-SEC-03)', async () => {
		// 900022/900023/900024 的 email_id 都大于 A.third，若过滤条件漏一条水位立刻穿帮。
		expect(POISON.savingNormal).toBeGreaterThan(A.third);
		expect(POISON.userDeleted).toBeGreaterThan(A.third);

		const inWindow = await shareScopedEmailRepository.latestByBinding(c, context({
			bindings: [bindingA(), bindingB()]
		}));
		expect(inWindow.map((item) => item.latestEmailId)).toEqual([A.third, B.third]);

		// 窗口下界抬到最新一封之上：窗口外与被排除的邮件都不得把水位顶起来。
		expect(await shareScopedEmailRepository.latestByBinding(c, context({
			bindings: [bindingA(A.third), bindingB(B.third)]
		}))).toEqual([
			{ bindingId: BINDING_A, latestEmailId: null, latestReceivedAt: null },
			{ bindingId: BINDING_B, latestEmailId: null, latestReceivedAt: null }
		]);

		// account_id=0 与不在 bindings 里的邮箱同样不产生水位。
		expect(await shareScopedEmailRepository.latestByBinding(c, context({
			bindings: [{ bindingId: BINDING_A, accountId: 0, windowStartEmailId: 0 }]
		}))).toEqual([]);
	});

	it('latestByBinding stays inside the same latest-N truncation as list (AC-MAIL-03)', async () => {
		for (const messageLimit of [1, 2, 3]) {
			const ctx = context({ bindings: [bindingA(), bindingB()], messageLimit });
			const rows = await shareScopedEmailRepository.list(c, ctx, null, 50);
			const expected = new Map();
			for (const row of rows) {
				if (!expected.has(row.accountId)) {
					expected.set(row.accountId, row.emailId);
				}
			}
			expect(await shareScopedEmailRepository.latestByBinding(c, ctx)).toEqual([
				{
					bindingId: BINDING_A,
					latestEmailId: expected.get(ACCOUNT_A),
					latestReceivedAt: expect.any(String)
				},
				{
					bindingId: BINDING_B,
					latestEmailId: expected.get(ACCOUNT_B),
					latestReceivedAt: expect.any(String)
				}
			]);
		}
	});

	it('latestByBinding pairs latestReceivedAt with the row that owns the watermark', async () => {
		const ctx = context({ bindings: [bindingA(), bindingB()] });
		const [a, b] = await shareScopedEmailRepository.latestByBinding(c, ctx);

		expect(a.latestReceivedAt).toBe(
			(await shareScopedEmailRepository.getById(c, ctx, a.latestEmailId)).createTime
		);
		expect(b.latestReceivedAt).toBe(
			(await shareScopedEmailRepository.getById(c, ctx, b.latestEmailId)).createTime
		);
	});

	it('latestByBinding keeps the legacy bindingId 0 and refuses an unusable ctx', async () => {
		expect(await shareScopedEmailRepository.latestByBinding(c, context({
			bindings: [{ bindingId: 0, accountId: ACCOUNT_A, windowStartEmailId: WINDOW_A }]
		}))).toEqual([
			{ bindingId: 0, latestEmailId: A.third, latestReceivedAt: expect.any(String) }
		]);

		for (const ctx of [null, undefined, {}, context({ bindings: [] })]) {
			expect(await shareScopedEmailRepository.latestByBinding(c, ctx)).toEqual([]);
		}
	});

	// ponytail：水位是一条 SQL，不是「每个 Binding 查一次」。
	it('latestByBinding costs exactly one query regardless of the binding count', async () => {
		const many = [
			bindingA(),
			bindingB(),
			{ bindingId: BINDING_EMPTY, accountId: ACCOUNT_EMPTY, windowStartEmailId: 0 }
		];
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
				const value = Reflect.get(target, prop);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});

		const rows = await shareScopedEmailRepository.latestByBinding({ env: { ...env, db } }, context({
			bindings: many
		}));

		expect(rows).toHaveLength(many.length);
		expect(seen).toHaveLength(1);
	});
});
