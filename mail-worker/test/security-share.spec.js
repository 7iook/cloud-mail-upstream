import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import jwtUtils from '../src/utils/jwt-utils';
import KvConst from '../src/const/kv-const';
import mailShareApiSource from '../src/api/mail-share-api.js?raw';
import shareApiSource from '../src/api/share-api.js?raw';

const OWNER_ENDPOINTS = [
	['POST', '/mailShare/create'],
	['GET', '/mailShare/list'],
	['GET', '/mailShare/get'],
	['PUT', '/mailShare/update'],
	['DELETE', '/mailShare/delete'],
	['PUT', '/mailShare/bindings'],
	['DELETE', '/mailShare/revoke'],
	['POST', '/mailShare/resetAuthKey']
];

const VISITOR_READ_PATHS = [
	'/share/mails',
	'/share/mail',
	'/share/attachment',
	'/share/mailboxes/status'
];

const ROUTE_PATTERN = /app\.(get|post|put|delete|patch)\(\s*'([^']+)'/g;

function routesIn(source, prefix) {
	return [...source.matchAll(ROUTE_PATTERN)]
		.map(([, verb, path]) => [verb.toUpperCase(), path])
		.filter(([, path]) => path.startsWith(prefix));
}

async function api(method, path, init = {}) {
	return SELF.fetch(`http://example.com/api${path}`, {
		method,
		headers: {
			'accept-language': 'en',
			...(init.headers || {})
		},
		body: init.body
	});
}

async function readBody(response) {
	const text = await response.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = null;
	}
	return { status: response.status, json, text };
}

function requireJwt(body) {
	expect(body.json?.code).toBe(401);
}

function notRequireJwt(body) {
	expect(body.json?.code).not.toBe(401);
}

// POST/PUT handlers read `c.req.json()` first; without a parsable body they throw a
// SyntaxError instead of a BizError, which muddies the "did the perm gate fire" signal.
async function ownerCall(method, path, token) {
	const headers = token ? { Authorization: token } : {};
	let body;
	if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
		headers['content-type'] = 'application/json';
		body = '{}';
	}
	return api(method, path, { headers, body });
}

async function seedUser(email, roleId) {
	await env.db.prepare(
		'INSERT INTO user (email, type, password, salt, status, is_del) VALUES (?, ?, ?, ?, 0, 0)'
	).bind(email, roleId, 'x', 'x').run();
	const row = await env.db.prepare('SELECT user_id FROM user WHERE email = ?').bind(email).first();
	return { userId: row.user_id, email };
}

async function jwtFor(user) {
	const token = crypto.randomUUID();
	const jwt = await jwtUtils.generateToken({ env }, { userId: user.userId, token });
	await env.kv.put(KvConst.AUTH_INFO + user.userId, JSON.stringify({
		tokens: [token],
		user,
		refreshTime: new Date().toISOString()
	}));
	return jwt;
}

let noShareJwt;
let hasShareJwt;
let visitorSessionToken;

// A real `s1.<kid>.<payload>.<sig>` token minted by the visitor handshake, so the
// cross-credential cases below test the shape the product actually issues.
async function mintVisitorSessionToken(ownerUser, ownerJwt) {
	const account = await env.db.prepare(`
		INSERT INTO account (email, name, user_id, is_del) VALUES (?, ?, ?, 0)
		RETURNING account_id
	`).bind('t17-visitor-mailbox@example.com', 't17', ownerUser.userId).first();
	const created = await readBody(await api('POST', '/mailShare/create', {
		headers: { Authorization: ownerJwt, 'content-type': 'application/json' },
		body: JSON.stringify({ accountId: account.account_id, durationSeconds: 3600 })
	}));
	const session = await readBody(await api('POST', '/share/session', {
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ lid: created.json.data.lid, sec: created.json.data.sec })
	}));
	return session.json.data.sessionToken;
}

beforeAll(async () => {
	await env.db.prepare(`
		INSERT OR IGNORE INTO perm (perm_id, name, perm_key, pid, type, sort)
		VALUES (37, 'share-manage', 'share:manage', 0, 2, 0)
	`).run();
	await env.db.prepare(`
		INSERT OR IGNORE INTO role (role_id, name, send_type, is_default)
		VALUES (99, 'no-share', 'count', 0)
	`).run();
	await env.db.prepare(`
		INSERT OR IGNORE INTO role (role_id, name, send_type, is_default)
		VALUES (98, 'share-only', 'count', 0)
	`).run();
	const bound = await env.db.prepare(
		'SELECT id FROM role_perm WHERE role_id = 98 AND perm_id = 37'
	).first();
	if (!bound) {
		await env.db.prepare('INSERT INTO role_perm (role_id, perm_id) VALUES (98, 37)').run();
	}
	const noShareUser = await seedUser('t05-noperm@example.com', 99);
	const hasShareUser = await seedUser('t05-hasperm@example.com', 98);
	noShareJwt = await jwtFor(noShareUser);
	hasShareJwt = await jwtFor(hasShareUser);
	visitorSessionToken = await mintVisitorSessionToken(hasShareUser, hasShareJwt);
});

describe('T-05 security share path auth', () => {
	describe('AC-LEAK-06 prefix must not bypass JWT', () => {
		it('GET /share-evil without JWT still requires JWT', async () => {
			requireJwt(await readBody(await api('GET', '/share-evil')));
		});

		it('GET /shareanything without JWT still requires JWT', async () => {
			requireJwt(await readBody(await api('GET', '/shareanything')));
		});

		it('GET /share/mailbox without JWT still requires JWT', async () => {
			requireJwt(await readBody(await api('GET', '/share/mailbox')));
		});

		it('GET /share/mails/extra without JWT still requires JWT', async () => {
			requireJwt(await readBody(await api('GET', '/share/mails/extra')));
		});

		// T-14 只加一条精确豁免，近似路径必须继续走 JWT（AC-SEC-03）。
		it.each([
			'/share/mailboxes/statusX',
			'/share/mailboxes/status/extra',
			'/share/mailboxes/statu',
			'/share/mailboxes',
			'/share/mailbox/status'
		])('GET %s without JWT still requires JWT', async (path) => {
			requireJwt(await readBody(await api('GET', path)));
		});
	});

	describe('visitor JWT exemption is exact method + path', () => {
		it.each([
			['POST', '/share/session'],
			['GET', '/share/mails'],
			['GET', '/share/mail'],
			['GET', '/share/attachment'],
			['GET', '/share/mailboxes/status']
		])('%s %s without JWT is not JWT-gated', async (method, path) => {
			notRequireJwt(await readBody(await api(method, path)));
		});

		it('GET /share/mails with query string is not JWT-gated', async () => {
			notRequireJwt(await readBody(await api('GET', '/share/mails?cursor=1&limit=20')));
		});

		it('GET /share/mailboxes/status with a cursor-shaped query string is not JWT-gated', async () => {
			notRequireJwt(await readBody(await api('GET', '/share/mailboxes/status?sinceEmailId=1&cursor=2')));
		});
	});

	describe('AC-VISIT-08 writes stay JWT-gated', () => {
		it.each([
			['POST', '/share/mails'],
			['DELETE', '/share/mail'],
			['PUT', '/share/session'],
			['GET', '/share/session'],
			['POST', '/share/mailboxes/status'],
			['DELETE', '/share/mailboxes/status'],
			['POST', '/mailShare/create'],
			['GET', '/mailShare/list'],
			['DELETE', '/mailShare/revoke']
		])('%s %s without JWT requires JWT', async (method, path) => {
			requireJwt(await readBody(await api(method, path)));
		});
	});

	describe('owner routes require JWT and share:manage', () => {
		it.each(OWNER_ENDPOINTS)('%s %s without JWT requires JWT', async (method, path) => {
			requireJwt(await readBody(await ownerCall(method, path)));
		});

		it.each(OWNER_ENDPOINTS)('%s %s without share:manage returns SHARE_FORBIDDEN', async (method, path) => {
			const body = await readBody(await ownerCall(method, path, noShareJwt));
			// 403 alone cannot tell the exact-perm branch apart from the prefix branch's
			// generic Unauthorized, so the message is part of the contract.
			expect(body.json?.code).toBe(403);
			expect(body.json?.message).toBe('SHARE_FORBIDDEN');
		});

		it.each(OWNER_ENDPOINTS)('%s %s with share:manage is not SHARE_FORBIDDEN', async (method, path) => {
			const body = await readBody(await ownerCall(method, path, hasShareJwt));
			// An unrouted path answers 404 with no JSON body, which would make both code
			// assertions vacuously true; pinning status 200 keeps the route's existence in scope.
			expect(body.status).toBe(200);
			expect(body.json?.code).not.toBe(403);
			expect(body.json?.code).not.toBe(401);
		});

		it('AC-ADMIN-10 every /mailShare route in the API surface is perm-gated here', () => {
			const declared = routesIn(mailShareApiSource, '/mailShare/').map(([method, path]) => `${method} ${path}`);
			const gated = OWNER_ENDPOINTS.map(([method, path]) => `${method} ${path}`);
			expect(new Set(declared)).toEqual(new Set(gated));
			expect(declared).toHaveLength(gated.length);
		});
	});

	describe('AC-SEC-02 owner and visitor credentials do not cross over', () => {
		it.each(OWNER_ENDPOINTS)('%s %s rejects a visitor session token at the JWT gate', async (method, path) => {
			const body = await readBody(await ownerCall(method, path, visitorSessionToken));
			// The share token is a 4-segment `s1.*` on its own signing ring, so it dies in
			// verifyToken long before the perm branch — 401, never SHARE_FORBIDDEN.
			expect(body.json?.code).toBe(401);
			expect(body.json?.message).toBe('Authentication has expired. Please sign in again');
		});

		it('the minted visitor token really is a share session token', () => {
			expect(String(visitorSessionToken).split('.')).toHaveLength(4);
			expect(String(visitorSessionToken).startsWith('s1.')).toBe(true);
		});

		it.each(VISITOR_READ_PATHS)('GET %s treats an owner JWT as no credential at all', async (path) => {
			const body = await readBody(await api('GET', path, { headers: { Authorization: hasShareJwt } }));
			expect(body.status).toBe(200);
			expect(body.json?.code).toBe(501);
			expect(body.json?.message).toBe('SHARE_UNAVAILABLE');
		});

		it('POST /share/session answers identically with and without an owner JWT', async () => {
			const payload = JSON.stringify({ lid: 't17-absent-lid', sec: 't17-absent-sec' });
			const withJwt = await readBody(await api('POST', '/share/session', {
				headers: { 'content-type': 'application/json', Authorization: hasShareJwt },
				body: payload
			}));
			const without = await readBody(await api('POST', '/share/session', {
				headers: { 'content-type': 'application/json' },
				body: payload
			}));
			expect(withJwt).toEqual(without);
		});

		it('the visitor surface imports none of the logged-in session machinery', () => {
			expect(shareApiSource).not.toContain('jwt-utils');
			expect(shareApiSource).not.toContain('userContext');
			expect(shareApiSource).not.toContain('TOKEN_HEADER');
		});

		it.each(VISITOR_READ_PATHS)('GET %s without any credential is closed, not open', async (path) => {
			const body = await readBody(await api('GET', path));
			expect(body.json?.code).toBe(501);
			expect(body.json?.message).toBe('SHARE_UNAVAILABLE');
		});
	});

	describe('AC-SEC-04 the visitor surface exposes no write endpoint', () => {
		it.each(VISITOR_READ_PATHS.flatMap((path) => ['POST', 'PUT', 'PATCH', 'DELETE'].map((method) => [method, path])))(
			'%s %s falls back to the JWT gate',
			async (method, path) => {
				requireJwt(await readBody(await ownerCall(method, path)));
			}
		);

		it.each([['GET'], ['PUT'], ['PATCH'], ['DELETE']])('%s /share/session falls back to the JWT gate', async (method) => {
			requireJwt(await readBody(await ownerCall(method, '/share/session')));
		});

		it('share-api.js declares exactly one non-GET route and it is the session handshake', () => {
			const nonGet = routesIn(shareApiSource, '/share').filter(([method]) => method !== 'GET');
			expect(nonGet).toEqual([['POST', '/share/session']]);
		});
	});

	describe('AC-SEC-10 the owner perm gate matches exactly, never by prefix', () => {
		const nearMisses = OWNER_ENDPOINTS.flatMap(([method, path]) => [
			[method, `${path}X`],
			[method, `${path}/extra`],
			[method, path.slice(0, -1)]
		]);

		it.each(nearMisses)('%s %s without JWT still requires JWT', async (method, path) => {
			requireJwt(await readBody(await ownerCall(method, path)));
		});

		it.each(nearMisses)('%s %s is unrouted rather than perm-gated', async (method, path) => {
			// 404 (not SHARE_FORBIDDEN) is the proof that /mailShare never entered the
			// prefix table: a prefix rule would pull these into the perm branch instead.
			expect((await readBody(await ownerCall(method, path, noShareJwt))).status).toBe(404);
		});

		it.each([
			['GET', '/MAILSHARE/list'],
			['GET', '/mailShare/list/'],
			['GET', '/mailShare/List']
		])('%s %s is not treated as GET /mailShare/list', async (method, path) => {
			expect((await readBody(await ownerCall(method, path, hasShareJwt))).status).toBe(404);
		});
	});

	describe('existing prefix routes keep prior auth behavior', () => {
		it('GET /oss/<key> without JWT is not JWT-gated', async () => {
			notRequireJwt(await readBody(await api('GET', '/oss/t05-regression-key')));
		});

		it('GET /oauth/<dynamic> without JWT is not JWT-gated', async () => {
			const body = await readBody(await api('GET', '/oauth/t05-regression-path'));
			notRequireJwt(body);
			expect(body.status).toBe(404);
		});

		it('GET /telegram/getEmail/<token> without JWT returns the prior denied page', async () => {
			const body = await readBody(await api('GET', '/telegram/getEmail/not-a-jwt'));
			notRequireJwt(body);
			expect(body.text).toContain('Access denied');
		});

		it('GET /init/<secret> without JWT still checks the init secret', async () => {
			const body = await readBody(await api('GET', '/init/not-the-secret'));
			notRequireJwt(body);
			expect(body.status).toBe(200);
			expect(body.text).toBe('\u274c JWT secret mismatch');
		});

		it('POST /public/genToken without JWT is not JWT-gated', async () => {
			const body = await readBody(await api('POST', '/public/genToken', {
				headers: { 'content-type': 'application/json' },
				body: '{}'
			}));
			notRequireJwt(body);
			expect(body.json?.code).not.toBe(401);
		});

		it('GET /setting/websiteConfig without JWT is not JWT-gated', async () => {
			notRequireJwt(await readBody(await api('GET', '/setting/websiteConfig')));
		});

		it('GET /setting/websiteConfigAnything without JWT requires JWT', async () => {
			requireJwt(await readBody(await api('GET', '/setting/websiteConfigAnything')));
		});
	});
});
