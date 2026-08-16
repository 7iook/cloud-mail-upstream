import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { attConst, emailConst, isDel } from '../src/const/entity-const';
import KvConst from '../src/const/kv-const';
import shareResult from '../src/model/share-result';
import jwtUtils from '../src/utils/jwt-utils';

const OWNER_EMAIL = 't11-owner@example.com';
const MAILBOX = 't11-box@example.com';
const OTHER_MAILBOX = 't11-other@example.com';
const ROLE_ID = 98;
const UNAVAILABLE = JSON.stringify(shareResult.fail('SHARE_UNAVAILABLE', 501));

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

async function jsonApi(method, path, { token, bearer, body, headers } = {}) {
	const nextHeaders = { ...(headers || {}) };
	if (body !== undefined) {
		nextHeaders['content-type'] = 'application/json';
	}
	if (token) {
		nextHeaders.Authorization = token;
	}
	if (bearer) {
		nextHeaders.Authorization = `Bearer ${bearer}`;
	}
	const response = await api(method, path, {
		headers: nextHeaders,
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	const text = await response.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = null;
	}
	return { status: response.status, headers: response.headers, text, json };
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

let ownerJwt;
let ownerUser;

beforeAll(async () => {
	await env.db.prepare(`
		INSERT OR IGNORE INTO perm (perm_id, name, perm_key, pid, type, sort)
		VALUES (37, 'share-manage', 'share:manage', 0, 2, 0)
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
	ownerUser = await seedUser(OWNER_EMAIL, ROLE_ID);
	ownerJwt = await jwtFor(ownerUser);
});

async function insertAccount(email, userId) {
	await env.db.prepare('DELETE FROM account WHERE email = ?').bind(email).run();
	const row = await env.db.prepare(`
		INSERT INTO account (email, name, user_id, is_del)
		VALUES (?, ?, ?, ?)
		RETURNING account_id
	`).bind(email, 't11', userId, isDel.NORMAL).first();
	return row.account_id;
}

async function insertEmail(accountId, userId, { subject, status, code, text, content } = {}) {
	const row = await env.db.prepare(`
		INSERT INTO email (account_id, user_id, subject, is_del, status, type, send_email, name, text, content, code)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING email_id
	`).bind(
		accountId,
		userId,
		subject || 't11-mail',
		isDel.NORMAL,
		status == null ? emailConst.status.RECEIVE : status,
		emailConst.type.RECEIVE,
		't11-sender@example.com',
		'T11 Sender',
		text == null ? 'plain body' : text,
		content == null ? '<p>html</p>' : content,
		code == null ? '' : code
	).first();
	return row.email_id;
}

async function cleanup() {
	await env.db.prepare('DELETE FROM share_idempotency WHERE user_id = ?').bind(ownerUser.userId).run();
	await env.db.prepare('DELETE FROM mail_share WHERE user_id = ?').bind(ownerUser.userId).run();
	await env.db.prepare("DELETE FROM attachments WHERE filename LIKE 't11-%' OR key LIKE 'attachments/t11-%'").run();
	await env.db.prepare("DELETE FROM email WHERE subject LIKE 't11-%' OR send_email = 't11-sender@example.com'").run();
	await env.db.prepare("DELETE FROM account WHERE email LIKE 't11-%@example.com'").run();
}

afterEach(async () => {
	await cleanup();
});

function expectNoStore(headers) {
	expect(headers.get('Cache-Control')).toBe('no-store');
}

describe('T-11 mail share HTTP routes', () => {
	it('runs owner create through visitor read then identical failures after revoke', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const otherAccountId = await insertAccount(OTHER_MAILBOX, ownerUser.userId);
		const beforeId = await insertEmail(accountId, ownerUser.userId, { subject: 't11-before-window' });

		const created = await jsonApi('POST', '/mailShare/create', {
			token: ownerJwt,
			headers: { 'Idempotency-Key': 't11-e2e-create' },
			body: {
				accountId,
				durationSeconds: 3600,
				name: 'desk handoff',
				remark: 'otp only'
			}
		});
		expect(created.status).toBe(200);
		expect(created.json?.code).toBe(200);
		expectNoStore(created.headers);
		expect(created.json.data.lid).toEqual(expect.any(String));
		expect(created.json.data.sec).toEqual(expect.any(String));
		expect(created.json.data.shareUrl).toContain(`/s/${created.json.data.lid}#${created.json.data.sec}`);
		expect(created.json.data.expiresAt).toEqual(expect.any(String));

		const replay = await jsonApi('POST', '/mailShare/create', {
			token: ownerJwt,
			headers: { 'Idempotency-Key': 't11-e2e-create' },
			body: {
				accountId,
				durationSeconds: 3600,
				name: 'desk handoff',
				remark: 'otp only'
			}
		});
		expect(replay.json.data.shareId).toBe(created.json.data.shareId);
		expect(replay.json.data.idempotentReplay).toBe(true);
		expect(replay.json.data.sec).toBeUndefined();

		const listed = await jsonApi('GET', '/mailShare/list', { token: ownerJwt });
		expect(listed.json.data.total).toBe(1);
		expect(listed.json.data.list[0].accessCount).toBe(0);
		expect(listed.json.data.list[0].name).toBe('desk handoff');
		expect(listed.json.data.list[0].remark).toBe('otp only');
		expect(JSON.stringify(listed.json)).not.toContain(created.json.data.sec);
		expectNoStore(listed.headers);

		const inScopeId = await insertEmail(accountId, ownerUser.userId, {
			subject: 't11-in-scope',
			code: '',
			text: 'otp body'
		});
		const savingId = await insertEmail(accountId, ownerUser.userId, {
			subject: 't11-saving',
			status: emailConst.status.SAVING
		});
		const otherId = await insertEmail(otherAccountId, ownerUser.userId, { subject: 't11-other-account' });

		const attKey = `attachments/t11-${inScopeId}.txt`;
		const attRow = await env.db.prepare(`
			INSERT INTO attachments (user_id, email_id, account_id, key, filename, mime_type, size, type)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			RETURNING att_id
		`).bind(
			ownerUser.userId, inScopeId, accountId, attKey, 't11-note.txt', 'text/plain', 11, attConst.type.ATT
		).first();
		await env.kv.put(attKey, 'hello-bytes', { metadata: { contentType: 'text/plain' } });

		const session = await jsonApi('POST', '/share/session', {
			body: { lid: created.json.data.lid, sec: created.json.data.sec }
		});
		expect(session.status).toBe(200);
		expect(session.json?.code).toBe(200);
		expectNoStore(session.headers);
		expect(session.json.data.sessionToken).toEqual(expect.any(String));
		expect(session.json.data.mailbox).toBe(MAILBOX);
		expect(session.json.data.sessionToken).not.toContain(created.json.data.sec);
		expect(JSON.stringify(session.json)).not.toContain('desk handoff');

		const afterSession = await env.db.prepare(
			'SELECT access_count FROM mail_share WHERE share_id = ?'
		).bind(created.json.data.shareId).first();
		expect(afterSession.access_count).toBe(1);

		const mails = await jsonApi('GET', '/share/mails?limit=20', {
			bearer: session.json.data.sessionToken
		});
		expect(mails.json?.code).toBe(200);
		expectNoStore(mails.headers);
		const ids = mails.json.data.list.map((row) => row.mailId);
		expect(ids).toContain(inScopeId);
		expect(ids).not.toContain(beforeId);
		expect(ids).not.toContain(savingId);
		expect(ids).not.toContain(otherId);
		expect(mails.json.data.list[0].code).toBe('');
		expect(mails.json.data.list[0].user_id).toBeUndefined();
		expect(mails.json.data.list[0].account_id).toBeUndefined();

		const afterList = await env.db.prepare(
			'SELECT access_count FROM mail_share WHERE share_id = ?'
		).bind(created.json.data.shareId).first();
		expect(afterList.access_count).toBe(1);

		const mail = await jsonApi('GET', `/share/mail?mailId=${inScopeId}`, {
			bearer: session.json.data.sessionToken
		});
		expect(mail.json.data.mailId).toBe(inScopeId);
		expect(mail.json.data.code).toBe('');
		expect(mail.json.data.text).toBe('otp body');
		expectNoStore(mail.headers);

		const outOfWindow = await jsonApi('GET', `/share/mail?mailId=${beforeId}`, {
			bearer: session.json.data.sessionToken
		});
		expect(outOfWindow.text).toBe(UNAVAILABLE);

		const att = await api('GET', `/share/attachment?mailId=${inScopeId}&attachmentId=${attRow.att_id}`, {
			headers: { Authorization: `Bearer ${session.json.data.sessionToken}` }
		});
		expect(att.status).toBe(200);
		expect(att.headers.get('Cache-Control')).toBe('no-store');
		expect(await att.text()).toBe('hello-bytes');

		const revoked = await jsonApi('DELETE', `/mailShare/revoke?shareId=${created.json.data.shareId}`, {
			token: ownerJwt
		});
		expect(revoked.json.data.shareId).toBe(created.json.data.shareId);
		expectNoStore(revoked.headers);

		const after = await Promise.all([
			jsonApi('POST', '/share/session', { body: { lid: created.json.data.lid, sec: created.json.data.sec } }),
			jsonApi('GET', '/share/mails', { bearer: session.json.data.sessionToken }),
			jsonApi('GET', `/share/mail?mailId=${inScopeId}`, { bearer: session.json.data.sessionToken }),
			jsonApi('GET', `/share/attachment?mailId=${inScopeId}&attachmentId=${attRow.att_id}`, {
				bearer: session.json.data.sessionToken
			})
		]);
		for (const item of after) {
			expect(item.status).toBe(200);
			expect(item.text).toBe(UNAVAILABLE);
			expectNoStore(item.headers);
		}
		expect(new Set(after.map((item) => item.text)).size).toBe(1);
	});

	it('returns byte-identical SHARE_UNAVAILABLE for the four visitor failure modes', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const live = await jsonApi('POST', '/mailShare/create', {
			token: ownerJwt,
			body: { accountId, durationSeconds: 3600, name: 'live', remark: '' }
		});
		const expired = await jsonApi('POST', '/mailShare/create', {
			token: ownerJwt,
			body: { accountId, durationSeconds: 3600, name: 'expired', remark: '' }
		});
		const revoked = await jsonApi('POST', '/mailShare/create', {
			token: ownerJwt,
			body: { accountId, durationSeconds: 3600, name: 'revoked', remark: '' }
		});
		await env.db.prepare(
			"UPDATE mail_share SET expires_at = '2001-01-01 00:00:00' WHERE lid = ?"
		).bind(expired.json.data.lid).run();
		await jsonApi('DELETE', `/mailShare/revoke?shareId=${revoked.json.data.shareId}`, { token: ownerJwt });

		const bodies = await Promise.all([
			jsonApi('POST', '/share/session', { body: { lid: 't11-never-existed', sec: 'nope' } }),
			jsonApi('POST', '/share/session', { body: { lid: live.json.data.lid, sec: 'wrong-secret' } }),
			jsonApi('POST', '/share/session', { body: { lid: expired.json.data.lid, sec: expired.json.data.sec } }),
			jsonApi('POST', '/share/session', { body: { lid: revoked.json.data.lid, sec: revoked.json.data.sec } })
		]);
		for (const item of bodies) {
			expect(item.status).toBe(200);
			expect(item.text).toBe(UNAVAILABLE);
			expect(item.headers.get('content-type')).toBe(bodies[0].headers.get('content-type'));
		}
		expect(new Set(bodies.map((item) => item.text)).size).toBe(1);
	});

	it('caps visitor list limit at 50 when the client asks for 500', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await jsonApi('POST', '/mailShare/create', {
			token: ownerJwt,
			body: { accountId, durationSeconds: 3600 }
		});
		for (let i = 0; i < 51; i++) {
			await insertEmail(accountId, ownerUser.userId, { subject: `t11-cap-${i}` });
		}
		const session = await jsonApi('POST', '/share/session', {
			body: { lid: created.json.data.lid, sec: created.json.data.sec }
		});
		const mails = await jsonApi('GET', '/share/mails?limit=500', {
			bearer: session.json.data.sessionToken
		});
		expect(mails.json.data.list.length).toBe(50);
		expect(mails.json.data.nextCursor).toBe(String(mails.json.data.list[49].mailId));
	});

	it('pages with a stable cursor that neither duplicates nor skips', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await jsonApi('POST', '/mailShare/create', {
			token: ownerJwt,
			body: { accountId, durationSeconds: 3600 }
		});
		const ids = [];
		for (let i = 0; i < 3; i++) {
			ids.push(await insertEmail(accountId, ownerUser.userId, { subject: `t11-page-${i}` }));
		}
		const session = await jsonApi('POST', '/share/session', {
			body: { lid: created.json.data.lid, sec: created.json.data.sec }
		});
		const page1 = await jsonApi('GET', '/share/mails?limit=2', {
			bearer: session.json.data.sessionToken
		});
		expect(page1.json.data.list.map((row) => row.mailId)).toEqual([ids[0], ids[1]]);
		const page2 = await jsonApi('GET', `/share/mails?cursor=${page1.json.data.nextCursor}&limit=2`, {
			bearer: session.json.data.sessionToken
		});
		expect(page2.json.data.list.map((row) => row.mailId)).toEqual([ids[2]]);
		const all = [...page1.json.data.list, ...page2.json.data.list].map((row) => row.mailId);
		expect(new Set(all).size).toBe(3);
		expect([...all].sort((a, b) => a - b)).toEqual(ids);
	});

	it('does not mutate share or mail rows on GET /share/mails or GET /share/mail', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await jsonApi('POST', '/mailShare/create', {
			token: ownerJwt,
			body: { accountId, durationSeconds: 3600 }
		});
		const mailId = await insertEmail(accountId, ownerUser.userId, { subject: 't11-get-readonly' });
		const session = await jsonApi('POST', '/share/session', {
			body: { lid: created.json.data.lid, sec: created.json.data.sec }
		});
		const beforeShare = await env.db.prepare(
			'SELECT access_count, last_access_at, status FROM mail_share WHERE share_id = ?'
		).bind(created.json.data.shareId).first();
		const beforeMail = await env.db.prepare(
			'SELECT unread, is_del, status FROM email WHERE email_id = ?'
		).bind(mailId).first();
		const beforeCount = await env.db.prepare(
			'SELECT COUNT(*) AS n FROM email WHERE account_id = ?'
		).bind(accountId).first();

		await jsonApi('GET', '/share/mails', { bearer: session.json.data.sessionToken });
		await jsonApi('GET', `/share/mail?mailId=${mailId}`, { bearer: session.json.data.sessionToken });

		const afterShare = await env.db.prepare(
			'SELECT access_count, last_access_at, status FROM mail_share WHERE share_id = ?'
		).bind(created.json.data.shareId).first();
		const afterMail = await env.db.prepare(
			'SELECT unread, is_del, status FROM email WHERE email_id = ?'
		).bind(mailId).first();
		const afterCount = await env.db.prepare(
			'SELECT COUNT(*) AS n FROM email WHERE account_id = ?'
		).bind(accountId).first();
		expect(afterShare).toEqual(beforeShare);
		expect(afterMail).toEqual(beforeMail);
		expect(afterCount.n).toBe(beforeCount.n);
	});

	it('rejects owner create when duration exceeds the configured max', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await jsonApi('POST', '/mailShare/create', {
			token: ownerJwt,
			body: { accountId, durationSeconds: 999999 }
		});
		expect(created.json?.message).toBe('SHARE_DURATION_EXCEEDED');
	});
});
