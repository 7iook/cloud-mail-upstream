// P4「销毁链接 = 浏览器原生 404」的机器判据,按 p4-destroyed-entrypoints.md 的入口清单逐条钉:
// 文档 GET/HEAD /s/:lid(#1/#2)、五个访客 API(#3-#7)、fail-open(DB 抖动不误伤活链接)。
// gone 的定义只有两种:无 mail_share 行,或 status='REVOKED'。EXPIRED 不是 gone ——
// 它仍交给 SPA 画「不再可用」页(AC-VISIT-04 拆分后的过期分支)。
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isDel } from '../src/const/entity-const';
import worker from '../src/index.js';
import {
	nativeGoneResponse,
	parseShareLidPath,
	shareDocumentIfGone
} from '../src/security/share-document-gone';
import { seedShareRow } from './setup';

const PEPPER = env.SHARE_SEC_PEPPER;
const OWNER_EMAIL = 'p4-owner@example.com';
const MAILBOX = 'p4-box@example.com';

let ownerId;
let accountId;
let seq = 0;

async function hmacHex(key, message) {
	const encoder = new TextEncoder();
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		encoder.encode(key),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

beforeAll(async () => {
	await env.db.prepare('DELETE FROM user WHERE email = ?').bind(OWNER_EMAIL).run();
	const user = await env.db.prepare(`
		INSERT INTO user (email, type, password, salt, status, is_del)
		VALUES (?, 1, 'x', 'x', 0, 0) RETURNING user_id
	`).bind(OWNER_EMAIL).first();
	ownerId = user.user_id;
	await env.db.prepare('DELETE FROM account WHERE email = ?').bind(MAILBOX).run();
	const account = await env.db.prepare(`
		INSERT INTO account (email, name, user_id, is_del)
		VALUES (?, 'p4', ?, ?) RETURNING account_id
	`).bind(MAILBOX, ownerId, isDel.NORMAL).first();
	accountId = account.account_id;
});

afterEach(async () => {
	delete env.SHARE_READ_RATE_LIMITER;
	await env.db.prepare("DELETE FROM mail_share WHERE lid LIKE 'p4-%'").run();
});

async function seedShare(overrides = {}) {
	seq += 1;
	const lid = `p4-lid-${Date.now()}-${seq}`;
	const sec = `p4-sec-${Date.now()}-${seq}`;
	const row = await seedShareRow({
		lid,
		secHmac: await hmacHex(PEPPER, sec),
		userId: ownerId,
		accountId,
		...overrides
	});
	return { ...row, sec };
}

async function establish(lid, sec) {
	const response = await SELF.fetch('http://example.com/api/share/session', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ lid, sec })
	});
	const body = await response.json();
	expect(body.code).toBe(200);
	return body.data.sessionToken;
}

describe('P4 · document GET|HEAD /s/:lid before assets', () => {
	it('answers a missing lid with a bare 404 and an empty body', async () => {
		const response = await SELF.fetch('http://example.com/s/p4-never-existed');
		expect(response.status).toBe(404);
		expect(await response.text()).toBe('');
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});

	it('answers uppercase /S/:lid the same as /s/:lid (SPA alias must not skip gone)', async () => {
		const response = await SELF.fetch('http://example.com/S/p4-never-existed');
		expect(response.status).toBe(404);
		expect(await response.text()).toBe('');
	});

	it('answers HEAD on a missing lid with 404', async () => {
		const response = await SELF.fetch('http://example.com/s/p4-never-existed', { method: 'HEAD' });
		expect(response.status).toBe(404);
		expect(await response.text()).toBe('');
	});

	it('answers a revoked lid with a bare 404, not the SPA', async () => {
		const share = await seedShare({ status: 'REVOKED', revokedAt: '2026-01-01 00:00:00' });
		const response = await SELF.fetch(`http://example.com/s/${share.lid}`);
		expect(response.status).toBe(404);
		expect(await response.text()).toBe('');
	});

	it('still hands an expired share to the SPA (EXPIRED is not gone)', async () => {
		const share = await seedShare({ expiresAt: '2020-01-01 00:00:00' });
		const response = await SELF.fetch(`http://example.com/s/${share.lid}`);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('<html');
	});

	it('hands a live share to the SPA untouched', async () => {
		const share = await seedShare();
		const response = await SELF.fetch(`http://example.com/s/${share.lid}`);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('<html');
	});
});

describe('P4 · shareDocumentIfGone unit contract', () => {
	it('parses exactly one path segment after /s/, decoding percent escapes', () => {
		expect(parseShareLidPath('/s/abc123')).toBe('abc123');
		expect(parseShareLidPath('/s/abc123/')).toBe('abc123');
		expect(parseShareLidPath('/s/%61bc')).toBe('abc');
		expect(parseShareLidPath('/s/')).toBe('');
		expect(parseShareLidPath('/s')).toBe('');
		expect(parseShareLidPath('/share/abc')).toBe('');
		expect(parseShareLidPath('/s/a/b')).toBe('');
		expect(parseShareLidPath('/S/abc123')).toBe('abc123');
		expect(parseShareLidPath('/S/abc123/')).toBe('abc123');
		expect(parseShareLidPath('/')).toBe('');
	});

	it('ships a no-store empty 404 as the gone shape', async () => {
		const response = nativeGoneResponse();
		expect(response.status).toBe(404);
		expect(await response.text()).toBe('');
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});

	// lid 就在 URL 路径里,所以「这一跳不许把 URL 交给第三方、不许进索引」是这条 404 的
	// 本职,不是装饰。反过来,任何「这是一条被销毁的分享」的自述头都会破坏同貌。
	it('keeps the referrer off the wire and the URL out of search indexes', async () => {
		const response = nativeGoneResponse();
		expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
		expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
	});

	it('never announces on the wire that the 404 came from a destroyed share', async () => {
		const response = await SELF.fetch('http://example.com/s/p4-never-existed');
		expect(response.status).toBe(404);
		expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
		expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
		expect(response.headers.get('X-CloudMail-Share-Gone')).toBeNull();
	});

	it('never touches the database for a non-GET/HEAD or non-/s/ request', async () => {
		const prepare = vi.fn(() => {
			throw new Error('must not be called');
		});
		const fakeEnv = { db: { prepare } };
		expect(await shareDocumentIfGone(new Request('http://x/s/abc', { method: 'POST' }), fakeEnv)).toBeNull();
		expect(await shareDocumentIfGone(new Request('http://x/other'), fakeEnv)).toBeNull();
		expect(prepare).not.toHaveBeenCalled();
	});

	// DB 抖动 fail-open:打成 404 的活链接比一次放行的 gone 链接贵得多。
	// 事件走既有 share.system.error 信封,复用同一条告警规则;reason 固定,不带 lid。
	it('fails open to the assets on a database error and logs share.system.error', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const fakeEnv = {
				db: {
					prepare() {
						throw new Error('d1 exploded');
					}
				}
			};
			const out = await shareDocumentIfGone(new Request('http://x/s/p4-any'), fakeEnv);
			expect(out).toBeNull();
			const events = log.mock.calls
				.map(([line]) => {
					try {
						return JSON.parse(line);
					} catch {
						return null;
					}
				})
				.filter((entry) => entry && entry.event === 'share.system.error');
			expect(events).toHaveLength(1);
			expect(events[0].reason).toBe('gone-check-failed');
			expect(JSON.stringify(events[0])).not.toContain('p4-any');
		} finally {
			log.mockRestore();
		}
	});
});

// 这条路径在 P4 之前是「免费的存在性预言机」:每次探测都换来一次 D1 查询,配额为零。
// 限流的目的是让 DB 不被高频探测打爆,所以它必须落在查询之前 —— 落在之后,DB 已经挨过打了。
describe('P4 · the /s/:lid document entry is rate limited', () => {
	it('answers a rate-limited probe with an empty 429 without ever querying the database', async () => {
		const prepare = vi.fn(() => {
			throw new Error('must not be called');
		});
		const response = await shareDocumentIfGone(new Request('http://x/s/p4-any'), {
			db: { prepare },
			SHARE_READ_RATE_LIMITER: {
				async limit() {
					return { success: false };
				}
			}
		});
		expect(response.status).toBe(429);
		expect(await response.text()).toBe('');
		expect(response.headers.get('Retry-After')).toBe('60');
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(prepare).not.toHaveBeenCalled();
	});

	it('serves that 429 at the document entry so a prober cannot walk /s/ for free', async () => {
		env.SHARE_READ_RATE_LIMITER = {
			async limit() {
				return { success: false };
			}
		};
		const response = await worker.fetch(new Request('http://example.com/s/p4-never-existed', {
			headers: { 'CF-Connecting-IP': '198.51.100.40' }
		}), env, {});
		expect(response.status).toBe(429);
		expect(await response.text()).toBe('');
	});

	it('still hands a live share to the SPA while the limiter allows', async () => {
		env.SHARE_READ_RATE_LIMITER = {
			async limit() {
				return { success: true };
			}
		};
		const share = await seedShare();
		const response = await worker.fetch(new Request(`http://example.com/s/${share.lid}`, {
			headers: { 'CF-Connecting-IP': '198.51.100.41' }
		}), env, {});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('<html');
	});

	it('spends no quota on requests that are not share documents', async () => {
		const keys = [];
		const fakeEnv = {
			SHARE_READ_RATE_LIMITER: {
				async limit({ key }) {
					keys.push(key);
					return { success: true };
				}
			}
		};
		expect(await shareDocumentIfGone(new Request('http://x/other'), fakeEnv)).toBeNull();
		expect(await shareDocumentIfGone(new Request('http://x/s/abc', { method: 'POST' }), fakeEnv)).toBeNull();
		expect(keys).toEqual([]);
	});
});

describe('P4 · visitor APIs answer gone with a bare 404', () => {
	it('POST /share/session on a missing lid → 404 empty body, whatever the sec says', async () => {
		const response = await SELF.fetch('http://example.com/api/share/session', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ lid: 'p4-never-existed', sec: 'anything' })
		});
		expect(response.status).toBe(404);
		expect(await response.text()).toBe('');
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});

	it('POST /share/session on a revoked lid → 404 even with the right sec', async () => {
		const share = await seedShare({ status: 'REVOKED', revokedAt: '2026-01-01 00:00:00' });
		const response = await SELF.fetch('http://example.com/api/share/session', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ lid: share.lid, sec: share.sec })
		});
		expect(response.status).toBe(404);
		expect(await response.text()).toBe('');
	});

	it('keeps EXPIRED and a wrong sec on the SHARE_UNAVAILABLE JSON envelope', async () => {
		const expired = await seedShare({ expiresAt: '2020-01-01 00:00:00' });
		const expiredResponse = await SELF.fetch('http://example.com/api/share/session', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ lid: expired.lid, sec: expired.sec })
		});
		expect(expiredResponse.status).toBe(200);
		expect((await expiredResponse.json()).message).toBe('SHARE_UNAVAILABLE');

		const live = await seedShare();
		const wrongSecResponse = await SELF.fetch('http://example.com/api/share/session', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ lid: live.lid, sec: 'wrong-sec' })
		});
		expect(wrongSecResponse.status).toBe(200);
		expect((await wrongSecResponse.json()).message).toBe('SHARE_UNAVAILABLE');
	});

	it('turns every open session dead with 404 once the share is revoked (#4-#7)', async () => {
		const share = await seedShare();
		const token = await establish(share.lid, share.sec);
		await env.db.prepare("UPDATE mail_share SET status = 'REVOKED' WHERE share_id = ?")
			.bind(share.shareId).run();

		for (const path of [
			'/api/share/mails',
			'/api/share/mailboxes/status',
			'/api/share/mail?mailId=1',
			'/api/share/attachment?mailId=1&attachmentId=1'
		]) {
			const response = await SELF.fetch(`http://example.com${path}`, {
				headers: { Authorization: `Bearer ${token}` }
			});
			expect(response.status, path).toBe(404);
			expect(await response.text(), path).toBe('');
		}

		const again = await SELF.fetch('http://example.com/api/share/session', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ lid: share.lid, sec: share.sec })
		});
		expect(again.status).toBe(404);
	});

	it('turns a deleted row into 404 for a still-valid session token', async () => {
		const share = await seedShare();
		const token = await establish(share.lid, share.sec);
		await env.db.prepare('DELETE FROM mail_share WHERE share_id = ?').bind(share.shareId).run();

		const response = await SELF.fetch('http://example.com/api/share/mails', {
			headers: { Authorization: `Bearer ${token}` }
		});
		expect(response.status).toBe(404);
		expect(await response.text()).toBe('');
	});

	it('keeps an expired share on the JSON envelope for an open session', async () => {
		const share = await seedShare();
		const token = await establish(share.lid, share.sec);
		await env.db.prepare("UPDATE mail_share SET expires_at = '2020-01-01 00:00:00' WHERE share_id = ?")
			.bind(share.shareId).run();

		const response = await SELF.fetch('http://example.com/api/share/mails', {
			headers: { Authorization: `Bearer ${token}` }
		});
		expect(response.status).toBe(200);
		expect((await response.json()).message).toBe('SHARE_UNAVAILABLE');
	});
});
