import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import jwtUtils from '../src/utils/jwt-utils';
import KvConst from '../src/const/kv-const';

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
		it('POST /mailShare/create without share:manage returns SHARE_FORBIDDEN', async () => {
			const body = await readBody(await api('POST', '/mailShare/create', {
				headers: { Authorization: noShareJwt }
			}));
			expect(body.json?.code).toBe(403);
			expect(body.json?.message).toBe('SHARE_FORBIDDEN');
		});

		it('GET /mailShare/list without share:manage returns SHARE_FORBIDDEN', async () => {
			const body = await readBody(await api('GET', '/mailShare/list', {
				headers: { Authorization: noShareJwt }
			}));
			expect(body.json?.code).toBe(403);
			expect(body.json?.message).toBe('SHARE_FORBIDDEN');
		});

		it('DELETE /mailShare/revoke without share:manage returns SHARE_FORBIDDEN', async () => {
			const body = await readBody(await api('DELETE', '/mailShare/revoke', {
				headers: { Authorization: noShareJwt }
			}));
			expect(body.json?.code).toBe(403);
			expect(body.json?.message).toBe('SHARE_FORBIDDEN');
		});

		it('POST /mailShare/create with share:manage is not SHARE_FORBIDDEN', async () => {
			const body = await readBody(await api('POST', '/mailShare/create', {
				headers: { Authorization: hasShareJwt }
			}));
			expect(body.json?.code).not.toBe(403);
			expect(body.json?.code).not.toBe(401);
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
