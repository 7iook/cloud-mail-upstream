import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { attConst, emailConst, isDel } from '../src/const/entity-const';
import KvConst from '../src/const/kv-const';
import shareResult from '../src/model/share-result';
import jwtUtils from '../src/utils/jwt-utils';
import worker from '../src/index.js';

const OWNER_EMAIL = 't24-owner@example.com';
const MAILBOX = 't24-box@example.com';
const OTHER_BOX = 't24-other@example.com';
const UNAVAILABLE = JSON.stringify(shareResult.fail('SHARE_UNAVAILABLE', 501));
const VISITOR_MAIL_KEYS = [
	'mailId',
	'senderName',
	'senderAddress',
	'subject',
	'text',
	'content',
	'receivedAt',
	'code',
	'attachments'
].sort();
const ATTACHMENT_KEYS = ['attachmentId', 'filename', 'size', 'downloadUrl'].sort();

const savedEnv = {
	SHARE_ENABLED: env.SHARE_ENABLED,
	SHARE_ACTIVE_LIMIT: env.SHARE_ACTIVE_LIMIT
};

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

async function jsonWorker(method, path, { token, bearer, body, headers } = {}) {
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
	const response = await worker.fetch(new Request(`http://example.com/api${path}`, {
		method,
		headers: {
			'accept-language': 'en',
			...nextHeaders
		},
		body: body !== undefined ? JSON.stringify(body) : undefined
	}), env, {});
	const text = await response.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = null;
	}
	return { status: response.status, headers: response.headers, text, json };
}

function expectUnavailable(item) {
	expect(item.status).toBe(200);
	expect(item.text).toBe(UNAVAILABLE);
	expect(item.headers.get('Cache-Control')).toBe('no-store');
}

function expectIdenticalUnavailable(items) {
	for (const item of items) {
		expectUnavailable(item);
		expect(item.headers.get('content-type')).toBe(items[0].headers.get('content-type'));
	}
	expect(new Set(items.map((item) => item.text)).size).toBe(1);
}

function expectVisitorDto(dto) {
	expect(Object.keys(dto).sort()).toEqual(VISITOR_MAIL_KEYS);
	expect(dto.user_id).toBeUndefined();
	expect(dto.userId).toBeUndefined();
	expect(dto.account_id).toBeUndefined();
	expect(dto.accountId).toBeUndefined();
	expect(dto.email_id).toBeUndefined();
	expect(dto.is_del).toBeUndefined();
	expect(dto.isDel).toBeUndefined();
	expect(Array.isArray(dto.attachments)).toBe(true);
	for (const att of dto.attachments) {
		expect(Object.keys(att).sort()).toEqual(ATTACHMENT_KEYS);
		expect(att.downloadUrl).toMatch(/^\/share\/attachment\?mailId=\d+&attachmentId=\d+$/);
		expect(att.downloadUrl).not.toContain('/oss/');
		expect(att).not.toHaveProperty('key');
	}
	const blob = JSON.stringify(dto);
	expect(blob).not.toContain('/oss/');
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
	ownerUser = await seedUser(OWNER_EMAIL, 1);
	ownerJwt = await jwtFor(ownerUser);
});

async function insertAccount(email, userId) {
	await env.db.prepare('DELETE FROM account WHERE email = ?').bind(email).run();
	const row = await env.db.prepare(`
		INSERT INTO account (email, name, user_id, is_del)
		VALUES (?, ?, ?, ?)
		RETURNING account_id
	`).bind(email, 't24', userId, isDel.NORMAL).first();
	return row.account_id;
}

async function insertEmail(accountId, userId, {
	subject,
	status,
	isDelValue,
	code,
	text,
	content
} = {}) {
	const row = await env.db.prepare(`
		INSERT INTO email (account_id, user_id, subject, is_del, status, type, send_email, name, text, content, code)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING email_id
	`).bind(
		accountId,
		userId,
		subject || 't24-mail',
		isDelValue == null ? isDel.NORMAL : isDelValue,
		status == null ? emailConst.status.RECEIVE : status,
		emailConst.type.RECEIVE,
		't24-sender@example.com',
		'T24 Sender',
		text == null ? 'plain body' : text,
		content == null ? '<p>html</p>' : content,
		code == null ? '' : code
	).first();
	return row.email_id;
}

async function insertAttachment(accountId, userId, emailId, filename) {
	const key = `attachments/t24-${emailId}-${filename}`;
	const row = await env.db.prepare(`
		INSERT INTO attachments (user_id, email_id, account_id, key, filename, mime_type, size, type)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING att_id
	`).bind(
		userId, emailId, accountId, key, filename, 'text/plain', 12, attConst.type.ATT
	).first();
	await env.kv.put(key, `bytes-${emailId}`, { metadata: { contentType: 'text/plain' } });
	return { attId: row.att_id, key };
}

async function createShare(accountId, body = {}, headers = {}) {
	return jsonApi('POST', '/mailShare/create', {
		token: ownerJwt,
		headers,
		body: {
			accountId,
			durationSeconds: 3600,
			name: 't24-share',
			remark: 't24-remark',
			...body
		}
	});
}

async function openSession(created) {
	return jsonApi('POST', '/share/session', {
		body: { lid: created.json.data.lid, sec: created.json.data.sec }
	});
}

async function explain(sql, binds = []) {
	const stmt = env.db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
	const rows = binds.length ? await stmt.bind(...binds).all() : await stmt.all();
	return (rows.results || []).map((row) => {
		return row.detail || row.DETAIL || Object.values(row).join(' ');
	}).join('\n');
}

async function assertSecAbsentFromDatabase(sec) {
	const tables = await env.db.prepare(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
	).all();
	for (const table of tables.results || []) {
		const cols = await env.db.prepare(`PRAGMA table_info("${table.name}")`).all();
		const textCols = (cols.results || []).filter((col) => {
			const type = String(col.type || '');
			return type === '' || /TEXT|CHAR|CLOB|DATE/i.test(type);
		});
		if (!textCols.length) {
			continue;
		}
		const where = textCols.map((col) => `"${col.name}" = ?`).join(' OR ');
		const hit = await env.db.prepare(
			`SELECT 1 AS hit FROM "${table.name}" WHERE ${where} LIMIT 1`
		).bind(...textCols.map(() => sec)).first();
		expect(hit, `plaintext sec stored in ${table.name}`).toBeFalsy();
	}
}

async function cleanup() {
	env.SHARE_ENABLED = savedEnv.SHARE_ENABLED;
	if (savedEnv.SHARE_ACTIVE_LIMIT === undefined) {
		delete env.SHARE_ACTIVE_LIMIT;
	} else {
		env.SHARE_ACTIVE_LIMIT = savedEnv.SHARE_ACTIVE_LIMIT;
	}
	await env.db.prepare('DELETE FROM share_idempotency WHERE user_id = ?').bind(ownerUser.userId).run();
	await env.db.prepare('DELETE FROM mail_share WHERE user_id = ? OR lid LIKE ?').bind(ownerUser.userId, 't24-%').run();
	await env.db.prepare("DELETE FROM attachments WHERE filename LIKE 't24-%' OR key LIKE 'attachments/t24-%'").run();
	await env.db.prepare("DELETE FROM email WHERE subject LIKE 't24-%' OR send_email = 't24-sender@example.com'").run();
	await env.db.prepare("DELETE FROM account WHERE email LIKE 't24-%@example.com'").run();
}

afterEach(async () => {
	await cleanup();
});

describe('T-24 mail share backend integration', () => {
	it('runs the visitor journey through the worker entry and seals every route after revoke', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const otherAccountId = await insertAccount(OTHER_BOX, ownerUser.userId);
		const beforeId = await insertEmail(accountId, ownerUser.userId, { subject: 't24-before' });

		const created = await createShare(accountId, { name: 'desk', remark: 'otp' });
		expect(created.status).toBe(200);
		expect(created.json?.code).toBe(200);
		expect(created.json.data.shareUrl).toContain(`/s/${created.json.data.lid}#${created.json.data.sec}`);
		expect(created.headers.get('Cache-Control')).toBe('no-store');
		await assertSecAbsentFromDatabase(created.json.data.sec);

		const page = await SELF.fetch(`http://example.com/s/${created.json.data.lid}`);
		expect(page.status).toBeLessThan(500);
		const beforeAccess = await env.db.prepare(
			'SELECT access_count, last_access_at FROM mail_share WHERE share_id = ?'
		).bind(created.json.data.shareId).first();
		expect(beforeAccess.access_count).toBe(0);
		expect(beforeAccess.last_access_at).toBeNull();

		const inScopeId = await insertEmail(accountId, ownerUser.userId, {
			subject: 't24-in-scope',
			code: '847291',
			text: 'Your code is 847291',
			content: '<p>otp</p>'
		});
		const att = await insertAttachment(accountId, ownerUser.userId, inScopeId, 't24-note.txt');
		await insertEmail(accountId, ownerUser.userId, {
			subject: 't24-saving',
			status: emailConst.status.SAVING,
			isDelValue: isDel.DELETE
		});
		await insertEmail(otherAccountId, ownerUser.userId, { subject: 't24-other-account' });

		const session = await openSession(created);
		expect(session.json.data.sessionToken).toEqual(expect.any(String));
		expect(session.json.data.mailbox).toBe(MAILBOX);
		expect(JSON.stringify(session.json)).not.toContain(created.json.data.sec);
		expect(JSON.stringify(session.json)).not.toContain('desk');

		const mails = await jsonApi('GET', '/share/mails?limit=20', {
			bearer: session.json.data.sessionToken
		});
		expect(mails.json?.code).toBe(200);
		const ids = mails.json.data.list.map((row) => row.mailId);
		expect(ids).toEqual([inScopeId]);
		expect(ids).not.toContain(beforeId);
		for (const row of mails.json.data.list) {
			expectVisitorDto(row);
		}
		expect(mails.json.data.list[0].code).toBe('847291');

		const mail = await jsonApi('GET', `/share/mail?mailId=${inScopeId}`, {
			bearer: session.json.data.sessionToken
		});
		expectVisitorDto(mail.json.data);
		expect(mail.json.data.code).toBe('847291');
		expect(mail.json.data.attachments[0].downloadUrl).toBe(
			`/share/attachment?mailId=${inScopeId}&attachmentId=${att.attId}`
		);

		const bytes = await api('GET', `/share/attachment?mailId=${inScopeId}&attachmentId=${att.attId}`, {
			headers: { Authorization: `Bearer ${session.json.data.sessionToken}` }
		});
		expect(bytes.status).toBe(200);
		expect(bytes.headers.get('Cache-Control')).toBe('no-store');
		expect(await bytes.text()).toBe(`bytes-${inScopeId}`);

		const revoked = await jsonApi('DELETE', `/mailShare/revoke?shareId=${created.json.data.shareId}`, {
			token: ownerJwt
		});
		expect(revoked.json.data.shareId).toBe(created.json.data.shareId);

		expectIdenticalUnavailable(await Promise.all([
			jsonApi('POST', '/share/session', { body: { lid: created.json.data.lid, sec: created.json.data.sec } }),
			jsonApi('GET', '/share/mails', { bearer: session.json.data.sessionToken }),
			jsonApi('GET', `/share/mail?mailId=${inScopeId}`, { bearer: session.json.data.sessionToken }),
			jsonApi('GET', `/share/attachment?mailId=${inScopeId}&attachmentId=${att.attId}`, {
				bearer: session.json.data.sessionToken
			})
		]));
	});

	it('returns byte-identical HTTP SHARE_UNAVAILABLE for every illegal visitor input (P-AUTH-01, AC-VISIT-04, AC-VISIT-09)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const beforeId = await insertEmail(accountId, ownerUser.userId, { subject: 't24-auth-before' });
		const live = await createShare(accountId, { name: 'live' });
		const expired = await createShare(accountId, { name: 'expired' });
		const revoked = await createShare(accountId, { name: 'revoked' });
		const liveSession = await openSession(live);
		const inScopeId = await insertEmail(accountId, ownerUser.userId, { subject: 't24-auth-in' });
		const att = await insertAttachment(accountId, ownerUser.userId, inScopeId, 't24-auth.txt');

		await env.db.prepare(
			"UPDATE mail_share SET expires_at = '2001-01-01 00:00:00' WHERE lid = ?"
		).bind(expired.json.data.lid).run();
		await jsonApi('DELETE', `/mailShare/revoke?shareId=${revoked.json.data.shareId}`, { token: ownerJwt });

		const disabled = await (async () => {
			env.SHARE_ENABLED = '0';
			try {
				return await jsonWorker('POST', '/share/session', {
					body: { lid: live.json.data.lid, sec: live.json.data.sec }
				});
			} finally {
				env.SHARE_ENABLED = savedEnv.SHARE_ENABLED;
			}
		})();

		const bodies = await Promise.all([
			jsonApi('POST', '/share/session', { body: { lid: 't24-never-existed', sec: 'nope' } }),
			jsonApi('POST', '/share/session', { body: { lid: live.json.data.lid, sec: 'wrong-secret' } }),
			jsonApi('POST', '/share/session', { body: { lid: expired.json.data.lid, sec: expired.json.data.sec } }),
			jsonApi('POST', '/share/session', { body: { lid: revoked.json.data.lid, sec: revoked.json.data.sec } }),
			disabled,
			jsonApi('GET', `/share/mail?mailId=${beforeId}`, { bearer: liveSession.json.data.sessionToken }),
			jsonApi('GET', '/share/mail?mailId=999999001', { bearer: liveSession.json.data.sessionToken }),
			jsonApi('GET', `/share/attachment?mailId=${beforeId}&attachmentId=${att.attId}`, {
				bearer: liveSession.json.data.sessionToken
			}),
			jsonApi('GET', '/share/mails?sec=should-not-authenticate', {})
		]);
		expectIdenticalUnavailable(bodies);
	});

	it('keeps account_id=0, mid-write, below-window, and foreign mail off every visitor route (P-SCOPE-01)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const otherAccountId = await insertAccount(OTHER_BOX, ownerUser.userId);
		const belowId = await insertEmail(accountId, ownerUser.userId, { subject: 't24-scope-below' });
		const created = await createShare(accountId);
		const visibleId = await insertEmail(accountId, ownerUser.userId, { subject: 't24-scope-visible' });
		const orphanId = await insertEmail(0, ownerUser.userId, { subject: 't24-scope-orphan0' });
		const savingId = await insertEmail(accountId, ownerUser.userId, {
			subject: 't24-scope-saving',
			status: emailConst.status.SAVING,
			isDelValue: isDel.DELETE
		});
		const deletedId = await insertEmail(accountId, ownerUser.userId, {
			subject: 't24-scope-deleted',
			isDelValue: isDel.DELETE
		});
		const otherId = await insertEmail(otherAccountId, ownerUser.userId, { subject: 't24-scope-other' });
		const visibleAtt = await insertAttachment(accountId, ownerUser.userId, visibleId, 't24-vis.txt');
		const poisons = [
			{ id: orphanId, accountId: 0 },
			{ id: belowId, accountId },
			{ id: savingId, accountId },
			{ id: deletedId, accountId },
			{ id: otherId, accountId: otherAccountId }
		];
		const poisonAtts = [];
		for (const poison of poisons) {
			poisonAtts.push(await insertAttachment(poison.accountId, ownerUser.userId, poison.id, `t24-p-${poison.id}.txt`));
		}

		const session = await openSession(created);
		const mails = await jsonApi('GET', '/share/mails?limit=50', {
			bearer: session.json.data.sessionToken
		});
		const ids = mails.json.data.list.map((row) => row.mailId);
		expect(ids).toEqual([visibleId]);
		for (const poison of poisons) {
			expect(ids).not.toContain(poison.id);
		}

		const missing = await jsonApi('GET', '/share/mail?mailId=999999002', {
			bearer: session.json.data.sessionToken
		});
		const details = await Promise.all(poisons.map((poison) => {
			return jsonApi('GET', `/share/mail?mailId=${poison.id}`, {
				bearer: session.json.data.sessionToken
			});
		}));
		const downloads = await Promise.all(poisonAtts.map((att, index) => {
			return jsonApi('GET', `/share/attachment?mailId=${poisons[index].id}&attachmentId=${att.attId}`, {
				bearer: session.json.data.sessionToken
			});
		}));
		expectIdenticalUnavailable([missing, ...details, ...downloads]);

		const okAtt = await api('GET', `/share/attachment?mailId=${visibleId}&attachmentId=${visibleAtt.attId}`, {
			headers: { Authorization: `Bearer ${session.json.data.sessionToken}` }
		});
		expect(await okAtt.text()).toBe(`bytes-${visibleId}`);
	});

	it('uses idx_email_account_id_email_id for the polling query and not a table scan (AC-RT-04)', async () => {
		expect(await env.db.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_email_user_id_account_id'"
		).first()).toBeTruthy();
		expect(await env.db.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_email_account_id_email_id'"
		).first()).toBeTruthy();

		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const noiseIds = [];
		for (let i = 0; i < 8; i++) {
			noiseIds.push(await insertAccount(`t24-noise-${i}@example.com`, ownerUser.userId));
		}
		const created = await createShare(accountId);
		const stmts = [];
		for (const noiseId of noiseIds) {
			for (let i = 0; i < 40; i++) {
				stmts.push(env.db.prepare(`
					INSERT INTO email (account_id, user_id, subject, is_del, status, type, send_email)
					VALUES (?, ?, ?, ?, ?, ?, ?)
				`).bind(
					noiseId,
					ownerUser.userId,
					`t24-plan-noise-${noiseId}-${i}`,
					isDel.NORMAL,
					emailConst.status.RECEIVE,
					emailConst.type.RECEIVE,
					't24-sender@example.com'
				));
			}
		}
		for (let i = 0; i < 30; i++) {
			stmts.push(env.db.prepare(`
				INSERT INTO email (account_id, user_id, subject, is_del, status, type, send_email)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`).bind(
				accountId,
				ownerUser.userId,
				`t24-plan-target-${i}`,
				isDel.NORMAL,
				emailConst.status.RECEIVE,
				emailConst.type.RECEIVE,
				't24-sender@example.com'
			));
		}
		for (let i = 0; i < stmts.length; i += 40) {
			await env.db.batch(stmts.slice(i, i + 40));
		}
		await env.db.prepare('ANALYZE email').run();

		const window = await env.db.prepare(
			'SELECT window_start_email_id FROM mail_share WHERE share_id = ?'
		).bind(created.json.data.shareId).first();
		const plan = await explain(`
			SELECT email_id
			FROM email
			WHERE account_id = ?
			  AND account_id > 0
			  AND email_id > ?
			  AND is_del = ?
			  AND status != ?
			ORDER BY email_id ASC
			LIMIT 50
		`, [accountId, window.window_start_email_id, isDel.NORMAL, emailConst.status.SAVING]);

		expect(plan, plan).toMatch(/idx_email_account_id_email_id/);
		expect(plan, plan).not.toMatch(/idx_email_user_id_account_id/);
		expect(plan, plan).not.toMatch(/SCAN(?: TABLE)? email(?! USING)/i);

		const session = await openSession(created);
		const mails = await jsonApi('GET', '/share/mails?limit=50', {
			bearer: session.json.data.sessionToken
		});
		expect(mails.json.data.list.length).toBeGreaterThan(0);
		expect(mails.json.data.list.every((row) => row.mailId > window.window_start_email_id)).toBe(true);
	});

	it('uses idx_mail_share_user_id_status for the owner list query (AC-MGMT-03)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const stmts = [];
		for (let i = 0; i < 80; i++) {
			stmts.push(env.db.prepare(`
				INSERT INTO mail_share (
					lid, sec_hmac, pepper_kid, user_id, account_id, expires_at, delete_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)
			`).bind(
				`t24-plan-other-${i}`,
				'hmac',
				'v1',
				ownerUser.userId + 7000 + i,
				accountId,
				'2099-01-01 00:00:00',
				'2099-12-31 00:00:00'
			));
		}
		await env.db.batch(stmts);
		await createShare(accountId, { name: 'plan-owner' });
		await env.db.prepare('ANALYZE mail_share').run();

		const plan = await explain(`
			SELECT ms.share_id
			FROM mail_share ms
			LEFT JOIN account a ON a.account_id = ms.account_id
			WHERE ms.user_id = ?
			ORDER BY ms.share_id DESC
		`, [ownerUser.userId]);
		expect(plan, plan).toMatch(/idx_mail_share_user_id_status/);
		expect(plan, plan).not.toMatch(/SCAN(?: TABLE)? mail_share(?! USING)/i);
	});

	it('does not let concurrent HTTP creates exceed the active cap (AC-SHARE-12)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		env.SHARE_ACTIVE_LIMIT = '1';
		try {
			const results = await Promise.all([
				jsonWorker('POST', '/mailShare/create', {
					token: ownerJwt,
					body: { accountId, durationSeconds: 3600, name: 'left', remark: '' }
				}),
				jsonWorker('POST', '/mailShare/create', {
					token: ownerJwt,
					body: { accountId, durationSeconds: 3600, name: 'right', remark: '' }
				})
			]);
			const ok = results.filter((item) => item.json?.code === 200 && item.json?.data?.shareId);
			const limited = results.filter((item) => item.json?.message === 'SHARE_LIMIT_EXCEEDED');
			expect(ok).toHaveLength(1);
			expect(limited).toHaveLength(1);
			const { n } = await env.db.prepare(
				"SELECT COUNT(*) AS n FROM mail_share WHERE user_id = ? AND status = 'ACTIVE'"
			).bind(ownerUser.userId).first();
			expect(n).toBe(1);
		} finally {
			delete env.SHARE_ACTIVE_LIMIT;
		}
	});

	it('replays one Idempotency-Key without a second share or sec, and conflicts on a different body (AC-SHARE-11, AC-SHARE-14)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const body = { name: 'same', remark: 'same', durationSeconds: 3600 };
		const first = await createShare(accountId, body, { 'Idempotency-Key': 't24-replay' });
		const replay = await createShare(accountId, body, { 'Idempotency-Key': 't24-replay' });
		expect(replay.json.data.shareId).toBe(first.json.data.shareId);
		expect(replay.json.data.lid).toBe(first.json.data.lid);
		expect(replay.json.data.idempotentReplay).toBe(true);
		expect(replay.json.data.sec).toBeUndefined();

		const conflict = await createShare(accountId, { ...body, name: 'other' }, {
			'Idempotency-Key': 't24-replay'
		});
		expect(conflict.json?.message).toBe('SHARE_IDEMPOTENCY_CONFLICT');
		const { n } = await env.db.prepare(
			'SELECT COUNT(*) AS n FROM mail_share WHERE user_id = ?'
		).bind(ownerUser.userId).first();
		expect(n).toBe(1);
	});

	it('treats a concurrent replay of the same Idempotency-Key as one share (AC-SHARE-11)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const body = { name: 'race', remark: '', durationSeconds: 3600 };
		const results = await Promise.all([
			createShare(accountId, body, { 'Idempotency-Key': 't24-race' }),
			createShare(accountId, body, { 'Idempotency-Key': 't24-race' })
		]);
		const ok = results.filter((item) => item.json?.code === 200 && item.json?.data?.shareId);
		expect(ok).toHaveLength(2);
		expect(ok[0].json.data.shareId).toBe(ok[1].json.data.shareId);
		const withSec = ok.filter((item) => item.json.data.sec);
		expect(withSec.length).toBeLessThanOrEqual(1);
		const { n } = await env.db.prepare(
			'SELECT COUNT(*) AS n FROM mail_share WHERE user_id = ?'
		).bind(ownerUser.userId).first();
		expect(n).toBe(1);
		const { keys } = await env.db.prepare(
			"SELECT COUNT(*) AS keys FROM share_idempotency WHERE user_id = ? AND idempotency_key = 't24-race'"
		).bind(ownerUser.userId).first();
		expect(keys).toBe(1);
	});

	it('computes expiry without cron and still lists the row for the owner (AC-LIFE-01, AC-LIFE-08)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShare(accountId, { name: 'will-expire' });
		const mailId = await insertEmail(accountId, ownerUser.userId, { subject: 't24-life-mail' });
		const att = await insertAttachment(accountId, ownerUser.userId, mailId, 't24-life.txt');
		const session = await openSession(created);

		await env.db.prepare(
			"UPDATE mail_share SET expires_at = '2001-01-01 00:00:00' WHERE share_id = ?"
		).bind(created.json.data.shareId).run();

		const row = await env.db.prepare(
			'SELECT status, delete_at, expires_at FROM mail_share WHERE share_id = ?'
		).bind(created.json.data.shareId).first();
		expect(row.status).toBe('ACTIVE');
		expect(row.delete_at > row.expires_at).toBe(true);

		expectIdenticalUnavailable(await Promise.all([
			jsonApi('POST', '/share/session', { body: { lid: created.json.data.lid, sec: created.json.data.sec } }),
			jsonApi('GET', '/share/mails', { bearer: session.json.data.sessionToken }),
			jsonApi('GET', `/share/mail?mailId=${mailId}`, { bearer: session.json.data.sessionToken }),
			jsonApi('GET', `/share/attachment?mailId=${mailId}&attachmentId=${att.attId}`, {
				bearer: session.json.data.sessionToken
			})
		]));

		const listed = await jsonApi('GET', '/mailShare/list', { token: ownerJwt });
		const item = listed.json.data.list.find((row) => row.shareId === created.json.data.shareId);
		expect(item).toBeTruthy();
		expect(item.status).toBe('ACTIVE');
		expect(item.effectiveStatus).toBe('EXPIRED');
		expect(JSON.stringify(listed.json)).not.toContain(created.json.data.sec);
	});

	it('restores an old ACTIVE link after the feature switch is turned back on (AC-LIFE-13, AC-ABUSE-03)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShare(accountId);
		env.SHARE_ENABLED = '0';
		try {
			const ownerCreate = await jsonWorker('POST', '/mailShare/create', {
				token: ownerJwt,
				body: { accountId, durationSeconds: 3600, name: 'frozen', remark: '' }
			});
			expect(ownerCreate.json?.message).toBe('SHARE_DISABLED');
			expectUnavailable(await jsonWorker('POST', '/share/session', {
				body: { lid: created.json.data.lid, sec: created.json.data.sec }
			}));
		} finally {
			env.SHARE_ENABLED = savedEnv.SHARE_ENABLED;
		}
		const session = await openSession(created);
		expect(session.json?.code).toBe(200);
		expect(session.json.data.sessionToken).toEqual(expect.any(String));
	});

	it('makes visitor HTTP fail identically after the mailbox is deleted (AC-LIFE-09)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShare(accountId);
		const mailId = await insertEmail(accountId, ownerUser.userId, { subject: 't24-del-mail' });
		const session = await openSession(created);
		const deleted = await jsonApi('DELETE', `/account/delete?accountId=${accountId}`, { token: ownerJwt });
		expect(deleted.json?.code).toBe(200);

		expectIdenticalUnavailable(await Promise.all([
			jsonApi('POST', '/share/session', { body: { lid: created.json.data.lid, sec: created.json.data.sec } }),
			jsonApi('GET', '/share/mails', { bearer: session.json.data.sessionToken }),
			jsonApi('GET', `/share/mail?mailId=${mailId}`, { bearer: session.json.data.sessionToken }),
			jsonApi('POST', '/share/session', { body: { lid: 't24-never', sec: 'nope' } })
		]));
		const row = await env.db.prepare(
			'SELECT status, revoked_at FROM mail_share WHERE share_id = ?'
		).bind(created.json.data.shareId).first();
		expect(row.status).toBe('REVOKED');
		expect(row.revoked_at).toEqual(expect.any(String));
	});

	it('rejects write APIs that a visitor session token must never perform (AC-VISIT-08)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShare(accountId);
		const mailId = await insertEmail(accountId, ownerUser.userId, { subject: 't24-write-guard' });
		const session = await openSession(created);
		const bearer = session.json.data.sessionToken;

		const writes = await Promise.all([
			jsonApi('DELETE', `/email/delete?emailIds=${mailId}`, { bearer }),
			jsonApi('POST', '/email/send', { bearer, body: { emailId: mailId } }),
			jsonApi('PUT', '/email/read', { bearer, body: { emailIds: [mailId] } }),
			jsonApi('POST', '/mailShare/create', { bearer, body: { accountId, durationSeconds: 60 } }),
			jsonApi('DELETE', `/mailShare/revoke?shareId=${created.json.data.shareId}`, { bearer })
		]);
		for (const item of writes) {
			expect(item.json?.code).toBe(401);
			expect(item.json?.message).not.toBe('SHARE_UNAVAILABLE');
		}
		const mail = await env.db.prepare(
			'SELECT is_del, unread FROM email WHERE email_id = ?'
		).bind(mailId).first();
		expect(mail.is_del).toBe(isDel.NORMAL);
		const share = await env.db.prepare(
			'SELECT status FROM mail_share WHERE share_id = ?'
		).bind(created.json.data.shareId).first();
		expect(share.status).toBe('ACTIVE');
	});

	it('re-reads the same cursor after a reconnect without duplicating mail (AC-RT-12, AC-RT-09)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShare(accountId);
		const ids = [];
		for (let i = 0; i < 3; i++) {
			ids.push(await insertEmail(accountId, ownerUser.userId, { subject: `t24-cursor-${i}` }));
		}
		const session = await openSession(created);
		const page1 = await jsonApi('GET', '/share/mails?limit=2', {
			bearer: session.json.data.sessionToken
		});
		const again = await jsonApi('GET', '/share/mails?limit=2', {
			bearer: session.json.data.sessionToken
		});
		expect(again.json.data.list.map((row) => row.mailId)).toEqual(
			page1.json.data.list.map((row) => row.mailId)
		);
		const page2 = await jsonApi('GET', `/share/mails?cursor=${page1.json.data.nextCursor}&limit=2`, {
			bearer: session.json.data.sessionToken
		});
		const all = [...page1.json.data.list, ...page2.json.data.list].map((row) => row.mailId);
		expect(all).toEqual(ids);
		expect(new Set(all).size).toBe(ids.length);
	});
});
