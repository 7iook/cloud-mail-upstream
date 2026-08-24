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
// T-11 grew the projection by the Binding identity and the masked mailbox address;
// `code` is still here because these journeys run with otp_extraction_enabled on.
const VISITOR_MAIL_KEYS = [
	'mailId',
	'bindingId',
	'mailboxAddress',
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
	SHARE_ACTIVE_LIMIT: env.SHARE_ACTIVE_LIMIT,
	SHARE_CAPABILITY_V2: env.SHARE_CAPABILITY_V2
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

// T-19 追加两个可选参:`authKey` 走 body(share-api.js:60),`idempotencyKey` 走头部。
// 两者缺省即旧行为,既有调用点一字未改。
async function openSession(created, { authKey, idempotencyKey } = {}) {
	return jsonApi('POST', '/share/session', {
		headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
		body: {
			lid: created.json.data.lid,
			sec: created.json.data.sec,
			...(authKey == null ? {} : { authKey })
		}
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
	// 兜底还原:某条用例在翻开开关的窗口内抛异常时,finally 之外还有这一层。
	// vitest 是 singleWorker,一枚泄漏的 true 会污染整个进程里的 V2=false 用例。
	env.SHARE_CAPABILITY_V2 = savedEnv.SHARE_CAPABILITY_V2;
	if (savedEnv.SHARE_ACTIVE_LIMIT === undefined) {
		delete env.SHARE_ACTIVE_LIMIT;
	} else {
		env.SHARE_ACTIVE_LIMIT = savedEnv.SHARE_ACTIVE_LIMIT;
	}
	await env.db.prepare('DELETE FROM share_idempotency WHERE user_id = ?').bind(ownerUser.userId).run();
	await env.db.prepare('DELETE FROM mail_share WHERE user_id = ? OR lid LIKE ?').bind(ownerUser.userId, 't24-%').run();
	// 主表行删掉之后 Binding 会变成孤儿:用例内自己造多条 Binding 再断言行数时,
	// 上一条用例的残留会污染本条的计数。
	await env.db.prepare(
		'DELETE FROM mail_share_binding WHERE share_id NOT IN (SELECT share_id FROM mail_share)'
	).run();
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
		expect(all).toEqual([ids[2], ids[1], ids[0]]);
		expect(new Set(all).size).toBe(ids.length);
	});
});

// ── T-14 · status 水位端点（design.md「Status 水位协议」· D16 · R2-A2）─────────
// 追加在文件末尾，既有用例一行不动。Binding 行直接写库：多邮箱 create 走 V2 栅栏，
// 而这里要测的是「已经有 N 条 Binding 的分享」被访客轮询时的水位。
describe('GET /share/mailboxes/status', () => {
	async function addBinding(shareId, accountId, windowStartEmailId = 0) {
		const row = await env.db.prepare(`
			INSERT INTO mail_share_binding (share_id, account_id, window_start_email_id)
			VALUES (?, ?, ?)
			RETURNING binding_id
		`).bind(shareId, accountId, windowStartEmailId).first();
		return row.binding_id;
	}

	async function status(bearer, query = '') {
		return jsonApi('GET', `/share/mailboxes/status${query}`, { bearer });
	}

	async function shareRow(shareId) {
		return env.db.prepare(
			'SELECT access_count, last_access_at, status FROM mail_share WHERE share_id = ?'
		).bind(shareId).first();
	}

	it('answers every binding of one share in a single poll that costs no quota (D16, AC-EDGE-11)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const otherAccountId = await insertAccount(OTHER_BOX, ownerUser.userId);
		const created = await createShare(accountId);
		const secondBindingId = await addBinding(created.json.data.shareId, otherAccountId);
		const firstId = await insertEmail(accountId, ownerUser.userId, { subject: 't24-status-first' });
		const secondId = await insertEmail(otherAccountId, ownerUser.userId, { subject: 't24-status-second' });
		const session = await openSession(created);
		const bearer = session.json.data.sessionToken;
		const firstBindingId = session.json.data.mailboxes[0].bindingId;
		const before = await shareRow(created.json.data.shareId);

		const polled = await status(bearer);

		expect(polled.status).toBe(200);
		expect(polled.headers.get('Cache-Control')).toBe('no-store');
		expect(polled.json.data.mailboxes).toEqual([
			{ bindingId: firstBindingId, latestEmailId: firstId, latestReceivedAt: expect.any(String) },
			{ bindingId: secondBindingId, latestEmailId: secondId, latestReceivedAt: expect.any(String) }
		]);
		expect(Number.isNaN(Date.parse(polled.json.data.serverTime))).toBe(false);
		// 同 token 同范围：水位集合恰是 mails 里每个邮箱的最大 mailId。
		const mails = await jsonApi('GET', '/share/mails?limit=50', { bearer });
		expect(mails.json.data.list.map((row) => row.mailId).sort((a, b) => a - b))
			.toEqual([firstId, secondId]);
		expect(await shareRow(created.json.data.shareId)).toEqual(before);
	});

	it('returns the same watermark with or without cursor-shaped query params (R2-A2)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShare(accountId);
		await insertEmail(accountId, ownerUser.userId, { subject: 't24-status-old' });
		const latestId = await insertEmail(accountId, ownerUser.userId, { subject: 't24-status-new' });
		const session = await openSession(created);
		const bearer = session.json.data.sessionToken;

		const plain = await status(bearer);
		const junk = await Promise.all([
			status(bearer, `?sinceEmailId=${latestId}`),
			status(bearer, '?sinceEmailId=0&cursor=1'),
			status(bearer, '?cursor=not-a-number&limit=1')
		]);

		expect(plain.json.data.mailboxes[0].latestEmailId).toBe(latestId);
		for (const item of junk) {
			expect(item.status).toBe(200);
			expect(item.json.data.mailboxes).toEqual(plain.json.data.mailboxes);
		}
	});

	it('never lets out-of-window, rolled-out or excluded mail move the watermark (AC-SEC-03)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const foreignAccountId = await insertAccount(OTHER_BOX, ownerUser.userId);
		const belowId = await insertEmail(accountId, ownerUser.userId, { subject: 't24-status-below' });
		const created = await createShare(accountId);
		await env.db.prepare('UPDATE mail_share SET message_limit = 1 WHERE share_id = ?')
			.bind(created.json.data.shareId).run();
		const session = await openSession(created);
		const bearer = session.json.data.sessionToken;

		// 窗口之下已有一封，水位仍必须是 null —— 存在性不得泄露。
		expect((await status(bearer)).json.data.mailboxes[0].latestEmailId).toBeNull();

		const rolledOutId = await insertEmail(accountId, ownerUser.userId, { subject: 't24-status-rolled' });
		expect((await status(bearer)).json.data.mailboxes[0].latestEmailId).toBe(rolledOutId);

		const visibleId = await insertEmail(accountId, ownerUser.userId, { subject: 't24-status-visible' });
		await insertEmail(accountId, ownerUser.userId, {
			subject: 't24-status-saving',
			status: emailConst.status.SAVING
		});
		await insertEmail(accountId, ownerUser.userId, {
			subject: 't24-status-deleted',
			isDelValue: isDel.DELETE
		});
		await insertEmail(foreignAccountId, ownerUser.userId, { subject: 't24-status-foreign' });

		const after = await status(bearer);
		expect(after.json.data.mailboxes).toEqual([
			{
				bindingId: session.json.data.mailboxes[0].bindingId,
				latestEmailId: visibleId,
				latestReceivedAt: expect.any(String)
			}
		]);
		// message_limit=1 把 rolledOut 滚出可见集，水位与 mails 一起改口径。
		const mails = await jsonApi('GET', '/share/mails?limit=50', { bearer });
		expect(mails.json.data.list.map((row) => row.mailId)).toEqual([visibleId]);
		expect(mails.json.data.list.map((row) => row.mailId)).not.toContain(belowId);
	});

	it('seals status exactly like the other visitor routes after revoke (AC-VISIT-04)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShare(accountId);
		const mailId = await insertEmail(accountId, ownerUser.userId, { subject: 't24-status-sealed' });
		const att = await insertAttachment(accountId, ownerUser.userId, mailId, 't24-status.txt');
		const session = await openSession(created);
		const bearer = session.json.data.sessionToken;
		expect((await status(bearer)).json.data.mailboxes[0].latestEmailId).toBe(mailId);

		await jsonApi('DELETE', `/mailShare/revoke?shareId=${created.json.data.shareId}`, {
			token: ownerJwt
		});

		expectIdenticalUnavailable(await Promise.all([
			status(bearer),
			status(bearer, '?sinceEmailId=1'),
			status('not-a-session-token'),
			jsonApi('GET', '/share/mailboxes/status'),
			jsonApi('GET', '/share/mails', { bearer }),
			jsonApi('GET', `/share/mail?mailId=${mailId}`, { bearer }),
			jsonApi('GET', `/share/attachment?mailId=${mailId}&attachmentId=${att.attId}`, { bearer })
		]));
	});
});

// ── T-19 · checkpoint：多邮箱 / 配额 / AuthKey 三条 Owner-HTTP → Visitor-HTTP 整链 ─────
// 追加在文件末尾,既有 17 条一行不动。
//
// 两条贯穿本节的物理事实:
// ① 六条写入路径(多邮箱 create / authKeyEnabled / 有限 maxSessions / messageLimit /
//    bindings 1→N / resetAuthKey enable)被 SHARE_CAPABILITY_V2 挡着,而 vitest 基线是
//    关闭态。翻开关只对 `worker.fetch(req, env)` 生效 —— `SELF.fetch` 派发的 Worker 实例
//    看不见测试进程改的 env(裁决 T16-HTTP),所以这类写入一律走 `ownerV2`。
// ② 访客读路径不过栅栏。读回一律走 jsonApi(栅栏关闭态),顺带证明栅栏回落不会让
//    已经发出去的链接失效。
const AUTH_REQUIRED = JSON.stringify(shareResult.fail('SHARE_AUTH_REQUIRED', 501));
const THIRD_BOX = 't24-third@example.com';
const STRANGER_EMAIL = 't24-stranger@example.com';
const STRANGER_BOX = 't24-stranger-box@example.com';

// vitest 是 singleWorker,env 进程级共享:漏还原会让同 worker 里其它 spec 的
// V2=false 用例随机变绿,且报错点离肇事点很远。故恒 try/finally。
async function withCapabilityV2(run) {
	env.SHARE_CAPABILITY_V2 = 'true';
	try {
		return await run();
	} finally {
		env.SHARE_CAPABILITY_V2 = savedEnv.SHARE_CAPABILITY_V2;
	}
}

function ownerV2(method, path, options = {}) {
	return withCapabilityV2(() => jsonWorker(method, path, { token: ownerJwt, ...options }));
}

function ownerApi(method, path, options = {}) {
	return jsonApi(method, path, { token: ownerJwt, ...options });
}

async function createShareV2(body, headers = {}) {
	return ownerV2('POST', '/mailShare/create', {
		headers,
		body: { durationSeconds: 3600, name: 't24-share', remark: 't24-remark', ...body }
	});
}

let strangerUser;

async function foreignAccount() {
	if (!strangerUser) {
		strangerUser = await seedUser(STRANGER_EMAIL, 1);
	}
	return insertAccount(STRANGER_BOX, strangerUser.userId);
}

async function countRows(sql, binds = []) {
	const row = await env.db.prepare(sql).bind(...binds).first();
	return row.n;
}

async function mailShareRow(shareId) {
	return env.db.prepare(
		'SELECT status, revoked_at, account_id, access_count, auth_key_enabled FROM mail_share WHERE share_id = ?'
	).bind(shareId).first();
}

async function accessCount(shareId) {
	return (await mailShareRow(shareId)).access_count;
}

async function bindingRows(shareId) {
	const rows = await env.db.prepare(`
		SELECT binding_id, account_id, window_start_email_id FROM mail_share_binding
		WHERE share_id = ? ORDER BY binding_id ASC
	`).bind(shareId).all();
	return rows.results || [];
}

function mailIdsOf(response) {
	return response.json.data.list.map((row) => row.mailId);
}

describe('multi mailbox share over HTTP (T-19)', () => {
	it('creates a two mailbox share and merges both inboxes into one visitor list (AC-CAP-01, AC-CAP-02, AC-MAIL-01, AC-MAIL-08, AC-SESS-09)', async () => {
		const boxA = await insertAccount(MAILBOX, ownerUser.userId);
		const boxB = await insertAccount(OTHER_BOX, ownerUser.userId);

		const created = await createShareV2({ accountIds: [boxA, boxB] });
		expect(created.json?.code).toBe(200);
		expect(created.json.data.shareType).toBe('multi');
		const bindings = created.json.data.bindings;
		expect(bindings.map((row) => row.accountId)).toEqual([boxA, boxB]);
		expect(await bindingRows(created.json.data.shareId)).toHaveLength(2);

		const firstA = await insertEmail(boxA, ownerUser.userId, { subject: 't24-multi-a1' });
		const firstB = await insertEmail(boxB, ownerUser.userId, { subject: 't24-multi-b1' });
		const secondA = await insertEmail(boxA, ownerUser.userId, { subject: 't24-multi-a2' });

		const session = await openSession(created);
		expect(session.json.data.shareType).toBe('multi');
		expect(session.json.data.mailboxes).toEqual(bindings.map((row) => ({
			bindingId: row.bindingId,
			address: 't***@example.com'
		})));
		// 掩码是真的掩码:第二个邮箱的完整地址一个字符都不出现(第一个仍由 deprecated
		// `mailbox` 字段原样带出,那是 T-11 之前的兼容形状,不在本条的断言面上)。
		expect(JSON.stringify(session.json)).not.toContain(OTHER_BOX);

		const mails = await jsonApi('GET', '/share/mails?limit=20', {
			bearer: session.json.data.sessionToken
		});
		expect(mailIdsOf(mails)).toEqual([secondA, firstB, firstA]);
		const bindingOf = new Map(bindings.map((row) => [row.accountId, row.bindingId]));
		expect(mails.json.data.list.map((row) => row.bindingId)).toEqual([
			bindingOf.get(boxA), bindingOf.get(boxB), bindingOf.get(boxA)
		]);
		for (const row of mails.json.data.list) {
			expectVisitorDto(row);
			expect(row.mailboxAddress).toBe('t***@example.com');
		}
	});

	it('applies each bindings own window lower bound (AC-CAP-07, AC-MAIL-02)', async () => {
		const boxA = await insertAccount(MAILBOX, ownerUser.userId);
		const boxB = await insertAccount(OTHER_BOX, ownerUser.userId);
		const beforeA = await insertEmail(boxA, ownerUser.userId, { subject: 't24-window-a-old' });
		const beforeB = await insertEmail(boxB, ownerUser.userId, { subject: 't24-window-b-old' });

		const created = await createShareV2({ accountIds: [boxA, boxB] });
		const afterA = await insertEmail(boxA, ownerUser.userId, { subject: 't24-window-a-new' });
		const afterB = await insertEmail(boxB, ownerUser.userId, { subject: 't24-window-b-new' });

		// 每条 Binding 各记各的快照。单标量下界(取主 Binding 的 beforeA)会让 beforeB 漏出来。
		expect((await bindingRows(created.json.data.shareId)).map((row) => row.window_start_email_id))
			.toEqual([beforeA, beforeB]);
		expect(beforeB).toBeGreaterThan(beforeA);

		const session = await openSession(created);
		const bearer = session.json.data.sessionToken;
		expect(mailIdsOf(await jsonApi('GET', '/share/mails?limit=50', { bearer })))
			.toEqual([afterB, afterA]);
		expectIdenticalUnavailable(await Promise.all([
			jsonApi('GET', `/share/mail?mailId=${beforeA}`, { bearer }),
			jsonApi('GET', `/share/mail?mailId=${beforeB}`, { bearer })
		]));
	});

	it('lets the owner add and remove a binding without the visitor rebuilding its session (AC-BIND-02, AC-BIND-03, AC-BIND-08, AC-EDGE-04)', async () => {
		const boxA = await insertAccount(MAILBOX, ownerUser.userId);
		const boxB = await insertAccount(OTHER_BOX, ownerUser.userId);
		const boxC = await insertAccount(THIRD_BOX, ownerUser.userId);
		const created = await createShareV2({ accountIds: [boxA, boxB] });
		const shareId = created.json.data.shareId;
		const mailA = await insertEmail(boxA, ownerUser.userId, { subject: 't24-bind-a' });
		const mailB = await insertEmail(boxB, ownerUser.userId, { subject: 't24-bind-b' });

		const session = await openSession(created);
		const bearer = session.json.data.sessionToken;
		expect(mailIdsOf(await jsonApi('GET', '/share/mails?limit=50', { bearer })))
			.toEqual([mailB, mailA]);

		// 2→3 是「使 Binding 数变大且 > 1」的扩张,过 V2 栅栏。
		const added = await ownerV2('PUT', '/mailShare/bindings', { body: { shareId, add: [boxC] } });
		expect(added.json?.code).toBe(200);
		expect(added.json.data.shareType).toBe('multi');
		expect(added.json.data.bindings.map((row) => row.accountId)).toEqual([boxA, boxB, boxC]);
		const bindingB = added.json.data.bindings.find((row) => row.accountId === boxB).bindingId;
		const bindingC = added.json.data.bindings.find((row) => row.accountId === boxC).bindingId;
		const mailC = await insertEmail(boxC, ownerUser.userId, { subject: 't24-bind-c' });

		// 同一枚 sessionToken,不重建 Session:下一次拉取即刻生效。
		const afterAdd = await jsonApi('GET', '/share/mails?limit=50', { bearer });
		expect(mailIdsOf(afterAdd)).toEqual([mailC, mailB, mailA]);
		expect(afterAdd.json.data.list[0].bindingId).toBe(bindingC);
		expect((await jsonApi('GET', '/share/mailboxes/status', { bearer })).json.data.mailboxes)
			.toHaveLength(3);

		// 缩减不过栅栏,所以这一条刻意走 jsonApi(V2=false)。
		const removed = await ownerApi('PUT', '/mailShare/bindings', {
			body: { shareId, remove: [bindingB] }
		});
		expect(removed.json?.code).toBe(200);
		expect(removed.json.data.status).toBe('ACTIVE');
		expect(removed.json.data.bindings.map((row) => row.accountId)).toEqual([boxA, boxC]);

		expect(mailIdsOf(await jsonApi('GET', '/share/mails?limit=50', { bearer })))
			.toEqual([mailC, mailA]);
		expectUnavailable(await jsonApi('GET', `/share/mail?mailId=${mailB}`, { bearer }));
		expect((await jsonApi('GET', '/share/mailboxes/status', { bearer })).json.data.mailboxes)
			.toHaveLength(2);
	});

	it('revokes the share when the owner removes the last binding (AC-BIND-04)', async () => {
		const boxA = await insertAccount(MAILBOX, ownerUser.userId);
		const boxB = await insertAccount(OTHER_BOX, ownerUser.userId);
		const created = await createShareV2({ accountIds: [boxA, boxB] });
		const shareId = created.json.data.shareId;
		const mailId = await insertEmail(boxA, ownerUser.userId, { subject: 't24-last-binding' });
		const att = await insertAttachment(boxA, ownerUser.userId, mailId, 't24-last.txt');
		const session = await openSession(created);
		const bearer = session.json.data.sessionToken;

		const removed = await ownerApi('PUT', '/mailShare/bindings', {
			body: { shareId, remove: created.json.data.bindings.map((row) => row.bindingId) }
		});
		expect(removed.json?.code).toBe(200);
		expect(removed.json.data.status).toBe('REVOKED');
		expect(removed.json.data.bindings).toEqual([]);

		expectIdenticalUnavailable(await Promise.all([
			jsonApi('POST', '/share/session', {
				body: { lid: created.json.data.lid, sec: created.json.data.sec }
			}),
			jsonApi('GET', '/share/mails', { bearer }),
			jsonApi('GET', `/share/mail?mailId=${mailId}`, { bearer }),
			jsonApi('GET', `/share/attachment?mailId=${mailId}&attachmentId=${att.attId}`, { bearer })
		]));
		const row = await mailShareRow(shareId);
		expect(row.status).toBe('REVOKED');
		expect(row.revoked_at).toEqual(expect.any(String));
		expect(await bindingRows(shareId)).toEqual([]);
	});

	it('refuses the multi create and the 1 to N expansion while the capability flag is off (AC-LIFE-11)', async () => {
		const boxA = await insertAccount(MAILBOX, ownerUser.userId);
		const boxB = await insertAccount(OTHER_BOX, ownerUser.userId);

		const refused = await ownerApi('POST', '/mailShare/create', {
			body: { accountIds: [boxA, boxB], durationSeconds: 3600, name: 't24-gated', remark: '' }
		});
		expect(refused.json?.message).toBe('SHARE_INVALID_CONFIG');
		expect(await countRows('SELECT COUNT(*) AS n FROM mail_share WHERE user_id = ?', [ownerUser.userId]))
			.toBe(0);
		expect(await countRows('SELECT COUNT(*) AS n FROM mail_share_binding')).toBe(0);

		const single = await createShare(boxA);
		const shareId = single.json.data.shareId;
		const expand = await ownerApi('PUT', '/mailShare/bindings', {
			body: { shareId, add: [boxB] }
		});
		expect(expand.json?.message).toBe('SHARE_INVALID_CONFIG');
		expect((await bindingRows(shareId)).map((row) => row.account_id)).toEqual([boxA]);
	});

	it('keeps a foreign mailbox out of a multi mailbox share (AC-CAP-03, AC-BIND-10)', async () => {
		const boxA = await insertAccount(MAILBOX, ownerUser.userId);
		const foreign = await foreignAccount();

		const refused = await createShareV2({ accountIds: [boxA, foreign] });
		expect(refused.json?.message).toBe('SHARE_ACCOUNT_FORBIDDEN');
		expect(await countRows('SELECT COUNT(*) AS n FROM mail_share WHERE user_id = ?', [ownerUser.userId]))
			.toBe(0);
		expect(await countRows('SELECT COUNT(*) AS n FROM mail_share_binding')).toBe(0);
	});

	it('deletes a multi mailbox share with all of its bindings and idempotency rows (AC-ADMIN-07)', async () => {
		const boxA = await insertAccount(MAILBOX, ownerUser.userId);
		const boxB = await insertAccount(OTHER_BOX, ownerUser.userId);
		const created = await createShareV2({ accountIds: [boxA, boxB] }, {
			'Idempotency-Key': 't24-multi-delete'
		});
		const shareId = created.json.data.shareId;
		expect(await bindingRows(shareId)).toHaveLength(2);
		expect(await countRows('SELECT COUNT(*) AS n FROM share_idempotency WHERE share_id = ?', [shareId]))
			.toBe(1);

		const deleted = await ownerApi('DELETE', `/mailShare/delete?shareId=${shareId}`);
		expect(deleted.json.data.shareId).toBe(shareId);

		expect(await countRows('SELECT COUNT(*) AS n FROM mail_share WHERE share_id = ?', [shareId])).toBe(0);
		expect(await countRows('SELECT COUNT(*) AS n FROM mail_share_binding WHERE share_id = ?', [shareId])).toBe(0);
		expect(await countRows('SELECT COUNT(*) AS n FROM share_idempotency WHERE share_id = ?', [shareId])).toBe(0);
	});

	it('keeps a multi mailbox share alive when only one of its mailboxes is deleted (AC-BIND-05, AC-EDGE-04)', async () => {
		const boxA = await insertAccount(MAILBOX, ownerUser.userId);
		const boxB = await insertAccount(OTHER_BOX, ownerUser.userId);
		const created = await createShareV2({ accountIds: [boxA, boxB] });
		const shareId = created.json.data.shareId;
		const mailA = await insertEmail(boxA, ownerUser.userId, { subject: 't24-survivor-a' });
		const mailB = await insertEmail(boxB, ownerUser.userId, { subject: 't24-survivor-b' });
		const session = await openSession(created);
		const bearer = session.json.data.sessionToken;
		expect(mailIdsOf(await jsonApi('GET', '/share/mails?limit=50', { bearer })))
			.toEqual([mailB, mailA]);

		const deleted = await ownerApi('DELETE', `/account/delete?accountId=${boxA}`);
		expect(deleted.json?.code).toBe(200);

		const row = await mailShareRow(shareId);
		expect(row.status).toBe('ACTIVE');
		expect(row.revoked_at).toBeNull();
		// 主表两列跟随幸存者重指,绝不写 0(旧 Worker 见 0 即判链接不可用)。
		expect(row.account_id).toBe(boxB);
		expect((await bindingRows(shareId)).map((item) => item.account_id)).toEqual([boxB]);

		expect(mailIdsOf(await jsonApi('GET', '/share/mails?limit=50', { bearer }))).toEqual([mailB]);
		expectUnavailable(await jsonApi('GET', `/share/mail?mailId=${mailA}`, { bearer }));
	});
});

describe('session quota over HTTP (T-19)', () => {
	it('stops issuing sessions at max_sessions while an already issued token keeps reading (AC-SESS-01, AC-SESS-06, AC-SESS-07, AC-LIFE-04)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShareV2({ accountId, maxSessions: 2 });
		const shareId = created.json.data.shareId;
		const mailId = await insertEmail(accountId, ownerUser.userId, { subject: 't24-quota-mail' });

		const first = await openSession(created);
		const second = await openSession(created);
		expect(first.json?.code).toBe(200);
		expect(second.json?.code).toBe(200);
		expectUnavailable(await openSession(created));
		expect(await accessCount(shareId)).toBe(2);

		// 关门不清场:名额用尽只挡新 Session,已发出的 token 照常读。
		const bearer = first.json.data.sessionToken;
		expect(mailIdsOf(await jsonApi('GET', '/share/mails', { bearer }))).toEqual([mailId]);
		expect((await jsonApi('GET', '/share/mailboxes/status', { bearer })).json?.code).toBe(200);
		expect(await accessCount(shareId)).toBe(2);
	});

	it('never overshoots the last quota slot under concurrent session requests (AC-EDGE-02, AC-SEC-08)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShareV2({ accountId, maxSessions: 1 });

		const results = await Promise.all([openSession(created), openSession(created)]);

		expect(results.filter((item) => item.json?.code === 200)).toHaveLength(1);
		expect(results.filter((item) => item.text === UNAVAILABLE)).toHaveLength(1);
		// 超发的典型形态是「两条都成功但只加了一格」,所以库里的计数必须一起断言。
		expect(await accessCount(created.json.data.shareId)).toBe(1);
	});

	it('replays one session Idempotency-Key on the last slot without consuming a second (AC-SESS-10)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShareV2({ accountId, maxSessions: 1 });
		const shareId = created.json.data.shareId;
		const idempotencyKey = `t24-session-${crypto.randomUUID()}`;

		const first = await openSession(created, { idempotencyKey });
		expect(first.json.data.sessionToken).toEqual(expect.any(String));
		expect(await accessCount(shareId)).toBe(1);

		const replay = await openSession(created, { idempotencyKey });
		expect(replay.json.data.sessionToken).toBe(first.json.data.sessionToken);
		expect(await accessCount(shareId)).toBe(1);

		expectUnavailable(await openSession(created));
		expect(await accessCount(shareId)).toBe(1);
		await env.kv.delete(`${KvConst.SHARE_EST}${created.json.data.lid}:${idempotencyKey}`);
	});

	it('keeps polling free of quota (AC-EDGE-01, AC-SESS-02)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShareV2({ accountId, maxSessions: 2 });
		const shareId = created.json.data.shareId;
		await insertEmail(accountId, ownerUser.userId, { subject: 't24-poll-mail' });
		const session = await openSession(created);
		const bearer = session.json.data.sessionToken;
		expect(await accessCount(shareId)).toBe(1);

		for (let i = 0; i < 3; i++) {
			expect((await jsonApi('GET', '/share/mails?limit=50', { bearer })).json?.code).toBe(200);
			expect((await jsonApi('GET', '/share/mailboxes/status', { bearer })).json?.code).toBe(200);
		}

		// `last_access_at` 允许被写(AC-SESS-09 的 fire-and-forget),配额计数不许动。
		expect(await accessCount(shareId)).toBe(1);
		expect((await openSession(created)).json?.code).toBe(200);
		expect(await accessCount(shareId)).toBe(2);
	});

	it('resets the quota epoch on the first finite max_sessions and honours resetUsedSessions=false (AC-EDGE-14, AC-ADMIN-03, AC-ADMIN-04)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const infinite = await createShare(accountId, { name: 't24-infinite' });
		const infiniteId = infinite.json.data.shareId;
		expect((await openSession(infinite)).json?.code).toBe(200);
		expect((await openSession(infinite)).json?.code).toBe(200);
		expect(await accessCount(infiniteId)).toBe(2);

		// 首次设有限配额即建立配额纪元基线,默认 resetUsedSessions=true。
		const capped = await ownerV2('PUT', '/mailShare/update', {
			body: { shareId: infiniteId, maxSessions: 2 }
		});
		expect(capped.json?.code).toBe(200);
		expect(capped.json.data.usedSessions).toBe(0);
		expect(capped.json.data.maxSessions).toBe(2);
		expect(capped.json.data.effectiveStatus).toBe('ACTIVE');
		expect((await openSession(infinite)).json?.code).toBe(200);
		expect((await openSession(infinite)).json?.code).toBe(200);
		expectUnavailable(await openSession(infinite));
		expect(await accessCount(infiniteId)).toBe(2);

		const kept = await createShare(accountId, { name: 't24-kept' });
		const keptId = kept.json.data.shareId;
		expect((await openSession(kept)).json?.code).toBe(200);
		const notReset = await ownerV2('PUT', '/mailShare/update', {
			body: { shareId: keptId, maxSessions: 1, resetUsedSessions: false }
		});
		expect(notReset.json.data.usedSessions).toBe(1);
		expect(notReset.json.data.effectiveStatus).toBe('ACCESS_LIMIT_REACHED');
		expectUnavailable(await openSession(kept));
	});

	it('keeps the capped share visible and filterable in the owner list (AC-ADMIN-01, AC-ADMIN-09)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const capped = await createShareV2({ accountId, maxSessions: 1, name: 't24-capped' });
		const open = await createShare(accountId, { name: 't24-open' });
		expect((await openSession(capped)).json?.code).toBe(200);

		const listed = await ownerApi('GET', '/mailShare/list?status=ACCESS_LIMIT_REACHED');

		expect(listed.json.data.list.map((row) => row.shareId))
			.toEqual([capped.json.data.shareId]);
		expect(listed.json.data.list[0]).toMatchObject({
			usedSessions: 1,
			maxSessions: 1,
			shareType: 'single',
			status: 'ACTIVE',
			effectiveStatus: 'ACCESS_LIMIT_REACHED'
		});
		expect(listed.text).not.toContain(capped.json.data.sec);
		expect(listed.text).not.toContain(open.json.data.sec);
	});
});

describe('AuthKey over HTTP (T-19)', () => {
	it('mints an AuthKey at create and only lets the keyed visitor in (AC-CAP-05, AC-AUTH-01, AC-EDGE-12)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShareV2({ accountId, authKeyEnabled: true });
		const { authKey, shareId } = created.json.data;
		expect(authKey).toMatch(/^[A-Za-z0-9_-]{22}$/);

		const missing = await openSession(created);
		const wrong = await openSession(created, { authKey: 't24-not-the-key' });
		// 过了 lid+sec 才暴露「还差一把钥匙」,这里必须是 AUTH_REQUIRED 而不是 UNAVAILABLE。
		expect(missing.text).toBe(AUTH_REQUIRED);
		expect(wrong.text).toBe(AUTH_REQUIRED);
		expect(missing.headers.get('Cache-Control')).toBe('no-store');
		expect(await accessCount(shareId)).toBe(0);

		// 铸钥与验钥同源:create 下发的明文拿去建 Session 真能过。
		const ok = await openSession(created, { authKey });
		expect(ok.json?.code).toBe(200);
		expect(ok.json.data.sessionToken).toEqual(expect.any(String));
		expect(await accessCount(shareId)).toBe(1);
	});

	it('only reveals that a key is needed after lid and sec already matched (AC-AUTH-02)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShareV2({ accountId, authKeyEnabled: true });
		const { lid, sec, authKey, shareId } = created.json.data;

		expectIdenticalUnavailable(await Promise.all([
			jsonApi('POST', '/share/session', { body: { lid, sec: 't24-wrong-secret', authKey } }),
			jsonApi('POST', '/share/session', { body: { lid: 't24-never-existed', sec, authKey } }),
			jsonApi('POST', '/share/session', { body: { lid: 't24-never-existed', sec: 'nope', authKey: 'nope' } })
		]));
		expect((await openSession(created)).text).toBe(AUTH_REQUIRED);
		expect(await accessCount(shareId)).toBe(0);
	});

	it('rotates the key over resetAuthKey and kills the live session on the spot (AC-ADMIN-05, AC-EDGE-05)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShareV2({ accountId, authKeyEnabled: true, maxSessions: 3 });
		const shareId = created.json.data.shareId;
		await insertEmail(accountId, ownerUser.userId, { subject: 't24-rotate-mail' });
		const session = await openSession(created, { authKey: created.json.data.authKey });
		const bearer = session.json.data.sessionToken;
		expect((await jsonApi('GET', '/share/mails', { bearer })).json?.code).toBe(200);
		expect(await accessCount(shareId)).toBe(1);

		// reset 不过栅栏(只有 enable 过),所以这一条走 jsonApi。
		const rotated = await ownerApi('POST', '/mailShare/resetAuthKey', {
			body: { shareId, action: 'reset' }
		});
		expect(rotated.json?.code).toBe(200);
		expect(rotated.json.data.authKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(rotated.json.data.authKey).not.toBe(created.json.data.authKey);

		expectIdenticalUnavailable(await Promise.all([
			jsonApi('GET', '/share/mails', { bearer }),
			jsonApi('GET', '/share/mailboxes/status', { bearer })
		]));
		expect((await openSession(created, { authKey: created.json.data.authKey })).text)
			.toBe(AUTH_REQUIRED);
		expect(await accessCount(shareId)).toBe(1);

		const reissued = await openSession(created, { authKey: rotated.json.data.authKey });
		expect(reissued.json?.code).toBe(200);
		// 换钥重进要重新买票:再消耗一格配额。
		expect(await accessCount(shareId)).toBe(2);
	});

	it('enables without retroactively killing a session and disables without asking for a key again (AC-AUTH-07, AC-AUTH-08, AC-LIFE-11)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShare(accountId);
		const shareId = created.json.data.shareId;
		await insertEmail(accountId, ownerUser.userId, { subject: 't24-enable-mail' });
		const preEnable = await openSession(created);
		const preBearer = preEnable.json.data.sessionToken;

		const enabled = await ownerV2('POST', '/mailShare/resetAuthKey', {
			body: { shareId, action: 'enable' }
		});
		expect(enabled.json?.code).toBe(200);
		const authKey = enabled.json.data.authKey;
		expect(authKey).toMatch(/^[A-Za-z0-9_-]{22}$/);

		// 建立时本无 Key 要求的 Session 不追溯失效(cv 未动)。
		expect((await jsonApi('GET', '/share/mails', { bearer: preBearer })).json?.code).toBe(200);
		expect((await openSession(created)).text).toBe(AUTH_REQUIRED);
		const keyed = await openSession(created, { authKey });
		expect(keyed.json?.code).toBe(200);

		// disable 不过栅栏 —— Owner 绝不能被锁死在一个关不掉的第二因子上。
		const disabled = await ownerApi('POST', '/mailShare/resetAuthKey', {
			body: { shareId, action: 'disable' }
		});
		expect(disabled.json?.code).toBe(200);
		expect(disabled.json.data.authKeyEnabled).toBe(false);
		expect(disabled.json.data.authKey).toBeUndefined();

		expectIdenticalUnavailable(await Promise.all([
			jsonApi('GET', '/share/mails', { bearer: preBearer }),
			jsonApi('GET', '/share/mails', { bearer: keyed.json.data.sessionToken })
		]));
		expect((await openSession(created)).json?.code).toBe(200);
		// 多余的旧 Key 被忽略,不得因此报错。
		expect((await openSession(created, { authKey })).json?.code).toBe(200);
	});

	it('never lets the AuthKey plaintext out of the minting response (AC-CAP-05, AC-SEC-09)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShareV2({ accountId, authKeyEnabled: true });
		const { authKey, shareId } = created.json.data;

		const detail = await ownerApi('GET', `/mailShare/get?shareId=${shareId}`);
		expect(detail.json.data.authKeyEnabled).toBe(true);
		expect(detail.text).not.toContain(authKey);
		const listed = await ownerApi('GET', '/mailShare/list');
		expect(listed.json.data.list.map((row) => row.shareId)).toContain(shareId);
		expect(listed.text).not.toContain(authKey);

		const session = await openSession(created, { authKey });
		expect(session.json?.code).toBe(200);
		expect(session.text).not.toContain(authKey);
		await assertSecAbsentFromDatabase(authKey);
	});

	it('refuses enable but allows disable while the capability flag is off (AC-LIFE-11)', async () => {
		const accountId = await insertAccount(MAILBOX, ownerUser.userId);
		const created = await createShare(accountId);
		const shareId = created.json.data.shareId;

		const refused = await ownerApi('POST', '/mailShare/resetAuthKey', {
			body: { shareId, action: 'enable' }
		});
		expect(refused.json?.message).toBe('SHARE_INVALID_CONFIG');
		expect((await mailShareRow(shareId)).auth_key_enabled).toBe(0);

		expect((await ownerV2('POST', '/mailShare/resetAuthKey', {
			body: { shareId, action: 'enable' }
		})).json?.code).toBe(200);
		expect((await mailShareRow(shareId)).auth_key_enabled).toBe(1);

		const disabled = await ownerApi('POST', '/mailShare/resetAuthKey', {
			body: { shareId, action: 'disable' }
		});
		expect(disabled.json?.code).toBe(200);
		expect((await mailShareRow(shareId)).auth_key_enabled).toBe(0);
	});
});
