import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { emailConst, isDel } from '../src/const/entity-const';
import KvConst from '../src/const/kv-const';
import shareResult from '../src/model/share-result';
import jwtUtils from '../src/utils/jwt-utils';

// T-14 · GET /share/mailboxes/status —— 水位协议(design.md「Status 水位协议」)。
// 助手照抄 share-api.spec.js:28-134（T-11 正在改那个文件，import 会把两个任务锁在一起）。

const OWNER_EMAIL = 't14-owner@example.com';
const MAILBOX = 't14-box@example.com';
const SECOND_MAILBOX = 't14-second@example.com';
const OTHER_MAILBOX = 't14-other@example.com';
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
	`).bind(email, 't14', userId, isDel.NORMAL).first();
	return row.account_id;
}

async function insertEmail(accountId, userId, { subject, status, isDelValue } = {}) {
	const row = await env.db.prepare(`
		INSERT INTO email (account_id, user_id, subject, is_del, status, type, send_email, name, text, content, code)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING email_id
	`).bind(
		accountId,
		userId,
		subject || 't14-mail',
		isDelValue == null ? isDel.NORMAL : isDelValue,
		status == null ? emailConst.status.RECEIVE : status,
		emailConst.type.RECEIVE,
		't14-sender@example.com',
		'T14 Sender',
		'plain body',
		'<p>html</p>',
		''
	).first();
	return row.email_id;
}

async function createShare(accountId, body = {}) {
	return jsonApi('POST', '/mailShare/create', {
		token: ownerJwt,
		body: {
			accountId,
			durationSeconds: 3600,
			name: 't14-share',
			remark: '',
			...body
		}
	});
}

async function openSession(created) {
	return jsonApi('POST', '/share/session', {
		body: { lid: created.json.data.lid, sec: created.json.data.sec }
	});
}

async function status(bearer, query = '') {
	return jsonApi('GET', `/share/mailboxes/status${query}`, { bearer });
}

async function usedSessions(shareId) {
	const row = await env.db.prepare(
		'SELECT access_count FROM mail_share WHERE share_id = ?'
	).bind(shareId).first();
	return row.access_count;
}

// message_limit 经 create 需要 SHARE_CAPABILITY_V2；本任务禁止改动开关，直接写行。
async function setMessageLimit(shareId, messageLimit) {
	await env.db.prepare('UPDATE mail_share SET message_limit = ? WHERE share_id = ?')
		.bind(messageLimit, shareId).run();
}

async function addBinding(shareId, accountId, windowStartEmailId = 0) {
	const row = await env.db.prepare(`
		INSERT INTO mail_share_binding (share_id, account_id, window_start_email_id)
		VALUES (?, ?, ?)
		RETURNING binding_id
	`).bind(shareId, accountId, windowStartEmailId).first();
	return row.binding_id;
}

async function cleanup() {
	await env.db.prepare(`
		DELETE FROM mail_share_binding
		WHERE share_id IN (SELECT share_id FROM mail_share WHERE user_id = ?)
			OR share_id NOT IN (SELECT share_id FROM mail_share)
	`).bind(ownerUser.userId).run();
	await env.db.prepare('DELETE FROM share_idempotency WHERE user_id = ?').bind(ownerUser.userId).run();
	await env.db.prepare('DELETE FROM mail_share WHERE user_id = ?').bind(ownerUser.userId).run();
	await env.db.prepare("DELETE FROM email WHERE subject LIKE 't14-%' OR send_email = 't14-sender@example.com'").run();
	await env.db.prepare("DELETE FROM account WHERE email LIKE 't14-%@example.com'").run();
}

afterEach(async () => {
	await cleanup();
});

describe('T-14 GET /share/mailboxes/status', () => {
	it('reports the latest visible mail per binding with a serverTime and no-store', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShare(accountId);
		const olderId = await insertEmail(accountId, ownerUser.userId, { subject: 't14-older' });
		const latestId = await insertEmail(accountId, ownerUser.userId, { subject: 't14-latest' });
		const session = await openSession(created);
		const bearer = session.json.data.sessionToken;

		const body = await status(bearer);

		expect(body.status).toBe(200);
		expect(body.json?.code).toBe(200);
		expect(body.headers.get('Cache-Control')).toBe('no-store');
		expect(body.json.data.mailboxes).toEqual([
			{
				bindingId: session.json.data.mailboxes[0].bindingId,
				latestEmailId: latestId,
				latestReceivedAt: expect.any(String)
			}
		]);
		expect(latestId).toBeGreaterThan(olderId);
		expect(Number.isNaN(Date.parse(body.json.data.serverTime))).toBe(false);
	});

	it('returns latestEmailId null for a binding with no visible mail (AC-EDGE-07)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShare(accountId);
		const session = await openSession(created);

		const body = await status(session.json.data.sessionToken);

		expect(body.json.data.mailboxes).toEqual([
			{
				bindingId: session.json.data.mailboxes[0].bindingId,
				latestEmailId: null,
				latestReceivedAt: null
			}
		]);
	});

	it('ignores sinceEmailId, cursor and limit so the protocol stays stateless (R2-A2)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShare(accountId);
		await insertEmail(accountId, ownerUser.userId, { subject: 't14-cursorless-1' });
		const latestId = await insertEmail(accountId, ownerUser.userId, { subject: 't14-cursorless-2' });
		const session = await openSession(created);
		const bearer = session.json.data.sessionToken;

		const plain = await status(bearer);
		const withJunk = await Promise.all([
			status(bearer, `?sinceEmailId=${latestId}`),
			status(bearer, `?sinceEmailId=${latestId + 1000}`),
			status(bearer, '?sinceEmailId=0'),
			status(bearer, `?cursor=${latestId}`),
			status(bearer, '?cursor=not-a-number&limit=1&bindingId=999'),
			status(bearer, '?sinceEmailId=&cursor=')
		]);

		expect(plain.json.data.mailboxes[0].latestEmailId).toBe(latestId);
		for (const item of withJunk) {
			expect(item.status).toBe(200);
			expect(item.json.data.mailboxes).toEqual(plain.json.data.mailboxes);
		}
	});

	it('keeps mail below the VisibleWindow out of the watermark (AC-SEC-03)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const beforeId = await insertEmail(accountId, ownerUser.userId, { subject: 't14-before-window' });
		const created = await createShare(accountId);
		const session = await openSession(created);

		const empty = await status(session.json.data.sessionToken);
		expect(empty.json.data.mailboxes[0].latestEmailId).toBeNull();

		const insideId = await insertEmail(accountId, ownerUser.userId, { subject: 't14-inside-window' });
		const filled = await status(session.json.data.sessionToken);
		expect(filled.json.data.mailboxes[0].latestEmailId).toBe(insideId);
		expect(filled.json.data.mailboxes[0].latestEmailId).not.toBe(beforeId);
	});

	it('keeps mid-write, deleted and foreign mail out of the watermark (AC-SEC-03)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const otherAccountId = await insertAccount(OTHER_MAILBOX, ownerUser.userId);
		const created = await createShare(accountId);
		const visibleId = await insertEmail(accountId, ownerUser.userId, { subject: 't14-visible' });
		await insertEmail(accountId, ownerUser.userId, {
			subject: 't14-saving',
			status: emailConst.status.SAVING
		});
		await insertEmail(accountId, ownerUser.userId, {
			subject: 't14-deleted',
			isDelValue: isDel.DELETE
		});
		await insertEmail(otherAccountId, ownerUser.userId, { subject: 't14-foreign' });
		const session = await openSession(created);

		const body = await status(session.json.data.sessionToken);

		expect(body.json.data.mailboxes).toHaveLength(1);
		expect(body.json.data.mailboxes[0].latestEmailId).toBe(visibleId);
	});

	it('never reports a mail that message_limit rolled out of the visible set (AC-SEC-03)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShare(accountId);
		await setMessageLimit(created.json.data.shareId, 1);
		const rolledOutId = await insertEmail(accountId, ownerUser.userId, { subject: 't14-rolled-out' });
		const session = await openSession(created);

		const before = await status(session.json.data.sessionToken);
		expect(before.json.data.mailboxes[0].latestEmailId).toBe(rolledOutId);

		const newestId = await insertEmail(accountId, ownerUser.userId, { subject: 't14-newest' });
		const after = await status(session.json.data.sessionToken);
		expect(after.json.data.mailboxes[0].latestEmailId).toBe(newestId);

		// 被 N 滚出的那封既不该继续当水位，也不该在 mails 里出现。
		const mails = await jsonApi('GET', '/share/mails?limit=50', {
			bearer: session.json.data.sessionToken
		});
		expect(mails.json.data.list.map((row) => row.mailId)).toEqual([newestId]);
	});

	it('covers every binding of a multi-mailbox share in one response (D16)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const secondAccountId = await insertAccount(SECOND_MAILBOX, ownerUser.userId);
		const created = await createShare(accountId);
		const secondBindingId = await addBinding(created.json.data.shareId, secondAccountId);
		const firstId = await insertEmail(accountId, ownerUser.userId, { subject: 't14-multi-first' });
		const secondId = await insertEmail(secondAccountId, ownerUser.userId, { subject: 't14-multi-second' });
		const session = await openSession(created);
		const firstBindingId = session.json.data.mailboxes[0].bindingId;

		const body = await status(session.json.data.sessionToken);

		expect(session.json.data.mailboxes.map((item) => item.bindingId))
			.toEqual([firstBindingId, secondBindingId]);
		expect(body.json.data.mailboxes).toEqual([
			{ bindingId: firstBindingId, latestEmailId: firstId, latestReceivedAt: expect.any(String) },
			{ bindingId: secondBindingId, latestEmailId: secondId, latestReceivedAt: expect.any(String) }
		]);
	});

	it('shares the token and the scope of GET /share/mails and burns no quota (AC-EDGE-11)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const secondAccountId = await insertAccount(SECOND_MAILBOX, ownerUser.userId);
		const created = await createShare(accountId);
		await addBinding(created.json.data.shareId, secondAccountId);
		await insertEmail(accountId, ownerUser.userId, { subject: 't14-quota-a' });
		await insertEmail(secondAccountId, ownerUser.userId, { subject: 't14-quota-b' });
		const session = await openSession(created);
		const bearer = session.json.data.sessionToken;
		expect(await usedSessions(created.json.data.shareId)).toBe(1);

		for (let tick = 0; tick < 3; tick++) {
			const polled = await status(bearer);
			const mails = await jsonApi('GET', '/share/mails?limit=50', { bearer });
			const listed = mails.json.data.list.map((row) => row.mailId);
			// 同一 token、同一范围：水位必须恰好是 mails 里该 Binding 的最大 mailId。
			const watermarks = polled.json.data.mailboxes
				.map((item) => item.latestEmailId)
				.filter((value) => value != null)
				.sort((a, b) => a - b);
			expect(watermarks).toEqual([...listed].sort((a, b) => a - b));
		}

		expect(await usedSessions(created.json.data.shareId)).toBe(1);
		const row = await env.db.prepare(
			'SELECT access_count, last_access_at, status FROM mail_share WHERE share_id = ?'
		).bind(created.json.data.shareId).first();
		expect(row.access_count).toBe(1);
		expect(row.status).toBe('ACTIVE');
	});

	it('fails identically to the other visitor routes without a usable session', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShare(accountId);
		await insertEmail(accountId, ownerUser.userId, { subject: 't14-sealed' });
		const session = await openSession(created);
		const bearer = session.json.data.sessionToken;

		await jsonApi('DELETE', `/mailShare/revoke?shareId=${created.json.data.shareId}`, {
			token: ownerJwt
		});

		const bodies = [
			await status(bearer),
			await status(''),
			await status('not-a-token'),
			await jsonApi('GET', '/share/mailboxes/status'),
			await jsonApi('GET', '/share/mails', { bearer })
		];
		for (const item of bodies) {
			expect(item.status).toBe(200);
			expect(item.text).toBe(UNAVAILABLE);
			expect(item.headers.get('Cache-Control')).toBe('no-store');
		}
	});
});
