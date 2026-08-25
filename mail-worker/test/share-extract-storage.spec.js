import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { dbInit } from '../src/init/init.js';
import email from '../src/entity/email.js';
import setting from '../src/entity/setting.js';
import { settingConst } from '../src/const/entity-const.js';
import settingService from '../src/service/setting-service.js';
import shareMailService from '../src/service/share-mail-service.js';

const c = { env };

async function columnInfo(table) {
	const rows = await env.db.prepare(`SELECT * FROM pragma_table_info('${table}')`).all();
	return Object.fromEntries((rows.results || []).map((r) => [r.name, r]));
}

// v3_4DB:提取管线的链接字段。迁移由人工访问 `GET /api/init/{jwt_secret}` 触发,
// 每次升级都会再点一次同一个链接,所以「重复跑」是常态路径而不是假想场景。
describe('v3_4DB DDL (决策卡 §3.3 · expand-only)', () => {
	it('adds email.verify_link with the same shape as the existing code column', async () => {
		const cols = await columnInfo('email');

		expect(cols.verify_link).toBeTruthy();
		expect(cols.verify_link.type.toUpperCase()).toBe('TEXT');
		expect(cols.verify_link.notnull).toBe(1);
		// 空串 = 无,与 `code` 同形;null 会让消费侧多出一个「不知道」的第三态。
		expect(cols.verify_link.dflt_value).toBe(`''`);
		expect(cols.code.notnull).toBe(1);
		expect(cols.code.dflt_value).toBe(`''`);
	});

	it('is idempotent: reruns neither throw nor duplicate the column', async () => {
		const before = await columnInfo('email');
		const beforeNames = Object.keys(before);

		await dbInit.v3_4DB(c);
		await dbInit.v3_4DB(c);

		const after = await columnInfo('email');
		expect(Object.keys(after)).toEqual(beforeNames);
		expect(after.verify_link.cid).toBe(before.verify_link.cid);
	});

	it('is registered in init() so a real upgrade actually runs it', async () => {
		const source = await import('../src/init/init.js?raw');
		expect(source.default).toContain('await this.v3_4DB(c);');
	});
});

describe('email drizzle entity (W-1 组装 params 时读这个驼峰名)', () => {
	it('maps verifyLink to verify_link, notNull, defaulting to empty string', () => {
		const cols = getTableColumns(email);
		expect(cols.verifyLink).toBeTruthy();
		expect(cols.verifyLink.name).toBe('verify_link');
		expect(cols.verifyLink.notNull).toBe(true);
		expect(cols.verifyLink.default).toBe('');
	});
});

describe('setting.ai_code 三态 (决策卡 §1.7)', () => {
	function settingStub(overrides = {}) {
		return { resendTokens: {}, ...overrides };
	}

	function fakeContext(stub) {
		return {
			env,
			get: () => stub,
			set: () => {}
		};
	}

	it('keeps the legacy numeric values so an existing row keeps its meaning', () => {
		expect(settingConst.aiCode.OPEN).toBe(0);
		expect(settingConst.aiCode.CLOSE).toBe(1);
		expect(settingConst.aiCode.RULE_ONLY).toBe(2);
	});

	it('keeps CLOSE as the column default so no existing deployment silently opts in', async () => {
		expect(getTableColumns(setting).aiCode.default).toBe(settingConst.aiCode.CLOSE);
		const cols = await columnInfo('setting');
		expect(cols.ai_code.dflt_value).toBe(String(settingConst.aiCode.CLOSE));
		expect(cols.ai_code.notnull).toBe(1);
	});

	it('rejects a value outside the three states', async () => {
		for (const aiCode of [3, -1, 1.5, 'abc', null, true, {}, []]) {
			await expect(
				settingService.set(fakeContext(settingStub()), { aiCode })
			).rejects.toThrow();
		}
	});

	it('persists each of the three states', async () => {
		for (const aiCode of [
			settingConst.aiCode.OPEN,
			settingConst.aiCode.RULE_ONLY,
			settingConst.aiCode.CLOSE
		]) {
			await settingService.set(fakeContext(settingStub()), { aiCode });
			const row = await env.db.prepare('SELECT ai_code FROM setting').first();
			expect(row.ai_code).toBe(aiCode);
		}
	});
});

// 投影是字段改名的唯一发生地(决策卡 §3.2 第 5 跳):列 `verify_link` → DTO `link`。
describe('shareMailService.project link 门控 (决策卡 §4「投影」)', () => {
	const UNIT_ACCOUNT = 42;

	function ctx(otpExtractionEnabled) {
		return {
			shareId: 911009,
			bindings: [{ bindingId: 8001, accountId: UNIT_ACCOUNT, windowStartEmailId: 0 }],
			messageLimit: null,
			otpExtractionEnabled,
			showFullAddress: false,
			expiresAt: '2099-01-01 00:00:00',
			effectiveStatus: 'ACTIVE'
		};
	}

	function row(overrides = {}) {
		return {
			emailId: 11,
			accountId: UNIT_ACCOUNT,
			userId: 7,
			subject: 'Your code',
			code: '847291',
			verifyLink: 'https://verify.example/confirm?t=abc',
			text: 'body',
			content: '<p>body</p>',
			createTime: '2026-08-25 01:00:00',
			...overrides
		};
	}

	function project(emailRow, enabled) {
		return shareMailService.project(emailRow, [], ctx(enabled), new Map([[UNIT_ACCOUNT, 'inbox@example.com']]));
	}

	it('omits both keys entirely when the switch is off — a null placeholder would still advertise the slot', () => {
		const dto = project(row(), false);
		expect('link' in dto).toBe(false);
		expect('code' in dto).toBe(false);
		expect(JSON.stringify(dto)).not.toContain('verify.example');
	});

	it('exposes link verbatim under the DTO name `link` when the switch is on', () => {
		const dto = project(row(), true);
		expect('link' in dto).toBe(true);
		expect(dto.link).toBe('https://verify.example/confirm?t=abc');
		expect(dto.code).toBe('847291');
		// 改名只发生在这一层:管线内部与 DB 列各用各的名字,不得泄漏到 DTO。
		expect('verifyLink' in dto).toBe(false);
		expect('verify_link' in dto).toBe(false);
	});

	it('keeps an empty link as an empty string rather than inventing null', () => {
		const dto = project(row({ verifyLink: '' }), true);
		expect('link' in dto).toBe(true);
		expect(dto.link).toBe('');
	});

	it('does not derive a link from the body when the column is empty', () => {
		const dto = project(row({
			verifyLink: '',
			text: 'click https://guess.example/verify to continue',
			content: '<a href="https://guess.example/verify">verify</a>'
		}), true);
		expect(dto.link).toBe('');
	});

	it('gates on strict true, exactly like code', () => {
		for (const enabled of [undefined, null, 1, 0, 'true', '']) {
			const dto = project(row(), enabled);
			expect('link' in dto).toBe(false);
			expect('code' in dto).toBe(false);
		}
	});
});
