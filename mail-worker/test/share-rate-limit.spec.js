import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import shareResult from '../src/model/share-result';
import worker from '../src/index.js';
// 命名空间导入而不是具名导入:裸 Request 版限流入口还不存在时,具名导入会让整个文件
// 在链接阶段就崩掉(看起来像 import 写错了),namespace 让红色停在「这个函数还没有」上。
import * as shareRateLimit from '../src/security/share-rate-limit';
import { seedShareRow } from './setup.js';

const UNAVAILABLE = JSON.stringify(shareResult.fail('SHARE_UNAVAILABLE', 501));

let t26Seq = 0;

// P4 之后「无行」是裸 404 —— 要证明「限流器放行/坏掉时业务失败仍走 200 JSON 信封」,
// 就得用一条真实存在的活分享配错 sec,否则断言测到的是 gone 而不是业务层。
async function seedLiveLid() {
	t26Seq += 1;
	const row = await seedShareRow({
		lid: `t26-live-${Date.now()}-${t26Seq}`,
		userId: 926001,
		accountId: 926002
	});
	return row.lid;
}

function sessionRequest({ lid, sec, ip, xff } = {}) {
	const headers = {
		'content-type': 'application/json',
		'accept-language': 'en'
	};
	if (ip) {
		headers['CF-Connecting-IP'] = ip;
	}
	if (xff) {
		headers['X-Forwarded-For'] = xff;
	}
	return new Request('http://example.com/api/share/session', {
		method: 'POST',
		headers,
		body: JSON.stringify({ lid: lid || 't26-missing', sec: sec || 'nope' })
	});
}

async function postSession(init) {
	return worker.fetch(sessionRequest(init), env, {});
}

async function getMails({ ip, bearer } = {}) {
	const headers = { 'accept-language': 'en' };
	if (ip) {
		headers['CF-Connecting-IP'] = ip;
	}
	if (bearer) {
		headers.Authorization = `Bearer ${bearer}`;
	}
	return worker.fetch(new Request('http://example.com/api/share/mails', {
		method: 'GET',
		headers
	}), env, {});
}

afterEach(async () => {
	delete env.SHARE_SESSION_RATE_LIMITER;
	delete env.SHARE_READ_RATE_LIMITER;
	await env.db.prepare("DELETE FROM mail_share WHERE lid LIKE 't26-live-%'").run();
});

describe('T-26 anonymous share rate limit (AC-ABUSE-08, P-TRANS-01)', () => {
	it('returns HTTP 429 with Retry-After when the session limiter denies', async () => {
		env.SHARE_SESSION_RATE_LIMITER = {
			async limit() {
				return { success: false };
			}
		};
		const res = await postSession({ ip: '198.51.100.8' });
		expect(res.status).toBe(429);
		expect(res.headers.get('Retry-After')).toBe('60');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		const body = await res.json();
		expect(body.message).toBe('RATE_LIMITED');
		expect(body.code).toBe(429);
		expect(body.message).not.toBe('SHARE_UNAVAILABLE');
	});

	it('keeps ordinary SHARE_UNAVAILABLE as HTTP 200 when the limiter allows', async () => {
		env.SHARE_SESSION_RATE_LIMITER = {
			async limit() {
				return { success: true };
			}
		};
		const lid = await seedLiveLid();
		const res = await postSession({ lid, sec: 'wrong', ip: '198.51.100.9' });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(UNAVAILABLE);
	});

	it('keys the limiter on CF-Connecting-IP and ignores X-Forwarded-For and lid', async () => {
		const keys = [];
		env.SHARE_SESSION_RATE_LIMITER = {
			async limit({ key }) {
				keys.push(key);
				return { success: true };
			}
		};
		await postSession({
			lid: 'public-lid-aaa',
			sec: 'wrong',
			ip: '198.51.100.20',
			xff: '203.0.113.99, 192.0.2.1'
		});
		await postSession({
			lid: 'public-lid-bbb',
			sec: 'wrong',
			ip: '198.51.100.20',
			xff: '198.51.100.1'
		});
		expect(keys).toEqual(['198.51.100.20', '198.51.100.20']);
	});

	it('does not trust X-Forwarded-For when CF-Connecting-IP is absent', async () => {
		const keys = [];
		env.SHARE_SESSION_RATE_LIMITER = {
			async limit({ key }) {
				keys.push(key);
				return { success: true };
			}
		};
		await postSession({ xff: '203.0.113.99' });
		expect(keys).toEqual(['missing-cf-connecting-ip']);
	});

	it('fails open when the platform limiter throws so shares stay available', async () => {
		env.SHARE_SESSION_RATE_LIMITER = {
			async limit() {
				throw new Error('rate limiter backend unavailable');
			}
		};
		const lid = await seedLiveLid();
		const res = await postSession({ lid, sec: 'wrong', ip: '198.51.100.11' });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(UNAVAILABLE);
	});

	it('returns HTTP 429 with Retry-After when the read limiter denies GET /share/mails', async () => {
		env.SHARE_READ_RATE_LIMITER = {
			async limit() {
				return { success: false };
			}
		};
		const res = await getMails({ ip: '198.51.100.10', bearer: 'not-a-token' });
		expect(res.status).toBe(429);
		expect(res.headers.get('Retry-After')).toBe('60');
		const body = await res.json();
		expect(body.message).toBe('RATE_LIMITED');
		expect(body.message).not.toBe('SHARE_UNAVAILABLE');
	});

	it('leaves thrown errors as HTTP 200 via onError so 429 must be a returned Response', async () => {
		const res = await SELF.fetch('http://example.com/api/share/session', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'accept-language': 'en' },
			body: 'not-json'
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('Retry-After')).toBeNull();
	});
});

// 文档入口 /s/:lid 跑在 hono 之前,没有 context:key 只能从 Request headers 取,
// 429 只能是空 body —— 那条路径的成功态是「与浏览器原生错误页同貌」,塞一个 JSON
// 信封等于免费送给探测者一个「这里是分享系统」的指纹。
describe('T-26 share rate limit on a bare Request (no hono context)', () => {
	function goneRequest(ip) {
		const headers = {};
		if (ip !== undefined) {
			headers['CF-Connecting-IP'] = ip;
		}
		return new Request('http://example.com/s/t26-gone-lid', { headers });
	}

	it('denies with an empty-body 429 carrying Retry-After and no-store, never a JSON envelope', async () => {
		const denied = await shareRateLimit.enforceShareRateLimitOnRequest(
			goneRequest('198.51.100.30'),
			{ async limit() { return { success: false }; } },
			60
		);
		expect(denied).not.toBeNull();
		expect(denied.status).toBe(429);
		expect(denied.headers.get('Retry-After')).toBe('60');
		expect(denied.headers.get('Cache-Control')).toBe('no-store');
		expect(await denied.text()).toBe('');
	});

	it('keys the limiter on CF-Connecting-IP read straight off the request headers', async () => {
		const keys = [];
		await shareRateLimit.enforceShareRateLimitOnRequest(goneRequest('198.51.100.31'), {
			async limit({ key }) {
				keys.push(key);
				return { success: true };
			}
		}, 60);
		expect(keys).toEqual(['198.51.100.31']);
	});

	it('falls back to the missing-ip key when CF-Connecting-IP is absent or blank', async () => {
		const keys = [];
		const limiter = {
			async limit({ key }) {
				keys.push(key);
				return { success: true };
			}
		};
		await shareRateLimit.enforceShareRateLimitOnRequest(goneRequest(), limiter, 60);
		await shareRateLimit.enforceShareRateLimitOnRequest(goneRequest('   '), limiter, 60);
		expect(keys).toEqual(['missing-cf-connecting-ip', 'missing-cf-connecting-ip']);
	});

	it('lets the request through when no limiter is bound so vitest and a misconfigured deploy stay usable', async () => {
		expect(await shareRateLimit.enforceShareRateLimitOnRequest(goneRequest('198.51.100.32'), undefined, 60))
			.toBeNull();
	});

	it('lets the request through and reports when the platform limiter throws', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const out = await shareRateLimit.enforceShareRateLimitOnRequest(goneRequest('198.51.100.33'), {
				async limit() {
					throw new Error('rate limiter backend unavailable');
				}
			}, 60);
			expect(out).toBeNull();
			expect(errors).toHaveBeenCalled();
		} finally {
			errors.mockRestore();
		}
	});
});
