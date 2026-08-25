import { describe, it, expect, vi } from 'vitest';
import { insertWithVerifyLinkFallback } from '../src/email/email.js';

// 决策卡 §3.3 第 2 条:v3_4DB 迁移由人工访问 init 端点触发,**不随部署自动执行**。
// 「迁移未跑 + 新代码已上」是真实可达的窗口,此时 email 表还没有 verify_link 列。
// 邮件本身比提取结果重要 —— 该窗口内必须丢掉提取结果保住邮件,而不是反过来。

const baseParams = () => ({ toEmail: 'user@example.com', code: '483920', verifyLink: 'https://example.com/verify' });

describe('摄取:新列写入失败不得阻断邮件入库(§3.3)', () => {
	it('正常情况下只写一次,verifyLink 原样带上', async () => {
		const insert = vi.fn(async () => ({ emailId: 1 }));
		const row = await insertWithVerifyLinkFallback(insert, baseParams());

		expect(row).toEqual({ emailId: 1 });
		expect(insert).toHaveBeenCalledTimes(1);
		expect(insert.mock.calls[0][0].verifyLink).toBe('https://example.com/verify');
	});

	it('verify_link 列不存在导致 INSERT 失败 → 丢掉提取结果重试一次,邮件仍然入库', async () => {
		const insert = vi.fn()
			.mockRejectedValueOnce(new Error('D1_ERROR: table email has no column named verify_link'))
			.mockResolvedValueOnce({ emailId: 2 });

		const row = await insertWithVerifyLinkFallback(insert, baseParams());

		expect(row).toEqual({ emailId: 2 });
		expect(insert).toHaveBeenCalledTimes(2);
		expect(insert.mock.calls[1][0]).not.toHaveProperty('verifyLink');
		// 邮件本体的字段一个都不能在降级里丢掉。
		expect(insert.mock.calls[1][0].code).toBe('483920');
		expect(insert.mock.calls[1][0].toEmail).toBe('user@example.com');
	});

	it('降级重试后仍然失败 → 如实抛出,不假装收信成功', async () => {
		const insert = vi.fn().mockRejectedValue(new Error('D1_ERROR: database is locked'));

		await expect(insertWithVerifyLinkFallback(insert, baseParams())).rejects.toThrow('database is locked');
		expect(insert).toHaveBeenCalledTimes(2);
	});

	it('没有 verifyLink 可丢时不重试,直接抛出(重试对它毫无意义)', async () => {
		const insert = vi.fn().mockRejectedValue(new Error('D1_ERROR: database is locked'));

		await expect(insertWithVerifyLinkFallback(insert, { toEmail: 'u@e.com', verifyLink: '' }))
			.rejects.toThrow('database is locked');
		expect(insert).toHaveBeenCalledTimes(1);
	});
});
