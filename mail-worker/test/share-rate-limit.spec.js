import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import shareResult from '../src/model/share-result';
import worker from '../src/index.js';

const UNAVAILABLE = JSON.stringify(shareResult.fail('SHARE_UNAVAILABLE', 501));

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

afterEach(() => {
	delete env.SHARE_SESSION_RATE_LIMITER;
	delete env.SHARE_READ_RATE_LIMITER;
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
		const res = await postSession({ lid: 't26-never', sec: 'wrong', ip: '198.51.100.9' });
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
		const res = await postSession({ ip: '198.51.100.11' });
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
