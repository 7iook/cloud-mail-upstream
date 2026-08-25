/*
 * T-20c · 分享凭据链路的护栏（决策卡 §1.4「安全护栏会自动让路」的补丁）
 *
 * 这个文件不测功能，测的是**别的测试拦不住的东西**。加密方案上线时，仓里既有的
 * 泄漏守卫（`databaseContains` / `assertSecAbsentFromDatabase`）全部是明文子串扫描，
 * 密文照过——也就是说把 `sec` 改成任何一种「看起来不是明文」的编码，全库扫描都绿。
 * 所以这里的四组断言各自补一个具体的洞：
 *
 * ① 鉴权表的 lockstep：`security.js` 的两张表与 API 里实际声明的路由必须三方一致。
 *    既有的 AC-ADMIN-10 比的是「API 路由 vs 测试自己的常量表」，`security.js` 两张表
 *    之间没有任何单点断言——漏登记一张，路由就静默失去 perm 门。
 * ② KEK fail-closed 不得降级成业务码：既有断言只匹配 `/kek/i`，把裸 Error 换成
 *    `BizError('SHARE_SEC_ABSENT')` 依然绿——而那正是「部署事故被伪装成存量不可恢复」。
 * ③ AuthKey 不可恢复：既有断言黑名单了两个列名、并在一处比对过明文。这里改成正向
 *    白名单 + 查**活表**（entity 对了不代表迁移 DDL 对），并做密文感知扫描。
 * ④ 密文感知的泄漏扫描：拿到整库但没有 KEK 时 `sec` 不可还原。这是本轮交出去的
 *    安全性质的边界，值得一条显式断言而不是口头承诺。
 *
 * 每一条都做过变异验证（破坏被保护的性质 → 确认变红），证据见
 * `.agent-workspace/.archive/2026-08-25/share-hardening/exec-t20c-guards.md`。
 */
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { isDel } from '../src/const/entity-const';
import { mailShare } from '../src/entity/mail-share.js';
import mailShareService from '../src/service/mail-share-service';
import { SEC_CIPHER_FAILURE, decryptShareSec } from '../src/security/share-sec-cipher';
import mailShareApiSource from '../src/api/mail-share-api.js?raw';
import mailShareServiceSource from '../src/service/mail-share-service.js?raw';
import securitySource from '../src/security/security.js?raw';

const USER_G = 909301;
const ACC_G = 909401;
const MAIL_G = 't20c-owner@example.com';
const PEPPER = 't20c-pepper-fixed-test-value';

function shareEnv(overrides = {}) {
	return {
		...env,
		SHARE_SEC_PEPPER: PEPPER,
		SHARE_SEC_PEPPER_KID: 'v2',
		SHARE_ENABLED: '1',
		SHARE_ACTIVE_LIMIT: '20',
		SHARE_MAX_DURATION_SECONDS: '86400',
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

// 三个密钥环，构成本文件的核心对照实验：
// 正确环能解开 ⇒ 扫描器确实盯在真的那一列上（否则下面两条是空过的）；
// 空环 / 错环解不开 ⇒ 保护来自密钥，而不是「格式看起来不像明文」。
const RIGHT_RING = () => shareEnv();
const NO_RING = () => shareEnv({ SHARE_SEC_KEK: undefined, SHARE_SEC_KEK_PREV: undefined });
// kid 与生产环一致、材料不同：让攻击者一路走到 GCM tag 校验，而不是提前被 UNKNOWN_KID 挡掉。
const WRONG_RING = () => shareEnv({
	SHARE_SEC_KEK: 't20c-attacker-guessed-kek', SHARE_SEC_KEK_PREV: undefined
});

async function seedOwner() {
	await env.db.prepare('DELETE FROM account WHERE account_id = ? OR email = ?').bind(ACC_G, MAIL_G).run();
	await env.db.prepare(`
		INSERT INTO account (account_id, email, name, user_id, is_del) VALUES (?, ?, ?, ?, ?)
	`).bind(ACC_G, MAIL_G, 't20c', USER_G, isDel.NORMAL).run();
}

async function cleanup() {
	await env.db.prepare(`
		DELETE FROM mail_share_binding
		WHERE share_id IN (SELECT share_id FROM mail_share WHERE user_id = ?)
	`).bind(USER_G).run();
	await env.db.prepare('DELETE FROM share_idempotency WHERE user_id = ?').bind(USER_G).run();
	await env.db.prepare('DELETE FROM mail_share WHERE user_id = ?').bind(USER_G).run();
	await env.db.prepare('DELETE FROM account WHERE account_id = ? OR email = ?').bind(ACC_G, MAIL_G).run();
}

afterEach(cleanup);

function createParams(overrides = {}) {
	return { accountId: ACC_G, durationSeconds: 3600, name: 't20c', remark: '', ...overrides };
}

async function createShare(overrides = {}) {
	await seedOwner();
	return mailShareService.create(ctx(), createParams(overrides), USER_G);
}

/*
 * 逐表 `SELECT *` 收全库的字符串值。这就是「攻击者拿到了整个 D1 导出」的形状：
 * 他不知道哪一列是什么，只有一堆字符串。所以扫描也不按列名走 —— 将来加一张表、
 * 加一列忘了脱敏，这里照样看得见。
 */
async function collectDatabaseStrings() {
	const tables = await env.db.prepare(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
	).all();
	const found = [];
	for (const table of tables.results || []) {
		const rows = await env.db.prepare(`SELECT * FROM "${table.name}"`).all();
		for (const row of rows.results || []) {
			for (const [column, value] of Object.entries(row)) {
				if (typeof value === 'string' && value) {
					found.push({ where: `${table.name}.${column}`, value });
				}
			}
		}
	}
	return found;
}

/*
 * 无密钥可逆编码扫描。这一条抓的不是加密被破解，而是加密被**换掉** —— 有人把
 * AES 信封换成 base64/hex 之类「看着不像明文」的东西时，明文子串扫描全绿，
 * 而它其实零保护。所以每个值都按三种无密钥编码试着还原一次。
 */
function keylessDecodings(value) {
	const out = [];
	const tryPush = (fn) => {
		try {
			const decoded = fn();
			if (decoded) {
				out.push(decoded);
			}
		} catch {
			// 解不开正是绝大多数值的常态，不是失败。
		}
	};
	tryPush(() => {
		let padded = value.replace(/-/g, '+').replace(/_/g, '/');
		while (padded.length % 4) {
			padded += '=';
		}
		return atob(padded);
	});
	tryPush(() => atob(value));
	tryPush(() => {
		if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2) {
			return null;
		}
		return value.replace(/../g, (byte) => String.fromCharCode(parseInt(byte, 16)));
	});
	return out;
}

// 只有 `v1:` 开头的值才可能是信封；其余的拿去 AES 解密纯属烧时间。
function envelopeCandidates(strings) {
	return strings.filter((item) => item.value.startsWith('v1:'));
}

async function opensToSecretUnder(ringEnv, strings, lids, secret) {
	for (const candidate of envelopeCandidates(strings)) {
		for (const lid of lids) {
			const opened = await decryptShareSec(ringEnv, { shareId: lid, envelope: candidate.value });
			if (opened.ok && opened.plaintext === secret) {
				return `${candidate.where} (lid=${lid})`;
			}
		}
	}
	return null;
}

function storesPlaintext(strings, secret) {
	for (const item of strings) {
		if (item.value.includes(secret)) {
			return `${item.where} (plaintext)`;
		}
		for (const decoded of keylessDecodings(item.value)) {
			if (decoded.includes(secret)) {
				return `${item.where} (keyless-decodable)`;
			}
		}
	}
	return null;
}

async function allLids() {
	const rows = await env.db.prepare('SELECT lid FROM mail_share').all();
	return (rows.results || []).map((row) => row.lid);
}

// ── 护栏 ① 鉴权表的 lockstep ─────────────────────────────────────────────────
const ROUTE_PATTERN = /app\.(get|post|put|delete|patch)\(\s*'(\/mailShare\/[^']+)'/g;

function declaredMailShareRoutes() {
	return [...mailShareApiSource.matchAll(ROUTE_PATTERN)].map(([, verb, path]) => `${verb.toUpperCase()} ${path}`);
}

function exactPermPaths() {
	return [...securitySource.matchAll(
		/\{\s*method:\s*'([A-Z]+)'\s*,\s*path:\s*'(\/mailShare\/[^']+)'\s*\}/g
	)].map(([, method, path]) => `${method} ${path}`);
}

function shareManagePaths() {
	const block = securitySource.match(/'share:manage':\s*\[([\s\S]*?)\]/);
	return [...(block ? block[1] : '').matchAll(/'(\/mailShare\/[^']+)'/g)].map(([, path]) => path);
}

describe('T-20c · the reveal endpoint cannot lose its auth gate', () => {
	it('keeps requirePermsExact, the share:manage grant list and the declared routes in lockstep', () => {
		const declared = declaredMailShareRoutes();
		const gated = exactPermPaths();
		const granted = shareManagePaths();

		// 一条都不许少：漏在 requirePermsExact 里 = 路由没有 perm 门；
		// 漏在 share:manage 里 = 持权者反而被锁在门外，运维只会把权限调大来绕过。
		expect(new Set(gated)).toEqual(new Set(declared));
		expect(new Set(granted)).toEqual(new Set(declared.map((route) => route.split(' ')[1])));
		expect(gated).toHaveLength(declared.length);
		expect(granted).toHaveLength(declared.length);
		// 解析真的解到了东西 —— 正则写错时上面三条会一起空过成 0 === 0。
		expect(declared).toContain('POST /mailShare/revealSec');
	});

	it('never hands the credential out through the ordinary owner read surface', async () => {
		const created = await createShare();
		const { authKey } = await mailShareService.resetAuthKey(
			v2ctx(), { shareId: created.shareId, action: 'enable' }, USER_G
		);

		const detail = JSON.stringify(await mailShareService.get(ctx(), { shareId: created.shareId }, USER_G));
		const list = JSON.stringify(await mailShareService.list(ctx(), {}, USER_G));
		for (const [surface, payload] of [['get', detail], ['list', list]]) {
			expect([surface, payload.includes(created.sec)]).toEqual([surface, false]);
			expect([surface, payload.includes(authKey)]).toEqual([surface, false]);
		}

		// 正对照：同一个针在 revealSec 的响应里**找得到**。少了这条，上面两条在
		// 「sec 拼错了」或「针本身是空串」的情况下会空过。
		const revealed = await mailShareService.revealSec(ctx(), { shareId: created.shareId }, USER_G);
		expect(JSON.stringify(revealed).includes(created.sec)).toBe(true);
		// 而 AuthKey 连这个端点也不交回 —— 它根本不在可逆范围内。
		expect(JSON.stringify(revealed).includes(authKey)).toBe(false);
	});
});

// ── 护栏 ② KEK fail-closed 不得被降级 ────────────────────────────────────────
describe('T-20c · a missing KEK stays a deployment fault, never a business outcome', () => {
	it('refuses to create with a non-business error, so no self-service code can absorb it', async () => {
		await seedOwner();
		const error = console.error;
		console.error = () => {};
		let caught;
		try {
			await mailShareService.create(
				ctx({ SHARE_SEC_KEK: undefined, SHARE_SEC_KEK_PREV: undefined }), createParams(), USER_G
			).catch((err) => { caught = err; });
		} finally {
			console.error = error;
		}

		expect(caught).toBeInstanceOf(Error);
		// 这是本条的全部意义：`rejects.toThrow(/kek/i)` 对 BizError 一样绿，而 BizError
		// 会被 `withShare` 翻成一条 200 + 业务码，管理员看到的是「这条分享有点问题」
		// 而不是「这次部署缺了密钥」。名字才是那条分界线。
		expect(caught.name).not.toBe('BizError');
		expect(caught.message).toMatch(/kek/i);
	});

	it('classifies every cipher failure reason explicitly, so a new one cannot default to benign', () => {
		const block = mailShareServiceSource.match(/const REVEAL_FAILURE = \{([\s\S]*?)\n\};/);
		expect(block).not.toBeNull();

		// 枚举从加密模块真取，不是抄一份常量：将来那边多一种失败原因，这条当场红，
		// 逼人回来决定它算事故还是良性 —— 而不是悄悄落进 `REVEAL_UNKNOWN_FAILURE`。
		const reasons = Object.keys(SEC_CIPHER_FAILURE);
		expect(reasons.length).toBeGreaterThan(0);
		for (const reason of reasons) {
			expect([reason, block[1].includes(`SEC_CIPHER_FAILURE.${reason}`)]).toEqual([reason, true]);
		}
		// KEK 缺失必须带告警，且不得与任何良性成因共用一个码。
		expect(block[1]).toMatch(/SEC_CIPHER_FAILURE\.KEK_MISSING\]:\s*\{\s*code:\s*'SHARE_SEC_UNAVAILABLE',\s*alert:\s*true\s*\}/);
		expect(block[1]).not.toMatch(/SEC_CIPHER_FAILURE\.KEK_MISSING\]:[^}]*alert:\s*false/);
	});
});

// ── 护栏 ③ AuthKey 仍不可恢复 ────────────────────────────────────────────────
const ALLOWED_AUTH_KEY_COLUMNS = ['auth_key_enabled', 'auth_key_hash', 'auth_key_kid'];

describe('T-20c · the AuthKey stays one-way', () => {
	it('allows exactly three auth-key columns, in the entity and in the live table', async () => {
		const entityColumns = Object.values(getTableColumns(mailShare))
			.map((col) => col.name)
			.filter((name) => /auth.?key/i.test(name));
		const live = await env.db.prepare('PRAGMA table_info("mail_share")').all();
		const liveColumns = (live.results || [])
			.map((row) => String(row.name))
			.filter((name) => /auth.?key/i.test(name));

		// 正向白名单而不是黑名单两个名字：`auth_key_cipher` 被挡住不代表
		// `auth_key_envelope` / `auth_key_recoverable` 被挡住。
		expect(entityColumns.sort()).toEqual([...ALLOWED_AUTH_KEY_COLUMNS].sort());
		// 活表单独查一遍：entity 是给 ORM 看的，迁移 DDL 才是库里真实的样子，
		// 只钉 entity 的话「迁移加了列但没同步 entity」这条缝是全开的。
		expect(liveColumns.sort()).toEqual([...ALLOWED_AUTH_KEY_COLUMNS].sort());
	});

	it('leaves no recoverable copy of the AuthKey anywhere in the database', async () => {
		const created = await createShare();
		const { authKey } = await mailShareService.resetAuthKey(
			v2ctx(), { shareId: created.shareId, action: 'enable' }, USER_G
		);

		const strings = await collectDatabaseStrings();
		const lids = await allLids();

		expect(storesPlaintext(strings, authKey)).toBeNull();
		// 密文感知：即使**持有 KEK**，库里也不该有任何一个信封解出 AuthKey ——
		// 这正是「将来有人顺手把 AuthKey 也加密了」会踩的那条线。
		expect(await opensToSecretUnder(RIGHT_RING(), strings, lids, authKey)).toBeNull();
		// 扫描器不是瞎的：同一次快照里 sec 的信封确实解得开（见护栏 ④ 的正对照）。
		expect(await opensToSecretUnder(RIGHT_RING(), strings, lids, created.sec)).not.toBeNull();
	});
});

// ── 护栏 ④ 密文感知的泄漏扫描 ───────────────────────────────────────────────
describe('T-20c · a whole-database dump without the KEK does not yield sec', () => {
	it('opens under the right ring and stays shut under no ring and a wrong ring', async () => {
		const created = await createShare();
		const strings = await collectDatabaseStrings();
		const lids = await allLids();

		// ① 正对照先行。没有它，下面两条「解不开」在扫描器根本没看到那一列时也成立。
		expect(await opensToSecretUnder(RIGHT_RING(), strings, lids, created.sec))
			.toMatch(/^mail_share\.sec_cipher/);

		// ② 攻击者拿到整库、没有 KEK：任何一列都还原不出 sec。
		expect(await opensToSecretUnder(NO_RING(), strings, lids, created.sec)).toBeNull();

		// ③ 攻击者拿到整库、KEK 猜错（kid 对、材料错，一路走到 GCM tag 校验）：同样还原不出。
		//   这一条把「保护来自密钥」和「保护来自格式」分开 —— 只有它红了才说明真的在解密。
		expect(await opensToSecretUnder(WRONG_RING(), strings, lids, created.sec)).toBeNull();

		// ④ 也不存在任何无密钥就能还原的旁路（明文 / base64 / base64url / hex）。
		//   既有的全库扫描只做到这一条的前半句。
		expect(storesPlaintext(strings, created.sec)).toBeNull();
	});

	it('keeps the same property across a regenerate, for both the old and the new sec', async () => {
		const created = await createShare();
		const rotated = await mailShareService.regenerate(ctx(), { shareId: created.shareId }, USER_G);

		const strings = await collectDatabaseStrings();
		const lids = await allLids();

		for (const [label, secret] of [['old', created.sec], ['new', rotated.sec]]) {
			expect([label, storesPlaintext(strings, secret)]).toEqual([label, null]);
			expect([label, await opensToSecretUnder(NO_RING(), strings, lids, secret)]).toEqual([label, null]);
			expect([label, await opensToSecretUnder(WRONG_RING(), strings, lids, secret)]).toEqual([label, null]);
		}
		// 轮换后只有新 sec 还解得回来；旧的连持钥人也取不到，那正是换链接的意义。
		expect(await opensToSecretUnder(RIGHT_RING(), strings, lids, rotated.sec)).not.toBeNull();
		expect(await opensToSecretUnder(RIGHT_RING(), strings, lids, created.sec)).toBeNull();
	});
});
