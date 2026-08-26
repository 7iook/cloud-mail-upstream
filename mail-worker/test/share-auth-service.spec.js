import { env, SELF } from 'cloudflare:test';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import shareApiSource from '../src/api/share-api.js?raw';
import shareAttachmentService from '../src/service/share-attachment-service';
import shareAuthService from '../src/service/share-auth-service';
import shareAuthSource from '../src/service/share-auth-service.js?raw';
import shareResult from '../src/model/share-result';
import { isDel } from '../src/const/entity-const';
import { withLocalTimezoneShift } from './setup.js';

const PEPPER_V1 = 't08-pepper-v1-fixed-test-value';
const PEPPER_V2 = 't08-pepper-v2-fixed-test-value';
const SIGN_V1 = 't08-session-sign-v1-fixed-test-value';
const SIGN_V2 = 't08-session-sign-v2-fixed-test-value';
const USER_ID = 800001;
const ACCOUNT_ID = 800042;
const MAILBOX = 't08-share@example.com';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function authEnv(overrides = {}) {
	return {
		...env,
		SHARE_SEC_PEPPER: PEPPER_V2,
		SHARE_SEC_PEPPER_KID: 'v2',
		SHARE_SEC_PEPPER_PREV: PEPPER_V1,
		SHARE_SEC_PEPPER_PREV_KID: 'v1',
		SHARE_SESSION_SIGNING_KEY: SIGN_V2,
		SHARE_SESSION_SIGNING_KID: 'v2',
		SHARE_SESSION_SIGNING_KEY_PREV: SIGN_V1,
		SHARE_SESSION_SIGNING_KID_PREV: 'v1',
		SHARE_SESSION_TTL: '900',
		SHARE_ENABLED: '1',
		...overrides
	};
}

function ctx(overrides = {}) {
	return { env: authEnv(overrides) };
}

async function hmacHex(key, message) {
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

const UNAVAILABLE_BODY = JSON.stringify(shareResult.fail('SHARE_UNAVAILABLE', 501));
const AUTH_REQUIRED_BODY = JSON.stringify(shareResult.fail('SHARE_AUTH_REQUIRED', 501));
// P4:gone(无行 / REVOKED)从「不可用」家族里分出来,share-api 把它翻成裸 404。
const DESTROYED_BODY = JSON.stringify(shareResult.fail('SHARE_DESTROYED', 404));
const AUTH_KEY = 't08-auth-key-correct-value';

function failEnvelope(err) {
	return JSON.stringify(shareResult.fail(err.message, err.code));
}

async function catchFail(promise) {
	try {
		await promise;
	} catch (err) {
		return failEnvelope(err);
	}
	throw new Error('expected SHARE_UNAVAILABLE');
}

function randomLid(label) {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `t08-${label}-${hex}`;
}

function randomSec() {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeTokenPayload(token) {
	const parts = String(token).split('.');
	let padded = parts[2].replace(/-/g, '+').replace(/_/g, '/');
	while (padded.length % 4) {
		padded += '=';
	}
	return JSON.parse(decoder.decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))));
}

// The quota gate is the only statement establishSession writes; matching it by SQL
// text lets a test interleave state changes around it without any production seam.
const QUOTA_UPDATE_SQL = /^update\s+"mail_share"\s+set\s+"access_count"/i;

// Wraps the D1 binding handed to orm(c) so `before` runs after the gate statement is
// prepared but before it executes, and `after` runs once it has committed. bind()
// returns a fresh statement object, so the wrapper has to re-apply itself there.
function injectingDb(db, { before, after } = {}) {
	const wrapStatement = (stmt) => new Proxy(stmt, {
		get(target, prop) {
			const value = target[prop];
			if (typeof value !== 'function') {
				return value;
			}
			if (prop === 'bind') {
				return (...args) => wrapStatement(value.apply(target, args));
			}
			if (prop === 'all' || prop === 'run' || prop === 'first' || prop === 'raw') {
				return async (...args) => {
					if (before) {
						await before();
					}
					const out = await value.apply(target, args);
					if (after) {
						await after();
					}
					return out;
				};
			}
			return value.bind(target);
		}
	});
	return new Proxy(db, {
		get(target, prop) {
			const value = target[prop];
			if (typeof value !== 'function') {
				return value;
			}
			if (prop !== 'prepare') {
				return value.bind(target);
			}
			return (sql) => {
				const stmt = value.call(target, sql);
				return QUOTA_UPDATE_SQL.test(String(sql).trim()) ? wrapStatement(stmt) : stmt;
			};
		}
	});
}

async function captureLogs(run) {
	const lines = [];
	const log = console.log;
	console.log = (...args) => lines.push(args.map(String).join(' '));
	try {
		await run();
	} finally {
		console.log = log;
	}
	return lines;
}

function eventsNamed(lines, event) {
	return lines
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter((entry) => entry && entry.event === event);
}

function quotaEvents(lines) {
	return eventsNamed(lines, 'share.session.denied_quota');
}

function systemErrors(lines) {
	return eventsNamed(lines, 'share.system.error');
}

// Stands in for the `kv` binding the same way injectingDb stands in for `db`: the
// service only ever sees c.env.kv, so a plain object is enough to record calls and
// to simulate an outage on either side.
function recordingKv({ getThrows = false, putThrows = false } = {}) {
	const store = new Map();
	const gets = [];
	const puts = [];
	return {
		store,
		gets,
		puts,
		binding: {
			get: async (key, options) => {
				gets.push(key);
				if (getThrows) {
					throw new Error('kv get unavailable');
				}
				const raw = store.get(key);
				if (raw === undefined) {
					return null;
				}
				return options && options.type === 'json' ? JSON.parse(raw) : raw;
			},
			put: async (key, value, options) => {
				puts.push({ key, value, options });
				if (putThrows) {
					throw new Error('kv put unavailable');
				}
				store.set(key, value);
			}
		}
	};
}

async function quotaRow(shareId) {
	return await env.db.prepare(
		'SELECT access_count, last_access_at, status, credentials_version FROM mail_share WHERE share_id = ?'
	).bind(shareId).first();
}

// The deployed worker signs with the wrangler-vitest ring, so endpoint-level reads
// have to be established through the worker rather than with the spec-local keys.
async function shareFetch(method, path, { bearer, body, headers: extraHeaders } = {}) {
	const headers = { 'accept-language': 'en', ...(extraHeaders || {}) };
	if (bearer) {
		headers.Authorization = `Bearer ${bearer}`;
	}
	if (body !== undefined) {
		headers['content-type'] = 'application/json';
	}
	const response = await SELF.fetch(`http://example.com/api${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const text = await response.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = null;
	}
	return { status: response.status, text, json };
}

const seededLids = [];
const seededShareIds = [];
const seededAccountIds = new Set();

async function ensureAccount({ accountId = ACCOUNT_ID, email = MAILBOX, deleted = false } = {}) {
	seededAccountIds.add(accountId);
	await env.db.prepare('DELETE FROM account WHERE account_id = ? OR email = ?').bind(accountId, email).run();
	await env.db.prepare(`
		INSERT INTO account (account_id, email, name, user_id, is_del)
		VALUES (?, ?, ?, ?, ?)
	`).bind(accountId, email, 't08', USER_ID, deleted ? isDel.DELETE : isDel.NORMAL).run();
}

// Every column here stays out of the INSERT unless the case names it, so a
// pre-existing case still gets exactly the v3_2DB defaults it was written against.
// W1 has no writer for credentials_version or the AuthKey columns (resetAuthKey
// lands in T-16), so those predicates can only be exercised by seeding directly.
const OPTIONAL_SHARE_COLUMNS = [
	['max_sessions', 'maxSessions'],
	['access_count', 'accessCount'],
	['credentials_version', 'credentialsVersion'],
	['auth_key_enabled', 'authKeyEnabled'],
	['auth_key_hash', 'authKeyHash'],
	['auth_key_kid', 'authKeyKid'],
	['message_limit', 'messageLimit'],
	['otp_extraction_enabled', 'otpExtractionEnabled'],
	['auto_refresh', 'autoRefresh'],
	['refresh_interval_ms', 'refreshIntervalMs'],
	['show_full_address', 'showFullAddress']
];

async function insertShare(options) {
	const {
		lid,
		sec,
		pepper = PEPPER_V2,
		pepperKid = 'v2',
		status = 'ACTIVE',
		expiresAt = '2099-01-01 00:00:00',
		accountId = ACCOUNT_ID,
		windowStartEmailId = 10
	} = options;
	const secHmac = await hmacHex(pepper, sec);
	seededLids.push(lid);
	const columns = [
		'lid', 'sec_hmac', 'pepper_kid', 'user_id', 'account_id', 'status',
		'window_start_email_id', 'expires_at', 'delete_at'
	];
	const values = [
		lid, secHmac, pepperKid, USER_ID, accountId, status,
		windowStartEmailId, expiresAt, '2099-12-31 00:00:00'
	];
	for (const [column, prop] of OPTIONAL_SHARE_COLUMNS) {
		if (options[prop] !== undefined) {
			columns.push(column);
			values.push(options[prop]);
		}
	}
	await env.db.prepare(`
		INSERT INTO mail_share (${columns.join(', ')})
		VALUES (${columns.map(() => '?').join(', ')})
	`).bind(...values).run();
	const row = await env.db.prepare('SELECT share_id FROM mail_share WHERE lid = ?').bind(lid).first();
	seededShareIds.push(row.share_id);
	return { shareId: row.share_id, secHmac };
}

// The primary Binding is the lowest binding_id under a share, so insertion order
// is precedence order.
async function insertBinding(shareId, accountId, windowStartEmailId = 0) {
	const row = await env.db.prepare(`
		INSERT INTO mail_share_binding (share_id, account_id, window_start_email_id)
		VALUES (?, ?, ?)
		RETURNING binding_id
	`).bind(shareId, accountId, windowStartEmailId).first();
	return row.binding_id;
}

async function authKeyShare({ lid, sec, authKey = AUTH_KEY, pepper = PEPPER_V2, authKeyKid = 'v2', ...rest }) {
	return await insertShare({
		lid,
		sec,
		authKeyEnabled: 1,
		authKeyHash: await hmacHex(pepper, authKey),
		authKeyKid,
		...rest
	});
}

async function cleanup() {
	if (seededShareIds.length) {
		const placeholders = seededShareIds.map(() => '?').join(', ');
		await env.db.prepare(
			`DELETE FROM mail_share_binding WHERE share_id IN (${placeholders})`
		).bind(...seededShareIds).run();
		seededShareIds.length = 0;
	}
	if (seededLids.length) {
		const placeholders = seededLids.map(() => '?').join(', ');
		await env.db.prepare(`DELETE FROM mail_share WHERE lid IN (${placeholders})`).bind(...seededLids).run();
		seededLids.length = 0;
	}
	for (const accountId of seededAccountIds) {
		await env.db.prepare('DELETE FROM account WHERE account_id = ? OR email LIKE ?').bind(accountId, 't08-%@example.com').run();
	}
	seededAccountIds.clear();
}

afterEach(async () => {
	await cleanup();
});

describe('shareAuthService', () => {
	it('returns byte-identical SHARE_UNAVAILABLE envelopes for illegal visitor inputs (AC-VISIT-04, P-AUTH-01)', async () => {
		await ensureAccount();
		const liveLid = randomLid('live');
		const liveSec = randomSec();
		await insertShare({ lid: liveLid, sec: liveSec });

		const expiredLid = randomLid('exp');
		const expiredSec = randomSec();
		await insertShare({ lid: expiredLid, sec: expiredSec, expiresAt: '2001-01-01 00:00:00' });

		const revokedLid = randomLid('rev');
		const revokedSec = randomSec();
		await insertShare({ lid: revokedLid, sec: revokedSec, status: 'REVOKED' });

		const deadAccountId = 800099;
		await ensureAccount({ accountId: deadAccountId, email: 't08-dead@example.com', deleted: true });
		const deadLid = randomLid('dead');
		const deadSec = randomSec();
		await insertShare({ lid: deadLid, sec: deadSec, accountId: deadAccountId });

		// P4 把「不可用」拆成两族:gone(无行/REVOKED)→ SHARE_DESTROYED(HTTP 层裸 404),
		// 其余(错 sec/过期/死信箱/功能关)仍是字节一致的 SHARE_UNAVAILABLE 信封。
		const unavailableBodies = await Promise.all([
			catchFail(shareAuthService.establishSession(ctx(), liveLid, randomSec())),
			catchFail(shareAuthService.establishSession(ctx(), expiredLid, expiredSec)),
			catchFail(shareAuthService.establishSession(ctx(), deadLid, deadSec)),
			catchFail(shareAuthService.establishSession(ctx({ SHARE_ENABLED: '0' }), liveLid, liveSec))
		]);
		for (const body of unavailableBodies) {
			expect(body).toBe(UNAVAILABLE_BODY);
		}
		expect(new Set(unavailableBodies).size).toBe(1);

		const goneBodies = await Promise.all([
			catchFail(shareAuthService.establishSession(ctx(), randomLid('missing'), randomSec())),
			catchFail(shareAuthService.establishSession(ctx(), revokedLid, revokedSec)),
			// gone 不看 sec:销毁的链接对谁都是 404,不因 sec 对错分叉出可探测面。
			catchFail(shareAuthService.establishSession(ctx(), revokedLid, randomSec()))
		]);
		for (const body of goneBodies) {
			expect(body).toBe(DESTROYED_BODY);
		}
	});
	it('rejects a token on the next request after the share is revoked (AC-VISIT-07, AC-LIFE-03)', async () => {
		await ensureAccount();
		const lid = randomLid('revoke-after');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec });
		const c = ctx();

		const established = await shareAuthService.establishSession(c, lid, sec);
		expect(established.sessionToken).toEqual(expect.any(String));
		expect(established.sessionToken).not.toContain(sec);
		expect(established.mailbox).toBe(MAILBOX);

		const first = await shareAuthService.resolveSession(c, established.sessionToken);
		expect(first).toMatchObject({
			shareId,
			accountId: ACCOUNT_ID,
			windowStartEmailId: 10,
			effectiveStatus: 'ACTIVE'
		});

		await env.db.prepare(
			"UPDATE mail_share SET status = 'REVOKED', revoked_at = '2026-08-17 00:00:00' WHERE share_id = ?"
		).bind(shareId).run();

		// P4:销毁对已持会话的访客也是 gone,share-api 将其翻成裸 404。
		const afterRevoke = await catchFail(shareAuthService.resolveSession(c, established.sessionToken));
		expect(afterRevoke).toBe(DESTROYED_BODY);
	});

	it('treats expiry as computed from expires_at while persisted status stays ACTIVE (AC-LIFE-01)', async () => {
		await ensureAccount();
		const lid = randomLid('computed-exp');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec, expiresAt: '2001-01-01 00:00:00' });
		const body = await catchFail(shareAuthService.establishSession(ctx(), lid, sec));
		expect(body).toBe(JSON.stringify(shareResult.fail('SHARE_UNAVAILABLE', 501)));
		const row = await env.db.prepare('SELECT status FROM mail_share WHERE share_id = ?').bind(shareId).first();
		expect(row.status).toBe('ACTIVE');
	});
	it('validates a share hashed with the previous pepper after rotation (AC-VISIT-03)', async () => {
		await ensureAccount();
		const lid = randomLid('pepper-prev');
		const sec = randomSec();
		await insertShare({ lid, sec, pepper: PEPPER_V1, pepperKid: 'v1' });
		const established = await shareAuthService.establishSession(ctx(), lid, sec);
		expect(established.sessionToken).toEqual(expect.any(String));
	});

	it('does not accept a share hmac produced under a different pepper than the row pepper_kid (AC-VISIT-03)', async () => {
		await ensureAccount();
		const lid = randomLid('pepper-cross');
		const sec = randomSec();
		await insertShare({ lid, sec, pepper: PEPPER_V1, pepperKid: 'v2' });
		const body = await catchFail(shareAuthService.establishSession(ctx(), lid, sec));
		expect(body).toBe(JSON.stringify(shareResult.fail('SHARE_UNAVAILABLE', 501)));
	});

	it('validates each overlapping pepper_kid against its own pepper (AC-VISIT-03)', async () => {
		await ensureAccount();
		const lidV1 = randomLid('pepper-overlap-v1');
		const secV1 = randomSec();
		const lidV2 = randomLid('pepper-overlap-v2');
		const secV2 = randomSec();
		await insertShare({ lid: lidV1, sec: secV1, pepper: PEPPER_V1, pepperKid: 'v1' });
		await insertShare({ lid: lidV2, sec: secV2, pepper: PEPPER_V2, pepperKid: 'v2' });
		const first = await shareAuthService.establishSession(ctx(), lidV1, secV1);
		const second = await shareAuthService.establishSession(ctx(), lidV2, secV2);
		expect(first.sessionToken).toEqual(expect.any(String));
		expect(second.sessionToken).toEqual(expect.any(String));
	});

	it('returns SHARE_UNAVAILABLE when the row pepper_kid is not configured (AC-VISIT-04)', async () => {
		await ensureAccount();
		const lid = randomLid('pepper-gone');
		const sec = randomSec();
		await insertShare({ lid, sec, pepper: PEPPER_V2, pepperKid: 'v9' });
		const body = await catchFail(shareAuthService.establishSession(ctx(), lid, sec));
		expect(body).toBe(JSON.stringify(shareResult.fail('SHARE_UNAVAILABLE', 501)));
	});

	// Semantic reversal of the former "still issues a session when access accounting
	// fails (mail-share AC-LIFE-14)": once accounting IS the quota gate, a write that
	// never lands must refuse instead of hand out an unmetered session.
	it('refuses the session when the quota UPDATE itself throws (AC-SESS-11)', async () => {
		await ensureAccount();
		const lid = randomLid('acct-fail');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec });
		const failing = ctx({
			db: injectingDb(env.db, {
				before: () => {
					throw new Error('d1 write failed');
				}
			})
		});

		const body = await catchFail(shareAuthService.establishSession(failing, lid, sec));
		expect(body).toBe(UNAVAILABLE_BODY);

		const row = await quotaRow(shareId);
		expect(row.access_count).toBe(0);
		expect(row.last_access_at).toBeNull();
	});

	it('increments access_count only on successful establish (mail-share AC-LIFE-10)', async () => {
		await ensureAccount();
		const lid = randomLid('acct-ok');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec });
		await shareAuthService.establishSession(ctx(), lid, sec);
		await shareAuthService.establishSession(ctx(), lid, sec);
		const row = await env.db.prepare(
			'SELECT access_count, last_access_at FROM mail_share WHERE share_id = ?'
		).bind(shareId).first();
		expect(row.access_count).toBe(2);
		expect(row.last_access_at).toEqual(expect.any(String));
	});

	// `nowText()` 同时是配额闸门的 `expires_at > ?` 比较基准和 `last_access_at` 的写入值。
	// 取进程本地时间时，UTC+8 的进程会写出比真实时刻晚 8 小时的裸串，管理台照抄即错。
	it('writes last_access_at as UTC even from a UTC+8 process (WA-TZ)', async () => {
		await ensureAccount();
		const lid = randomLid('tz-utc');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec });
		const before = Date.now();
		await withLocalTimezoneShift(8, () => shareAuthService.establishSession(ctx(), lid, sec));
		const after = Date.now();
		const row = await quotaRow(shareId);
		const writtenMs = Date.parse(`${row.last_access_at.replace(' ', 'T')}Z`);
		expect(writtenMs).toBeGreaterThanOrEqual(before - 1000);
		expect(writtenMs).toBeLessThanOrEqual(after + 1000);
	});
	it('does not write sec or session token to logs (AC-LEAK-05)', async () => {
		await ensureAccount();
		const lid = randomLid('nolog');
		const sec = randomSec();
		await insertShare({ lid, sec });
		const lines = [];
		const log = console.log;
		const error = console.error;
		console.log = (...args) => lines.push(args.map(String).join(' '));
		console.error = (...args) => lines.push(args.map(String).join(' '));
		try {
			await catchFail(shareAuthService.establishSession(ctx(), lid, 'wrong-sec-value-not-real'));
			const established = await shareAuthService.establishSession(ctx(), lid, sec);
			const joined = lines.join('\n');
			expect(joined).not.toContain(sec);
			expect(joined).not.toContain('wrong-sec-value-not-real');
			expect(joined).not.toContain(established.sessionToken);
		} finally {
			console.log = log;
			console.error = error;
		}
	});

	it('bounds the default session to 15 minutes and re-establishes with lid and sec after expiry (AC-VISIT-11, AC-VISIT-12, AC-LIFE-01)', async () => {
		await ensureAccount();
		const lid = randomLid('ttl-reest');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec });
		const c = ctx({ SHARE_SESSION_TTL: '' });
		const t0 = 1_700_000_000_000;
		const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
		try {
			const first = await shareAuthService.establishSession(c, lid, sec);
			const payload = decodeTokenPayload(first.sessionToken);
			expect(payload.exp - payload.iat).toBe(900);
			expect(payload.lid).toBe(lid);

			const live = await shareAuthService.resolveSession(c, first.sessionToken);
			expect(live.shareId).toBe(shareId);

			nowSpy.mockReturnValue(t0 + 900_000 + 1_000);
			const expired = await catchFail(shareAuthService.resolveSession(c, first.sessionToken));
			expect(expired).toBe(JSON.stringify(shareResult.fail('SHARE_UNAVAILABLE', 501)));

			const second = await shareAuthService.establishSession(c, lid, sec);
			expect(second.sessionToken).toEqual(expect.any(String));
			expect(second.sessionToken).not.toBe(first.sessionToken);
			const restored = await shareAuthService.resolveSession(c, second.sessionToken);
			expect(restored.shareId).toBe(shareId);
			expect(restored.effectiveStatus).toBe('ACTIVE');

			const stillDead = await catchFail(shareAuthService.resolveSession(c, first.sessionToken));
			expect(stillDead).toBe(JSON.stringify(shareResult.fail('SHARE_UNAVAILABLE', 501)));
		} finally {
			nowSpy.mockRestore();
		}
	});

	it('ranks effectiveStatus REVOKED > EXPIRED > ACCESS_LIMIT_REACHED > ACTIVE without touching storage (AC-LIFE-01, AC-LIFE-02, P-LIFE-02)', async () => {
		const now = '2026-08-24 00:00:00';
		const before = await env.db.prepare('SELECT COUNT(*) AS n FROM mail_share').first();

		fc.assert(
			fc.property(
				fc.record({
					status: fc.constantFrom('ACTIVE', 'REVOKED'),
					expiresAt: fc.constantFrom('2001-01-01 00:00:00', now, '2099-01-01 00:00:00'),
					maxSessions: fc.oneof(fc.constant(null), fc.constant(undefined), fc.integer({ min: 0, max: 4 })),
					accessCount: fc.integer({ min: 0, max: 4 }),
					accountId: fc.integer({ min: 1, max: 9 })
				}),
				(row) => {
					const frozen = Object.freeze({ ...row });
					const state = shareAuthService.effectiveStatus(frozen, now);
					expect(['REVOKED', 'EXPIRED', 'ACCESS_LIMIT_REACHED', 'ACTIVE']).toContain(state);
					expect(shareAuthService.effectiveStatus(frozen, now)).toBe(state);
					const capped = frozen.maxSessions != null && frozen.accessCount >= frozen.maxSessions;
					if (frozen.status === 'REVOKED') {
						expect(state).toBe('REVOKED');
					} else if (frozen.expiresAt <= now) {
						expect(state).toBe('EXPIRED');
					} else if (capped) {
						expect(state).toBe('ACCESS_LIMIT_REACHED');
					} else {
						expect(state).toBe('ACTIVE');
					}
				}
			),
			{ numRuns: 200 }
		);

		const after = await env.db.prepare('SELECT COUNT(*) AS n FROM mail_share').first();
		expect(after.n).toBe(before.n);

		const live = { status: 'ACTIVE', expiresAt: '2099-01-01 00:00:00', accountId: 1 };
		// A configured cap of 0 is reached at zero access; only NULL/undefined means unlimited.
		expect(shareAuthService.effectiveStatus({ ...live, maxSessions: 0, accessCount: 0 }, now)).toBe('ACCESS_LIMIT_REACHED');
		expect(shareAuthService.effectiveStatus({ ...live, maxSessions: null, accessCount: 99 }, now)).toBe('ACTIVE');
		expect(shareAuthService.effectiveStatus({ ...live, accessCount: 99 }, now)).toBe('ACTIVE');
	});

	it('keeps an issued session readable after the cap is reached while refusing a new session (AC-SESS-06, AC-LIFE-04, P-SESS-03)', async () => {
		await ensureAccount();
		const lid = randomLid('cap-hit');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec, maxSessions: 1 });
		const c = ctx();

		const established = await shareAuthService.establishSession(c, lid, sec);
		const seeded = await env.db.prepare(
			'SELECT access_count, max_sessions, status FROM mail_share WHERE share_id = ?'
		).bind(shareId).first();
		expect(seeded.max_sessions).toBe(1);
		expect(seeded.access_count).toBe(1);

		const resolved = await shareAuthService.resolveSession(c, established.sessionToken);
		expect(resolved).toMatchObject({
			shareId,
			accountId: ACCOUNT_ID,
			windowStartEmailId: 10,
			effectiveStatus: 'ACCESS_LIMIT_REACHED'
		});

		const denied = await catchFail(shareAuthService.establishSession(c, lid, sec));
		expect(denied).toBe(JSON.stringify(shareResult.fail('SHARE_UNAVAILABLE', 501)));

		const afterDeny = await env.db.prepare(
			'SELECT access_count, status FROM mail_share WHERE share_id = ?'
		).bind(shareId).first();
		expect(afterDeny.access_count).toBe(1);
		expect(afterDeny.status).toBe('ACTIVE');
	});

	it('serves both establish and resolve while access_count is below max_sessions (AC-LIFE-02)', async () => {
		await ensureAccount();
		const lid = randomLid('cap-below');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec, maxSessions: 3, accessCount: 1 });
		const c = ctx();

		const established = await shareAuthService.establishSession(c, lid, sec);
		const resolved = await shareAuthService.resolveSession(c, established.sessionToken);
		expect(resolved).toMatchObject({ shareId, effectiveStatus: 'ACTIVE' });
		const row = await env.db.prepare('SELECT access_count FROM mail_share WHERE share_id = ?').bind(shareId).first();
		expect(row.access_count).toBe(2);
	});

	it('lets expiry and revocation outrank the cap on the resolve path (AC-LIFE-02, AC-LIFE-05)', async () => {
		await ensureAccount();
		const c = ctx();

		const expiredLid = randomLid('cap-then-exp');
		const expiredSec = randomSec();
		const expired = await insertShare({ lid: expiredLid, sec: expiredSec, maxSessions: 1 });
		const expiredSession = await shareAuthService.establishSession(c, expiredLid, expiredSec);
		await env.db.prepare("UPDATE mail_share SET expires_at = '2001-01-01 00:00:00' WHERE share_id = ?")
			.bind(expired.shareId).run();
		expect(await catchFail(shareAuthService.resolveSession(c, expiredSession.sessionToken)))
			.toBe(JSON.stringify(shareResult.fail('SHARE_UNAVAILABLE', 501)));

		const revokedLid = randomLid('cap-then-rev');
		const revokedSec = randomSec();
		const revoked = await insertShare({ lid: revokedLid, sec: revokedSec, maxSessions: 1 });
		const revokedSession = await shareAuthService.establishSession(c, revokedLid, revokedSec);
		await env.db.prepare("UPDATE mail_share SET status = 'REVOKED' WHERE share_id = ?")
			.bind(revoked.shareId).run();
		// 撤销仍旧盖过 cap,只是 P4 后它的形态是 gone 而不是「不可用」。
		expect(await catchFail(shareAuthService.resolveSession(c, revokedSession.sessionToken)))
			.toBe(DESTROYED_BODY);
	});

	it('never persists a computed status on any seeded row (AC-LIFE-01)', async () => {
		await ensureAccount();
		const cappedLid = randomLid('persist-cap');
		const cappedSec = randomSec();
		await insertShare({ lid: cappedLid, sec: cappedSec, maxSessions: 1, accessCount: 1 });
		const expiredLid = randomLid('persist-exp');
		await insertShare({ lid: expiredLid, sec: randomSec(), expiresAt: '2001-01-01 00:00:00' });
		const revokedLid = randomLid('persist-rev');
		await insertShare({ lid: revokedLid, sec: randomSec(), status: 'REVOKED' });

		expect(await catchFail(shareAuthService.establishSession(ctx(), cappedLid, cappedSec)))
			.toBe(JSON.stringify(shareResult.fail('SHARE_UNAVAILABLE', 501)));

		const placeholders = seededLids.map(() => '?').join(', ');
		const seeded = await env.db.prepare(
			`SELECT status FROM mail_share WHERE lid IN (${placeholders})`
		).bind(...seededLids).all();
		expect(seeded.results.length).toBe(seededLids.length);
		for (const row of seeded.results) {
			expect(['ACTIVE', 'REVOKED']).toContain(row.status);
		}

		const computed = await env.db.prepare(
			"SELECT COUNT(*) AS n FROM mail_share WHERE status IN ('ACCESS_LIMIT_REACHED', 'EXPIRED')"
		).first();
		expect(computed.n).toBe(0);
	});
});

// expires_at 是 UTC 裸串，夹具必须同口径构造。本地时区 getter 会在 UTC+8 的宿主上
// 把「60 秒后到期」写成「8 小时后到期」，让 issueToken 的绝对上界断言失去判别力。
// 写法与 setup.js 的 sqlTime / mail-share-service.spec.js 的同名夹具一致。
function futureText(secondsFromNow) {
	return new Date(Date.now() + secondsFromNow * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function functionSource(rawSource, name) {
	// `?raw` hands back the bytes on disk. With core.autocrlf=true (git's Windows
	// default, and this repo ships no .gitattributes) the checkout is CRLF, so the
	// '\n}\n' terminator below never matches and every caller reads end === -1.
	const source = rawSource.replace(/\r\n/g, '\n');
	const start = source.indexOf(`async function ${name}(`);
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf('\n}\n', start);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe('shareAuthService session quota gate', () => {
	it('consumes exactly one slot per established session and keeps the absolute exp bound (AC-SESS-01, AC-SESS-05)', async () => {
		await ensureAccount();
		const lid = randomLid('gate-one');
		const sec = randomSec();
		const expiresAt = futureText(60);
		const { shareId } = await insertShare({ lid, sec, maxSessions: 5, expiresAt });

		const established = await shareAuthService.establishSession(ctx(), lid, sec);
		expect(established.sessionToken).toEqual(expect.any(String));

		const row = await quotaRow(shareId);
		expect(row.access_count).toBe(1);
		expect(row.last_access_at).toEqual(expect.any(String));

		// issueToken now runs after the gate; exp must still be min(expires_at, iat+TTL).
		const payload = decodeTokenPayload(established.sessionToken);
		expect(payload.exp - payload.iat).toBeLessThanOrEqual(61);
		expect(payload.exp - payload.iat).toBeGreaterThan(0);
		expect(payload.exp).toBeLessThan(payload.iat + 900);
	});

	it('lets exactly one of six concurrent visitors take the last slot (AC-EDGE-02, AC-SESS-07, P-SESS-01)', async () => {
		await ensureAccount();
		const lid = randomLid('gate-last-slot');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec, maxSessions: 3, accessCount: 2 });
		const c = ctx();

		// Every one of these reads the same `access_count = 2 < 3` snapshot, so the
		// snapshot check cannot separate them; only the conditional UPDATE can.
		const settled = await Promise.allSettled(
			Array.from({ length: 6 }, () => shareAuthService.establishSession(c, lid, sec))
		);

		const fulfilled = settled.filter((item) => item.status === 'fulfilled');
		const rejected = settled.filter((item) => item.status === 'rejected');
		expect(fulfilled.length).toBe(1);
		expect(rejected.length).toBe(5);
		expect(fulfilled[0].value.sessionToken).toEqual(expect.any(String));
		for (const item of rejected) {
			expect(failEnvelope(item.reason)).toBe(UNAVAILABLE_BODY);
		}

		const row = await quotaRow(shareId);
		expect(row.access_count).toBe(3);
		expect(row.status).toBe('ACTIVE');
	});

	it('never overshoots max_sessions when eight visitors race an empty quota (AC-SESS-01, AC-SESS-07, P-SESS-01)', async () => {
		await ensureAccount();
		const lid = randomLid('gate-race-empty');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec, maxSessions: 3, accessCount: 0 });
		const c = ctx();

		const settled = await Promise.allSettled(
			Array.from({ length: 8 }, () => shareAuthService.establishSession(c, lid, sec))
		);

		expect(settled.filter((item) => item.status === 'fulfilled').length).toBe(3);
		const row = await quotaRow(shareId);
		expect(row.access_count).toBe(3);
	});

	it('leaves an unlimited share unthrottled while still counting every session (AC-SESS-01)', async () => {
		await ensureAccount();
		const lid = randomLid('gate-unlimited');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec });
		const c = ctx();

		const settled = await Promise.allSettled(
			Array.from({ length: 3 }, () => shareAuthService.establishSession(c, lid, sec))
		);
		expect(settled.filter((item) => item.status === 'fulfilled').length).toBe(3);

		const row = await quotaRow(shareId);
		expect(row.access_count).toBe(3);
	});

	it('refuses when credentials_version moves between the snapshot and the gate (AC-SESS-01, AC-EDGE-13)', async () => {
		await ensureAccount();
		const lid = randomLid('gate-cv');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec, credentialsVersion: 7 });
		const drifting = ctx({
			db: injectingDb(env.db, {
				before: async () => {
					await env.db.prepare('UPDATE mail_share SET credentials_version = 8 WHERE share_id = ?')
						.bind(shareId).run();
				}
			})
		});

		// Nothing else moved: still ACTIVE, unexpired, uncapped. Only cv can refuse here.
		expect(await catchFail(shareAuthService.establishSession(drifting, lid, sec))).toBe(UNAVAILABLE_BODY);

		const row = await quotaRow(shareId);
		expect(row.credentials_version).toBe(8);
		expect(row.access_count).toBe(0);
		expect(row.last_access_at).toBeNull();
	});

	it('refuses when the Owner enables the AuthKey between the snapshot and the gate (AC-AUTH-01, AC-AUTH-07)', async () => {
		await ensureAccount();
		const lid = randomLid('gate-auth-enable');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec });
		const enabling = ctx({
			db: injectingDb(env.db, {
				before: async () => {
					await env.db.prepare(`
						UPDATE mail_share
						SET auth_key_enabled = 1, auth_key_hash = ?, auth_key_kid = 'v2'
						WHERE share_id = ?
					`).bind(await hmacHex(PEPPER_V2, AUTH_KEY), shareId).run();
				}
			})
		});

		// The snapshot saw auth_key_enabled = 0, so the second factor was skipped, and
		// enable deliberately does not bump credentials_version (AC-AUTH-07). Only the
		// gate predicate can stop this request from minting an unkeyed token on a share
		// that is keyed by the time the slot is spent.
		expect(await catchFail(shareAuthService.establishSession(enabling, lid, sec))).toBe(UNAVAILABLE_BODY);

		const row = await quotaRow(shareId);
		expect(row.access_count).toBe(0);
		expect(row.last_access_at).toBeNull();
		expect(row.credentials_version).toBe(0);
	});

	it('refuses with zero consumption when revoke or expiry commits before the gate (AC-EDGE-13)', async () => {
		await ensureAccount();

		const revokedLid = randomLid('gate-pre-revoke');
		const revokedSec = randomSec();
		const revoked = await insertShare({ lid: revokedLid, sec: revokedSec, maxSessions: 3 });
		const revoking = ctx({
			db: injectingDb(env.db, {
				before: async () => {
					await env.db.prepare("UPDATE mail_share SET status = 'REVOKED' WHERE share_id = ?")
						.bind(revoked.shareId).run();
				}
			})
		});
		expect(await catchFail(shareAuthService.establishSession(revoking, revokedLid, revokedSec)))
			.toBe(UNAVAILABLE_BODY);
		const revokedRow = await quotaRow(revoked.shareId);
		expect(revokedRow.access_count).toBe(0);

		const expiredLid = randomLid('gate-pre-expire');
		const expiredSec = randomSec();
		const expired = await insertShare({ lid: expiredLid, sec: expiredSec, maxSessions: 3 });
		const expiring = ctx({
			db: injectingDb(env.db, {
				before: async () => {
					await env.db.prepare("UPDATE mail_share SET expires_at = '2001-01-01 00:00:00' WHERE share_id = ?")
						.bind(expired.shareId).run();
				}
			})
		});
		expect(await catchFail(shareAuthService.establishSession(expiring, expiredLid, expiredSec)))
			.toBe(UNAVAILABLE_BODY);
		const expiredRow = await quotaRow(expired.shareId);
		expect(expiredRow.access_count).toBe(0);
	});

	it('does not refund the slot when revocation lands after the gate and fails the first read (AC-EDGE-13)', async () => {
		await ensureAccount();
		const lid = randomLid('gate-toctou');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec, maxSessions: 3 });
		const racing = ctx({
			db: injectingDb(env.db, {
				after: async () => {
					await env.db.prepare("UPDATE mail_share SET status = 'REVOKED' WHERE share_id = ?")
						.bind(shareId).run();
				}
			})
		});

		const established = await shareAuthService.establishSession(racing, lid, sec);
		expect(established.sessionToken).toEqual(expect.any(String));

		// Documented TOCTOU window: the token is dead on its first trip back.
		// P4 后「死」的形态是 gone(裸 404),因为杀死它的正是一次撤销。
		expect(await catchFail(shareAuthService.resolveSession(ctx(), established.sessionToken)))
			.toBe(DESTROYED_BODY);

		const row = await quotaRow(shareId);
		expect(row.access_count).toBe(1);
		expect(row.status).toBe('REVOKED');
	});

	it('logs share.session.denied_quota for both the capped snapshot and the lost race', async () => {
		await ensureAccount();

		const cappedLid = randomLid('gate-log-capped');
		const cappedSec = randomSec();
		const capped = await insertShare({ lid: cappedLid, sec: cappedSec, maxSessions: 1, accessCount: 1 });

		const racedLid = randomLid('gate-log-race');
		const racedSec = randomSec();
		const raced = await insertShare({ lid: racedLid, sec: racedSec, maxSessions: 1, accessCount: 0 });
		const losing = ctx({
			db: injectingDb(env.db, {
				before: async () => {
					await env.db.prepare('UPDATE mail_share SET access_count = 1 WHERE share_id = ?')
						.bind(raced.shareId).run();
				}
			})
		});

		const lines = await captureLogs(async () => {
			expect(await catchFail(shareAuthService.establishSession(ctx(), cappedLid, cappedSec)))
				.toBe(UNAVAILABLE_BODY);
			expect(await catchFail(shareAuthService.establishSession(losing, racedLid, racedSec)))
				.toBe(UNAVAILABLE_BODY);
		});

		const events = quotaEvents(lines);
		expect(events.map((entry) => entry.reason)).toEqual(['quota_snapshot', 'quota_race']);
		expect(events.map((entry) => entry.shareId)).toEqual([capped.shareId, raced.shareId]);
		const joined = lines.join('\n');
		expect(joined).not.toContain(cappedSec);
		expect(joined).not.toContain(racedSec);
		expect(joined).not.toContain(cappedLid);
		expect(joined).not.toContain(racedLid);

		expect((await quotaRow(capped.shareId)).access_count).toBe(1);
		expect((await quotaRow(raced.shareId)).access_count).toBe(1);
	});

	it('keeps used_sessions flat across polling, list, detail and attachment reads (AC-SESS-02, AC-EDGE-01, P-SESS-02)', async () => {
		await ensureAccount();
		const lid = randomLid('gate-read-only');
		const sec = randomSec();
		// Seeded against the deployed pepper ring and left uncapped: the attachment
		// route still hard-requires an ACTIVE context (its cap handling is T-08).
		const { shareId } = await insertShare({
			lid,
			sec,
			pepper: env.SHARE_SEC_PEPPER,
			pepperKid: env.SHARE_SEC_PEPPER_KID
		});

		const session = await shareFetch('POST', '/share/session', { body: { lid, sec } });
		const sessionToken = session.json.data.sessionToken;
		expect(sessionToken).toEqual(expect.any(String));

		const afterEstablish = await quotaRow(shareId);
		expect(afterEstablish.access_count).toBe(1);

		const reader = ctx({
			SHARE_SESSION_SIGNING_KEY: env.SHARE_SESSION_SIGNING_KEY,
			SHARE_SESSION_SIGNING_KID: env.SHARE_SESSION_SIGNING_KID
		});
		for (let i = 0; i < 3; i++) {
			await shareAuthService.resolveSession(reader, sessionToken);
		}
		await shareFetch('GET', '/share/mails?limit=20', { bearer: sessionToken });
		await shareFetch('GET', '/share/mails?limit=20', { bearer: sessionToken });
		await shareFetch('GET', '/share/mail?mailId=999999', { bearer: sessionToken });
		await shareFetch('GET', '/share/attachment?mailId=999999&attachmentId=999999', { bearer: sessionToken });

		const after = await quotaRow(shareId);
		expect(after.access_count).toBe(1);
		expect(after.last_access_at).toBe(afterEstablish.last_access_at);
	});

	it('keeps resolveSession structurally write-free with the gate as the only write (AC-SESS-02, P-SESS-02)', () => {
		const resolveBody = functionSource(shareAuthSource, 'resolveSession');
		expect(resolveBody).not.toMatch(/\.(update|insert|delete)\(/);
		expect(resolveBody).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
		expect(resolveBody).not.toContain('consumeSessionQuota');

		expect(shareAuthSource.match(/\.(update|insert|delete)\(/g)).toEqual(['.update(']);
		const gateBody = functionSource(shareAuthSource, 'consumeSessionQuota');
		expect(gateBody).toContain('.update(');
		expect(gateBody).toContain('.returning(');

		// The fire-and-forget helper and its deps seam are gone on both sides.
		expect(shareAuthSource).not.toContain('recordAccess');
	});
});

const SHARE_EST_PREFIX = 'share:est:';

function estKey(lid, key) {
	return `${SHARE_EST_PREFIX}${lid}:${key}`;
}

describe('shareAuthService establish idempotency replay', () => {
	it('replays the first response for the same Idempotency-Key without running the quota gate (AC-SESS-10)', async () => {
		await ensureAccount();
		const lid = randomLid('idem-replay');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec, maxSessions: 5 });
		const kv = recordingKv();
		const key = 'idem-key-replay';

		const first = await shareAuthService.establishSession(
			ctx({ kv: kv.binding }), lid, sec, { idempotencyKey: key }
		);
		expect(first.sessionToken).toEqual(expect.any(String));
		expect((await quotaRow(shareId)).access_count).toBe(1);
		expect(kv.store.has(estKey(lid, key))).toBe(true);

		// Any execution of the quota UPDATE now throws, so a replay that still reaches
		// consumeSessionQuota fails loudly instead of quietly consuming a second slot.
		const guarded = ctx({
			kv: kv.binding,
			db: injectingDb(env.db, {
				before: () => {
					throw new Error('quota gate ran on an idempotent replay');
				}
			})
		});
		const replay = await shareAuthService.establishSession(guarded, lid, sec, { idempotencyKey: key });
		expect(replay).toEqual(first);

		const row = await quotaRow(shareId);
		expect(row.access_count).toBe(1);
		expect(kv.puts.length).toBe(1);
	});

	it('replays a max_sessions=1 share after the first slot is gone (AC-SESS-10)', async () => {
		await ensureAccount();
		const lid = randomLid('idem-cap-one');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec, maxSessions: 1 });
		const kv = recordingKv();
		const key = 'idem-key-cap-one';
		const c = ctx({ kv: kv.binding });

		const first = await shareAuthService.establishSession(c, lid, sec, { idempotencyKey: key });
		expect((await quotaRow(shareId)).access_count).toBe(1);

		const replay = await shareAuthService.establishSession(c, lid, sec, { idempotencyKey: key });
		expect(replay).toEqual(first);
		expect((await quotaRow(shareId)).access_count).toBe(1);

		expect(await catchFail(shareAuthService.establishSession(c, lid, sec, { idempotencyKey: 'other-key' })))
			.toBe(UNAVAILABLE_BODY);
		expect((await quotaRow(shareId)).access_count).toBe(1);
	});

	it('keeps one cache entry per key and consumes a slot for a new, missing or blank key (AC-SESS-10)', async () => {
		await ensureAccount();
		const lid = randomLid('idem-distinct');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec });
		const kv = recordingKv();
		const c = ctx({ kv: kv.binding });
		const t0 = 1_700_000_000_000;
		// The token payload is a pure function of the row plus iat, so without moving
		// the clock two establishes in the same second are byte-identical and the
		// "different keys, different tokens" assertion would pass vacuously.
		const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
		try {
			const first = await shareAuthService.establishSession(c, lid, sec, { idempotencyKey: 'key-a' });
			nowSpy.mockReturnValue(t0 + 2_000);
			const second = await shareAuthService.establishSession(c, lid, sec, { idempotencyKey: 'key-b' });
			nowSpy.mockReturnValue(t0 + 4_000);
			const third = await shareAuthService.establishSession(c, lid, sec);
			nowSpy.mockReturnValue(t0 + 6_000);
			const blank = await shareAuthService.establishSession(c, lid, sec, { idempotencyKey: '   ' });

			expect(second.sessionToken).not.toBe(first.sessionToken);
			expect(kv.store.get(estKey(lid, 'key-a'))).toContain(first.sessionToken);
			expect(kv.store.get(estKey(lid, 'key-b'))).toContain(second.sessionToken);
			expect(kv.store.size).toBe(2);
			expect(third.sessionToken).toEqual(expect.any(String));
			expect(blank.sessionToken).toEqual(expect.any(String));
			expect((await quotaRow(shareId)).access_count).toBe(4);
		} finally {
			nowSpy.mockRestore();
		}
	});

	it('still issues a session and logs share.system.error when the KV read fails (AC-SESS-10)', async () => {
		await ensureAccount();
		const lid = randomLid('idem-get-fail');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec });
		const kv = recordingKv({ getThrows: true });

		let established;
		const lines = await captureLogs(async () => {
			established = await shareAuthService.establishSession(
				ctx({ kv: kv.binding }), lid, sec, { idempotencyKey: 'get-fail' }
			);
		});

		expect(established.sessionToken).toEqual(expect.any(String));
		expect((await quotaRow(shareId)).access_count).toBe(1);
		const errors = systemErrors(lines);
		expect(errors.length).toBe(1);
		expect(errors[0].shareId).toBe(shareId);
		// The read failed, not the write: a later retry should still find the entry.
		expect(kv.puts.length).toBe(1);
	});

	it('still issues a session and consumes the slot when the KV write fails (AC-SESS-10)', async () => {
		await ensureAccount();
		const lid = randomLid('idem-put-fail');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec });
		const kv = recordingKv({ putThrows: true });
		const c = ctx({ kv: kv.binding });

		let established;
		const lines = await captureLogs(async () => {
			established = await shareAuthService.establishSession(c, lid, sec, { idempotencyKey: 'put-fail' });
		});

		expect(established.sessionToken).toEqual(expect.any(String));
		expect(systemErrors(lines).length).toBe(1);
		expect((await quotaRow(shareId)).access_count).toBe(1);

		// Fail-open means exactly this: nothing was cached, so the retry pays again.
		await shareAuthService.establishSession(c, lid, sec, { idempotencyKey: 'put-fail' });
		expect((await quotaRow(shareId)).access_count).toBe(2);
	});

	it('skips the KV write when the token has less than the 60s KV minimum left (AC-SESS-10)', async () => {
		await ensureAccount();
		const lid = randomLid('idem-ttl-floor');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec, expiresAt: futureText(30) });
		const kv = recordingKv();

		let established;
		const lines = await captureLogs(async () => {
			established = await shareAuthService.establishSession(
				ctx({ kv: kv.binding }), lid, sec, { idempotencyKey: 'ttl-floor' }
			);
		});

		expect(established.sessionToken).toEqual(expect.any(String));
		// Workers KV rejects expirationTtl < 60, so this is a skip, not a failure.
		expect(kv.puts).toEqual([]);
		expect(systemErrors(lines)).toEqual([]);
		expect((await quotaRow(shareId)).access_count).toBe(1);
	});

	it('writes the cache entry with expirationTtl = min(120, remaining token life) (AC-SESS-10)', async () => {
		await ensureAccount();

		const longLid = randomLid('idem-ttl-long');
		const longSec = randomSec();
		await insertShare({ lid: longLid, sec: longSec });
		const longKv = recordingKv();
		await shareAuthService.establishSession(
			ctx({ kv: longKv.binding }), longLid, longSec, { idempotencyKey: 'ttl-long' }
		);
		expect(longKv.puts.length).toBe(1);
		expect(longKv.puts[0].key).toBe(estKey(longLid, 'ttl-long'));
		expect(longKv.puts[0].options.expirationTtl).toBe(120);

		const shortLid = randomLid('idem-ttl-short');
		const shortSec = randomSec();
		await insertShare({ lid: shortLid, sec: shortSec, expiresAt: futureText(90) });
		const shortKv = recordingKv();
		await shareAuthService.establishSession(
			ctx({ kv: shortKv.binding }), shortLid, shortSec, { idempotencyKey: 'ttl-short' }
		);
		const ttl = shortKv.puts[0].options.expirationTtl;
		expect(ttl).toBeGreaterThanOrEqual(60);
		expect(ttl).toBeLessThan(120);
		expect(Math.abs(ttl - 90)).toBeLessThanOrEqual(2);
	});

	it('keeps sec, lid and the token out of the KV failure logs (AC-LEAK-05)', async () => {
		await ensureAccount();
		const lid = randomLid('idem-leak');
		const sec = randomSec();
		await insertShare({ lid, sec });
		const kv = recordingKv({ getThrows: true, putThrows: true });
		const lines = [];
		const log = console.log;
		const error = console.error;
		console.log = (...args) => lines.push(args.map(String).join(' '));
		console.error = (...args) => lines.push(args.map(String).join(' '));
		let established;
		try {
			established = await shareAuthService.establishSession(
				ctx({ kv: kv.binding }), lid, sec, { idempotencyKey: 'leak-key' }
			);
		} finally {
			console.log = log;
			console.error = error;
		}

		const joined = lines.join('\n');
		expect(systemErrors(lines).length).toBe(2);
		// The KV key embeds the lid, so logging it would leak the share locator.
		expect(joined).not.toContain(lid);
		expect(joined).not.toContain(sec);
		expect(joined).not.toContain(established.sessionToken);
	});
});

function base64url(bytes) {
	return btoa(String.fromCharCode(...new Uint8Array(bytes)))
		.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Mints a token the way the service does, so a case can hand resolveSession a
// payload shape the current issueToken no longer produces (a pre-T-08 token with
// no `cv`) without reaching into the module internals.
async function mintToken(payload, { key = SIGN_V2, kid = 'v2' } = {}) {
	const data = `s1.${kid}.${base64url(encoder.encode(JSON.stringify(payload)))}`;
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		encoder.encode(key),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
	return `${data}.${base64url(sig)}`;
}

function authEvents(lines) {
	return eventsNamed(lines, 'share.session.denied_auth');
}

function cvEvents(lines) {
	return eventsNamed(lines, 'share.session.denied_cv');
}

async function bumpCredentialsVersion(shareId, { authKey, pepper = PEPPER_V2, authKeyKid = 'v2' } = {}) {
	if (authKey === undefined) {
		await env.db.prepare(
			'UPDATE mail_share SET credentials_version = credentials_version + 1 WHERE share_id = ?'
		).bind(shareId).run();
	} else {
		await env.db.prepare(`
			UPDATE mail_share
			SET credentials_version = credentials_version + 1, auth_key_hash = ?, auth_key_kid = ?
			WHERE share_id = ?
		`).bind(await hmacHex(pepper, authKey), authKeyKid, shareId).run();
	}
	const row = await quotaRow(shareId);
	return row.credentials_version;
}

describe('shareAuthService AuthKey second factor', () => {
	it('refuses a missing or wrong AuthKey with SHARE_AUTH_REQUIRED, no token, no quota and no lock table (AC-AUTH-01, AC-AUTH-05, AC-EDGE-12)', async () => {
		await ensureAccount();
		const lid = randomLid('auth-wrong');
		const sec = randomSec();
		const { shareId } = await authKeyShare({ lid, sec });
		const c = ctx();

		const bodies = [
			await catchFail(shareAuthService.establishSession(c, lid, sec)),
			await catchFail(shareAuthService.establishSession(c, lid, sec, {})),
			await catchFail(shareAuthService.establishSession(c, lid, sec, { authKey: '' })),
			await catchFail(shareAuthService.establishSession(c, lid, sec, { authKey: '   ' })),
			await catchFail(shareAuthService.establishSession(c, lid, sec, { authKey: null })),
			await catchFail(shareAuthService.establishSession(c, lid, sec, { authKey: `${AUTH_KEY}x` })),
			await catchFail(shareAuthService.establishSession(c, lid, sec, { authKey: AUTH_KEY.toUpperCase() }))
		];
		for (const body of bodies) {
			expect(body).toBe(AUTH_REQUIRED_BODY);
		}
		expect(new Set(bodies).size).toBe(1);

		const row = await quotaRow(shareId);
		expect(row.access_count).toBe(0);
		expect(row.last_access_at).toBeNull();

		// R2-A6 deleted the lockout table outright: no failure counter may exist.
		const tables = await env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
		expect(tables.results.map((item) => item.name)).not.toContain('mail_share_auth_fail');
	});

	it('accepts the right AuthKey, trims surrounding whitespace and still meters one slot (AC-AUTH-01, AC-AUTH-03)', async () => {
		await ensureAccount();
		const lid = randomLid('auth-right');
		const sec = randomSec();
		const { shareId } = await authKeyShare({ lid, sec });
		const c = ctx();

		const established = await shareAuthService.establishSession(c, lid, sec, { authKey: AUTH_KEY });
		expect(established.sessionToken).toEqual(expect.any(String));
		expect(established.sessionToken).not.toContain(AUTH_KEY);

		const padded = await shareAuthService.establishSession(c, lid, sec, { authKey: `  ${AUTH_KEY}\n` });
		expect(padded.sessionToken).toEqual(expect.any(String));

		expect((await quotaRow(shareId)).access_count).toBe(2);
	});

	it('ignores a supplied AuthKey while the factor is off (AC-AUTH-07)', async () => {
		await ensureAccount();
		const lid = randomLid('auth-off');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec });
		const c = ctx();

		await shareAuthService.establishSession(c, lid, sec, { authKey: 't08-unsolicited-key' });
		await shareAuthService.establishSession(c, lid, sec);
		expect((await quotaRow(shareId)).access_count).toBe(2);
	});

	it('binds the AuthKey hash to its own auth_key_kid and fails closed on an unconfigured one (AC-AUTH-03)', async () => {
		await ensureAccount();
		const c = ctx();

		const prevLid = randomLid('auth-kid-prev');
		const prevSec = randomSec();
		await authKeyShare({ lid: prevLid, sec: prevSec, pepper: PEPPER_V1, authKeyKid: 'v1' });
		const rotated = await shareAuthService.establishSession(c, prevLid, prevSec, { authKey: AUTH_KEY });
		expect(rotated.sessionToken).toEqual(expect.any(String));

		const crossLid = randomLid('auth-kid-cross');
		const crossSec = randomSec();
		await authKeyShare({ lid: crossLid, sec: crossSec, pepper: PEPPER_V1, authKeyKid: 'v2' });
		expect(await catchFail(shareAuthService.establishSession(c, crossLid, crossSec, { authKey: AUTH_KEY })))
			.toBe(AUTH_REQUIRED_BODY);

		const goneLid = randomLid('auth-kid-gone');
		const goneSec = randomSec();
		await authKeyShare({ lid: goneLid, sec: goneSec, authKeyKid: 'v9' });
		expect(await catchFail(shareAuthService.establishSession(c, goneLid, goneSec, { authKey: AUTH_KEY })))
			.toBe(AUTH_REQUIRED_BODY);
	});

	it('keeps every pre-AuthKey visitor failure byte-identical for any AuthKey the caller sends (P-AUTH-01, AC-AUTH-02, AC-EDGE-08)', async () => {
		await ensureAccount();
		const keyedLid = randomLid('p-auth-keyed');
		const keyedSec = randomSec();
		await authKeyShare({ lid: keyedLid, sec: keyedSec });

		const plainLid = randomLid('p-auth-plain');
		const plainSec = randomSec();
		await insertShare({ lid: plainLid, sec: plainSec });

		const expiredLid = randomLid('p-auth-expired');
		const expiredSec = randomSec();
		await authKeyShare({ lid: expiredLid, sec: expiredSec, expiresAt: '2001-01-01 00:00:00' });

		const revokedLid = randomLid('p-auth-revoked');
		const revokedSec = randomSec();
		await authKeyShare({ lid: revokedLid, sec: revokedSec, status: 'REVOKED' });

		const missingLid = randomLid('p-auth-missing');
		const c = ctx();

		// The only thing separating these attempts is whether the visitor ever had a
		// valid lid+sec. None of them may reveal that an AuthKey exists at all.
		// P4 后 missing-lid 属于 gone 家族(裸 404),但族内不变量不变:回答只取决于
		// 行的状态,与访客递交的任何 AuthKey 无关,也永远不是 SHARE_AUTH_REQUIRED。
		const attempts = {
			'missing-lid': { pick: () => [missingLid, randomSec()], body: DESTROYED_BODY },
			'wrong-sec-on-keyed': { pick: () => [keyedLid, randomSec()], body: UNAVAILABLE_BODY },
			'wrong-sec-on-plain': { pick: () => [plainLid, randomSec()], body: UNAVAILABLE_BODY }
		};

		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(...Object.keys(attempts)),
				fc.oneof(
					fc.constant(undefined),
					fc.constant(null),
					fc.constant(''),
					fc.constant(AUTH_KEY),
					fc.string({ maxLength: 40 })
				),
				async (which, authKey) => {
					const [lid, sec] = attempts[which].pick();
					const body = await catchFail(
						shareAuthService.establishSession(c, lid, sec, { authKey })
					);
					expect(body).toBe(attempts[which].body);
				}
			),
			{ numRuns: 40 }
		);

		// The other half of AC-AUTH-02: a visitor who did pass lid+sec and does hold
		// the key still gets the plain refusal for expiry — and gone for revocation.
		expect(await catchFail(shareAuthService.establishSession(c, expiredLid, expiredSec, { authKey: AUTH_KEY })))
			.toBe(UNAVAILABLE_BODY);
		expect(await catchFail(shareAuthService.establishSession(c, revokedLid, revokedSec, { authKey: AUTH_KEY })))
			.toBe(DESTROYED_BODY);
	});

	it('checks the AuthKey before the idempotency replay cache so a wrong key never gets a cached token (AC-AUTH-01, AC-SESS-10)', async () => {
		await ensureAccount();
		const lid = randomLid('auth-before-kv');
		const sec = randomSec();
		const { shareId } = await authKeyShare({ lid, sec });
		const kv = recordingKv();
		const key = 'auth-before-kv-key';
		const c = ctx({ kv: kv.binding });

		const first = await shareAuthService.establishSession(c, lid, sec, { authKey: AUTH_KEY, idempotencyKey: key });
		expect(kv.store.has(estKey(lid, key))).toBe(true);
		expect((await quotaRow(shareId)).access_count).toBe(1);

		const gets = kv.gets.length;
		expect(await catchFail(shareAuthService.establishSession(c, lid, sec, { idempotencyKey: key })))
			.toBe(AUTH_REQUIRED_BODY);
		expect(await catchFail(shareAuthService.establishSession(c, lid, sec, { authKey: 'nope', idempotencyKey: key })))
			.toBe(AUTH_REQUIRED_BODY);
		// The refusal happened above the cache: no lookup, so no cached token to leak.
		expect(kv.gets.length).toBe(gets);
		expect((await quotaRow(shareId)).access_count).toBe(1);

		const replay = await shareAuthService.establishSession(c, lid, sec, { authKey: AUTH_KEY, idempotencyKey: key });
		expect(replay).toEqual(first);
		expect((await quotaRow(shareId)).access_count).toBe(1);
	});

	it('serves an already-issued keyed session after max_sessions is reached (AC-SESS-06, AC-AUTH-01)', async () => {
		await ensureAccount();
		const lid = randomLid('auth-cap');
		const sec = randomSec();
		const { shareId } = await authKeyShare({ lid, sec, maxSessions: 1 });
		const c = ctx();

		const established = await shareAuthService.establishSession(c, lid, sec, { authKey: AUTH_KEY });
		expect((await quotaRow(shareId)).access_count).toBe(1);

		const resolved = await shareAuthService.resolveSession(c, established.sessionToken);
		expect(resolved.effectiveStatus).toBe('ACCESS_LIMIT_REACHED');
		expect(resolved.shareId).toBe(shareId);

		// The cap closes the door without clearing the room, and it stays a plain
		// SHARE_UNAVAILABLE even though the visitor holds the right key.
		expect(await catchFail(shareAuthService.establishSession(c, lid, sec, { authKey: AUTH_KEY })))
			.toBe(UNAVAILABLE_BODY);
		expect((await quotaRow(shareId)).access_count).toBe(1);
	});

	it('still refuses a keyed session when the quota UPDATE throws and still signs when the KV write fails (AC-SESS-11, AC-SESS-10)', async () => {
		await ensureAccount();

		const gateLid = randomLid('auth-gate-fail');
		const gateSec = randomSec();
		const gate = await authKeyShare({ lid: gateLid, sec: gateSec });
		const failing = ctx({
			db: injectingDb(env.db, {
				before: () => {
					throw new Error('d1 write failed');
				}
			})
		});
		expect(await catchFail(shareAuthService.establishSession(failing, gateLid, gateSec, { authKey: AUTH_KEY })))
			.toBe(UNAVAILABLE_BODY);
		expect((await quotaRow(gate.shareId)).access_count).toBe(0);

		const kvLid = randomLid('auth-kv-fail');
		const kvSec = randomSec();
		const kvShare = await authKeyShare({ lid: kvLid, sec: kvSec });
		const kv = recordingKv({ putThrows: true });
		let established;
		const lines = await captureLogs(async () => {
			established = await shareAuthService.establishSession(
				ctx({ kv: kv.binding }), kvLid, kvSec, { authKey: AUTH_KEY, idempotencyKey: 'auth-kv-fail-key' }
			);
		});
		expect(established.sessionToken).toEqual(expect.any(String));
		expect(systemErrors(lines).length).toBe(1);
		expect((await quotaRow(kvShare.shareId)).access_count).toBe(1);
	});

	it('logs share.session.denied_auth without the key, the sec, the lid or the token (AC-LEAK-05, AC-AUTH-03)', async () => {
		await ensureAccount();
		const lid = randomLid('auth-log');
		const sec = randomSec();
		const { shareId } = await authKeyShare({ lid, sec });
		const c = ctx();

		const lines = [];
		const log = console.log;
		const error = console.error;
		console.log = (...args) => lines.push(args.map(String).join(' '));
		console.error = (...args) => lines.push(args.map(String).join(' '));
		let established;
		try {
			expect(await catchFail(shareAuthService.establishSession(c, lid, sec, { authKey: 't08-guessed-key' })))
				.toBe(AUTH_REQUIRED_BODY);
			expect(await catchFail(shareAuthService.establishSession(c, lid, sec))).toBe(AUTH_REQUIRED_BODY);
			established = await shareAuthService.establishSession(c, lid, sec, { authKey: AUTH_KEY });
		} finally {
			console.log = log;
			console.error = error;
		}

		const events = authEvents(lines);
		expect(events.length).toBe(2);
		expect(events.map((entry) => entry.shareId)).toEqual([shareId, shareId]);

		const joined = lines.join('\n');
		expect(joined).not.toContain(AUTH_KEY);
		expect(joined).not.toContain('t08-guessed-key');
		expect(joined).not.toContain(sec);
		expect(joined).not.toContain(lid);
		expect(joined).not.toContain(established.sessionToken);
	});

	it('leaves HTTP 429 to the transport layer instead of mapping it into the session path (AC-AUTH-06, AC-EDGE-12)', () => {
		// share-rate-limit.spec.js already proves the 429 response itself; what this
		// task must not do is teach the service about the limiter.
		expect(shareAuthSource).not.toContain('RATE_LIMITED');
		expect(shareAuthSource).not.toContain('429');
		expect(shareAuthSource).not.toContain('RateLimit');
		expect(shareApiSource).toContain(
			"app.post('/share/session', shareRateLimit(SHARE_SESSION_RATE_LIMITER, SHARE_SESSION_RETRY_AFTER_SECONDS)"
		);
	});
});

describe('shareAuthService credentials_version', () => {
	it('stamps cv on the token and kills the old one on the next resolve after a bump (P-AUTH-02, AC-AUTH-04, AC-EDGE-05)', async () => {
		await ensureAccount();
		const lid = randomLid('cv-bump');
		const sec = randomSec();
		const { shareId } = await authKeyShare({ lid, sec });
		const c = ctx();

		const first = await shareAuthService.establishSession(c, lid, sec, { authKey: AUTH_KEY });
		expect(decodeTokenPayload(first.sessionToken).cv).toBe(0);
		expect((await shareAuthService.resolveSession(c, first.sessionToken)).shareId).toBe(shareId);
		expect((await quotaRow(shareId)).access_count).toBe(1);

		const nextKey = 't08-auth-key-rotated-value';
		const cv1 = await bumpCredentialsVersion(shareId, { authKey: nextKey });
		expect(cv1).toBe(1);

		expect(await catchFail(shareAuthService.resolveSession(c, first.sessionToken))).toBe(UNAVAILABLE_BODY);
		expect(await catchFail(shareAuthService.establishSession(c, lid, sec, { authKey: AUTH_KEY })))
			.toBe(AUTH_REQUIRED_BODY);
		expect((await quotaRow(shareId)).access_count).toBe(1);

		const second = await shareAuthService.establishSession(c, lid, sec, { authKey: nextKey });
		expect(decodeTokenPayload(second.sessionToken).cv).toBe(1);
		expect((await shareAuthService.resolveSession(c, second.sessionToken)).shareId).toBe(shareId);
		// Re-entry costs a fresh slot (AC-EDGE-05).
		expect((await quotaRow(shareId)).access_count).toBe(2);

		const cv2 = await bumpCredentialsVersion(shareId);
		expect(cv2).toBe(2);
		expect(cv2).toBeGreaterThan(cv1);
		expect(cv1).toBeGreaterThan(0);
		expect(await catchFail(shareAuthService.resolveSession(c, second.sessionToken))).toBe(UNAVAILABLE_BODY);
		expect(await catchFail(shareAuthService.resolveSession(c, first.sessionToken))).toBe(UNAVAILABLE_BODY);
	});

	it('treats a replay cache entry from an older cv as a miss and re-enters on the new key (AC-EDGE-05, AC-SESS-10)', async () => {
		await ensureAccount();
		const lid = randomLid('cv-idem-stale');
		const sec = randomSec();
		const { shareId } = await authKeyShare({ lid, sec });
		const kv = recordingKv();
		const c = ctx({ kv: kv.binding });
		const key = 'cv-idem-stale-key';

		const first = await shareAuthService.establishSession(
			c, lid, sec, { authKey: AUTH_KEY, idempotencyKey: key }
		);
		expect(decodeTokenPayload(first.sessionToken).cv).toBe(0);
		expect((await quotaRow(shareId)).access_count).toBe(1);

		const nextKey = 't08-auth-key-reset-value';
		expect(await bumpCredentialsVersion(shareId, { authKey: nextKey })).toBe(1);

		// Same Idempotency-Key, new key: the cached cv=0 token is dead on arrival, so
		// replaying it would answer a valid credential with a token that cannot resolve.
		const second = await shareAuthService.establishSession(
			c, lid, sec, { authKey: nextKey, idempotencyKey: key }
		);
		expect(second.sessionToken).not.toBe(first.sessionToken);
		expect(decodeTokenPayload(second.sessionToken).cv).toBe(1);
		expect((await quotaRow(shareId)).access_count).toBe(2);
		expect((await shareAuthService.resolveSession(c, second.sessionToken)).shareId).toBe(shareId);
		expect(await catchFail(shareAuthService.resolveSession(c, first.sessionToken))).toBe(UNAVAILABLE_BODY);

		// The fresh issue overwrote the entry, so a genuine retry replays the live token.
		expect(kv.store.get(estKey(lid, key))).toContain(second.sessionToken);
		const replay = await shareAuthService.establishSession(
			c, lid, sec, { authKey: nextKey, idempotencyKey: key }
		);
		expect(replay).toEqual(second);
		expect((await quotaRow(shareId)).access_count).toBe(2);
	});

	it('resolves a pre-T-08 token with no cv as version 0 (AC-AUTH-04)', async () => {
		await ensureAccount();
		const lid = randomLid('cv-legacy');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec });
		const c = ctx();

		const iat = Math.floor(Date.now() / 1000);
		const legacy = await mintToken({ shareId, lid, iat, exp: iat + 900, kid: 'v2' });
		expect(decodeTokenPayload(legacy).cv).toBeUndefined();
		expect((await shareAuthService.resolveSession(c, legacy)).shareId).toBe(shareId);

		await bumpCredentialsVersion(shareId);
		expect(await catchFail(shareAuthService.resolveSession(c, legacy))).toBe(UNAVAILABLE_BODY);
	});

	it('logs share.session.denied_cv without the lid, sec or token (AC-AUTH-04, AC-LEAK-05)', async () => {
		await ensureAccount();
		const lid = randomLid('cv-log');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec });
		const c = ctx();
		const established = await shareAuthService.establishSession(c, lid, sec);
		await bumpCredentialsVersion(shareId);

		const lines = await captureLogs(async () => {
			expect(await catchFail(shareAuthService.resolveSession(c, established.sessionToken)))
				.toBe(UNAVAILABLE_BODY);
		});

		const events = cvEvents(lines);
		expect(events.length).toBe(1);
		expect(events[0].shareId).toBe(shareId);
		const joined = lines.join('\n');
		expect(joined).not.toContain(lid);
		expect(joined).not.toContain(sec);
		expect(joined).not.toContain(established.sessionToken);
	});

	it('does not bind the token to the caller IP (AC-SESS-08)', async () => {
		await ensureAccount();
		const lid = randomLid('cv-ip');
		const sec = randomSec();
		await insertShare({
			lid,
			sec,
			pepper: env.SHARE_SEC_PEPPER,
			pepperKid: env.SHARE_SEC_PEPPER_KID
		});

		const session = await shareFetch('POST', '/share/session', {
			body: { lid, sec },
			headers: { 'CF-Connecting-IP': '203.0.113.7' }
		});
		expect(session.status).toBe(200);
		const sessionToken = session.json.data.sessionToken;

		const moved = await shareFetch('GET', '/share/mails?limit=20', {
			bearer: sessionToken,
			headers: { 'CF-Connecting-IP': '198.51.100.9' }
		});
		expect(moved.status).toBe(200);
		expect(moved.json.code).toBe(200);
		expect(Array.isArray(moved.json.data.list)).toBe(true);
	});
});

describe('shareAuthService ShareContext and session response', () => {
	it('returns a frozen collection ShareContext with the deprecated single-binding shims (AC-SESS-09)', async () => {
		await ensureAccount();
		const secondAccountId = 800043;
		await ensureAccount({ accountId: secondAccountId, email: 't08-second@example.com' });
		const lid = randomLid('ctx-multi');
		const sec = randomSec();
		const { shareId } = await insertShare({
			lid,
			sec,
			messageLimit: 25,
			otpExtractionEnabled: 0,
			showFullAddress: 1
		});
		// Inserted alt-account-first so "sorted by bindingId ASC" cannot be confused
		// with "the primary account_id column comes first".
		const primaryBinding = await insertBinding(shareId, secondAccountId, 77);
		const laterBinding = await insertBinding(shareId, ACCOUNT_ID, 10);
		expect(primaryBinding).toBeLessThan(laterBinding);

		const c = ctx();
		const established = await shareAuthService.establishSession(c, lid, sec);
		const resolved = await shareAuthService.resolveSession(c, established.sessionToken);

		expect(resolved.bindings).toEqual([
			{ bindingId: primaryBinding, accountId: secondAccountId, windowStartEmailId: 77 },
			{ bindingId: laterBinding, accountId: ACCOUNT_ID, windowStartEmailId: 10 }
		]);
		expect(resolved.shareId).toBe(shareId);
		expect(resolved.messageLimit).toBe(25);
		expect(resolved.otpExtractionEnabled).toBe(false);
		expect(resolved.showFullAddress).toBe(true);
		expect(resolved.expiresAt).toBe('2099-01-01 00:00:00');
		expect(resolved.effectiveStatus).toBe('ACTIVE');
		// Deprecated shims until T-11 moves every reader onto bindings[].
		expect(resolved.accountId).toBe(secondAccountId);
		expect(resolved.windowStartEmailId).toBe(77);

		expect(Object.isFrozen(resolved)).toBe(true);
		expect(Object.isFrozen(resolved.bindings)).toBe(true);
		expect(Object.isFrozen(resolved.bindings[0])).toBe(true);
	});

	it('synthesizes one shim binding for a share with no binding rows (W1-ctx)', async () => {
		await ensureAccount();
		const lid = randomLid('ctx-shim');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec });
		const c = ctx();

		const established = await shareAuthService.establishSession(c, lid, sec);
		const resolved = await shareAuthService.resolveSession(c, established.sessionToken);
		expect(resolved.bindings).toEqual([
			{ bindingId: 0, accountId: ACCOUNT_ID, windowStartEmailId: 10 }
		]);
		expect(resolved.accountId).toBe(ACCOUNT_ID);
		expect(resolved.windowStartEmailId).toBe(10);
		expect(resolved.messageLimit).toBeNull();
		expect(resolved.otpExtractionEnabled).toBe(true);
		expect(resolved.showFullAddress).toBe(false);
		expect(resolved.shareId).toBe(shareId);
	});

	it('drops a deleted binding account and refuses once every binding account is gone (AC-LIFE-03)', async () => {
		const deadAccountId = 800098;
		await ensureAccount();
		await ensureAccount({ accountId: deadAccountId, email: 't08-gone@example.com' });
		const lid = randomLid('ctx-dead');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec });
		const deadBinding = await insertBinding(shareId, deadAccountId, 5);
		const liveBinding = await insertBinding(shareId, ACCOUNT_ID, 10);
		const c = ctx();

		await env.db.prepare('UPDATE account SET is_del = ? WHERE account_id = ?')
			.bind(isDel.DELETE, deadAccountId).run();

		const established = await shareAuthService.establishSession(c, lid, sec);
		const resolved = await shareAuthService.resolveSession(c, established.sessionToken);
		expect(resolved.bindings).toEqual([
			{ bindingId: liveBinding, accountId: ACCOUNT_ID, windowStartEmailId: 10 }
		]);
		expect(deadBinding).toBeLessThan(liveBinding);

		await env.db.prepare('UPDATE account SET is_del = ? WHERE account_id = ?')
			.bind(isDel.DELETE, ACCOUNT_ID).run();
		expect(await catchFail(shareAuthService.resolveSession(c, established.sessionToken))).toBe(UNAVAILABLE_BODY);
		expect(await catchFail(shareAuthService.establishSession(c, lid, sec))).toBe(UNAVAILABLE_BODY);
	});

	it('answers a single-binding establish with shareType, masked mailboxes, expiresAt and config (AC-SESS-09)', async () => {
		await ensureAccount();
		const lid = randomLid('resp-single');
		const sec = randomSec();
		await insertShare({
			lid,
			sec,
			messageLimit: 30,
			otpExtractionEnabled: 1,
			autoRefresh: 0,
			refreshIntervalMs: 5000
		});

		const established = await shareAuthService.establishSession(ctx(), lid, sec);
		expect(established.shareType).toBe('single');
		expect(established.mailboxes).toEqual([{ bindingId: 0, address: 't***@example.com' }]);
		expect(established.expiresAt).toBe('2099-01-01 00:00:00');
		expect(established.config).toEqual({
			autoRefresh: false,
			refreshIntervalMs: 5000,
			otpExtractionEnabled: true,
			messageLimit: 30
		});
		// The pre-T-08 field stays, unmasked, until the visitor page moves to mailboxes[].
		expect(established.mailbox).toBe(MAILBOX);
		expect(JSON.stringify(established.mailboxes)).not.toContain(MAILBOX);
	});

	it('answers a two-binding establish with shareType multi and both masked addresses (AC-SESS-09, AC-CAP-02)', async () => {
		await ensureAccount();
		const secondAccountId = 800044;
		// Different first letter so the two masked addresses cannot pass by accident.
		await ensureAccount({ accountId: secondAccountId, email: 'alt-t08@example.com' });
		const lid = randomLid('resp-multi');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec });
		const first = await insertBinding(shareId, ACCOUNT_ID, 10);
		const second = await insertBinding(shareId, secondAccountId, 0);

		const established = await shareAuthService.establishSession(ctx(), lid, sec);
		expect(established.shareType).toBe('multi');
		expect(established.mailboxes).toEqual([
			{ bindingId: first, address: 't***@example.com' },
			{ bindingId: second, address: 'a***@example.com' }
		]);
		expect(established.mailbox).toBe(MAILBOX);
	});

	it('shows full addresses when show_full_address is on and clamps refresh_interval_ms up to 3000 (Decision 14, T12-R1)', async () => {
		await ensureAccount();
		const lid = randomLid('resp-full');
		const sec = randomSec();
		await insertShare({ lid, sec, showFullAddress: 1, refreshIntervalMs: 500 });

		const established = await shareAuthService.establishSession(ctx(), lid, sec);
		expect(established.mailboxes).toEqual([{ bindingId: 0, address: MAILBOX }]);
		expect(established.config.refreshIntervalMs).toBe(3000);
	});

	it('replays the whole extended response for a repeated Idempotency-Key (AC-SESS-09, AC-SESS-10)', async () => {
		await ensureAccount();
		const lid = randomLid('resp-replay');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec, messageLimit: 12 });
		const kv = recordingKv();
		const c = ctx({ kv: kv.binding });

		const first = await shareAuthService.establishSession(c, lid, sec, { idempotencyKey: 'resp-replay-key' });
		const replay = await shareAuthService.establishSession(c, lid, sec, { idempotencyKey: 'resp-replay-key' });
		expect(replay).toEqual(first);
		expect(replay.config).toEqual(first.config);
		expect(replay.mailboxes).toEqual(first.mailboxes);
		expect(replay.shareType).toBe('single');
		expect((await quotaRow(shareId)).access_count).toBe(1);
	});

	it('lets an ACCESS_LIMIT_REACHED context still download an attachment (T05-attach, AC-SESS-06)', async () => {
		await ensureAccount();
		const lid = randomLid('ctx-att-cap');
		const sec = randomSec();
		await insertShare({ lid, sec, maxSessions: 1, windowStartEmailId: 0 });
		const c = ctx();

		const established = await shareAuthService.establishSession(c, lid, sec);
		const resolved = await shareAuthService.resolveSession(c, established.sessionToken);
		expect(resolved.effectiveStatus).toBe('ACCESS_LIMIT_REACHED');

		const response = await shareAttachmentService.download(c, {
			shareContext: resolved,
			mailId: 11,
			attachmentId: 7
		}, {
			findAttachment: async () => ({
				attId: 7,
				accountId: ACCOUNT_ID,
				emailId: 11,
				key: 'attachments/t08-capped.txt'
			}),
			shareScopedEmailRepository: {
				getById: async () => ({ emailId: 11, accountId: ACCOUNT_ID })
			},
			getObj: async () => new Response('capped-bytes')
		});
		expect(await response.text()).toBe('capped-bytes');
	});
});

// T-22B2 · max_sessions counts people, not browser refreshes. The visitor page rebuilds
// its session every time the 900s token dies, and each rebuild used to cost a slot, so a
// long-lived share with a small cap hit ACCESS_LIMIT_REACHED on one person sitting still.
// The renewal proof is the token this share itself signed: a visitor holds lid+sec and
// nothing else, so any claim they can author on their own must stay metered or the cap
// evaporates. Grace mirrors RENEWAL_GRACE in the service.
const RENEWAL_GRACE_SECONDS = 3600;
const FORGED_SIGNING_KEY = 't22b2-attacker-chosen-signing-key';

describe('shareAuthService session renewal quota', () => {
	it('spends no slot when a visitor renews with the token this share signed (T-22B2)', async () => {
		await ensureAccount();
		const lid = randomLid('renew-free');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec, maxSessions: 1 });
		const c = ctx();
		const t0 = 1_700_000_000_000;
		const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
		try {
			const first = await shareAuthService.establishSession(c, lid, sec);
			expect((await quotaRow(shareId)).access_count).toBe(1);
			// The one slot is spent: a second person opening the link is out.
			expect(await catchFail(shareAuthService.establishSession(c, lid, sec))).toBe(UNAVAILABLE_BODY);

			// 15 minutes of reading later the tab's own token has died and the page rebuilds.
			nowSpy.mockReturnValue(t0 + 900_000 + 1_000);
			expect(await catchFail(shareAuthService.resolveSession(c, first.sessionToken)))
				.toBe(UNAVAILABLE_BODY);

			const renewed = await shareAuthService.establishSession(c, lid, sec, {
				previousSessionToken: first.sessionToken
			});
			expect(renewed.sessionToken).not.toBe(first.sessionToken);
			expect((await shareAuthService.resolveSession(c, renewed.sessionToken)).shareId).toBe(shareId);
			expect((await quotaRow(shareId)).access_count).toBe(1);

			// The chain keeps going: renewing off the renewed token is free too, otherwise
			// the second half-hour would still eat the share.
			nowSpy.mockReturnValue(t0 + 1_800_000 + 2_000);
			const again = await shareAuthService.establishSession(c, lid, sec, {
				previousSessionToken: renewed.sessionToken
			});
			expect((await shareAuthService.resolveSession(c, again.sessionToken)).shareId).toBe(shareId);
			expect((await quotaRow(shareId)).access_count).toBe(1);

			// A renewal is still an access: the owner's "last seen" must not freeze at the
			// first open just because the slot stopped moving.
			const row = await quotaRow(shareId);
			expect(row.last_access_at).toEqual(expect.any(String));
		} finally {
			nowSpy.mockRestore();
		}
	});

	it('meters every renewal claim a visitor can author for themselves (T-22B2)', async () => {
		await ensureAccount();
		const lid = randomLid('renew-forge');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec, maxSessions: 1 });
		const otherLid = randomLid('renew-other');
		const otherSec = randomSec();
		const other = await insertShare({ lid: otherLid, sec: otherSec });
		const c = ctx();

		const first = await shareAuthService.establishSession(c, lid, sec);
		const otherSession = await shareAuthService.establishSession(c, otherLid, otherSec);
		expect((await quotaRow(shareId)).access_count).toBe(1);

		const iat = Math.floor(Date.now() / 1000);
		const forged = [
			'not-a-token',
			's1.v2.eyJmYWtlIjp0cnVlfQ.AAAA',
			// Right shape, right claims, signed with a key the visitor picked.
			await mintToken(
				{ shareId, lid, iat, exp: iat + 900, kid: 'v2', cv: 0 },
				{ key: FORGED_SIGNING_KEY }
			),
			// Same, with the cv rewritten to whatever the row might hold.
			await mintToken(
				{ shareId, lid, iat, exp: iat + 900, kid: 'v2', cv: 99 },
				{ key: FORGED_SIGNING_KEY }
			),
			// Genuinely signed by this deployment — for a different share. A slot on a
			// throwaway share must not buy an unmetered seat on a capped one.
			otherSession.sessionToken,
			// This share's real token with the lid swapped to the other share's.
			await mintToken(
				{ shareId: other.shareId, lid, iat, exp: iat + 900, kid: 'v2', cv: 0 },
				{ key: FORGED_SIGNING_KEY }
			)
		];
		for (const previousSessionToken of forged) {
			expect(await catchFail(shareAuthService.establishSession(c, lid, sec, { previousSessionToken })))
				.toBe(UNAVAILABLE_BODY);
		}
		// A real token does not stand in for the share secret either.
		expect(await catchFail(shareAuthService.establishSession(c, lid, randomSec(), {
			previousSessionToken: first.sessionToken
		}))).toBe(UNAVAILABLE_BODY);
		expect((await quotaRow(shareId)).access_count).toBe(1);

		// Below the cap a forged claim is not an error, it is simply a new visitor — and
		// it pays for a slot like one. This is the half that keeps max_sessions meaningful.
		const meteredLid = randomLid('renew-forge-metered');
		const meteredSec = randomSec();
		const metered = await insertShare({ lid: meteredLid, sec: meteredSec, maxSessions: 3 });
		await shareAuthService.establishSession(c, meteredLid, meteredSec, {
			previousSessionToken: 'not-a-token'
		});
		await shareAuthService.establishSession(c, meteredLid, meteredSec, {
			previousSessionToken: await mintToken(
				{ shareId: metered.shareId, lid: meteredLid, iat, exp: iat + 900, kid: 'v2', cv: 0 },
				{ key: FORGED_SIGNING_KEY }
			)
		});
		expect((await quotaRow(metered.shareId)).access_count).toBe(2);
	});

	it('refuses a renewal once the share is revoked, expired or its cv moved (T-22B2, AC-AUTH-04)', async () => {
		await ensureAccount();
		const c = ctx();

		const revLid = randomLid('renew-rev');
		const revSec = randomSec();
		const rev = await insertShare({ lid: revLid, sec: revSec, maxSessions: 1 });
		const revSession = await shareAuthService.establishSession(c, revLid, revSec);
		await env.db.prepare("UPDATE mail_share SET status = 'REVOKED' WHERE share_id = ?")
			.bind(rev.shareId).run();
		// P4:撤销后连续约也救不回来,而且形态是 gone(裸 404)而非「不可用」。
		expect(await catchFail(shareAuthService.establishSession(c, revLid, revSec, {
			previousSessionToken: revSession.sessionToken
		}))).toBe(DESTROYED_BODY);

		const expLid = randomLid('renew-exp');
		const expSec = randomSec();
		const expired = await insertShare({ lid: expLid, sec: expSec, maxSessions: 1 });
		const expSession = await shareAuthService.establishSession(c, expLid, expSec);
		await env.db.prepare("UPDATE mail_share SET expires_at = '2001-01-01 00:00:00' WHERE share_id = ?")
			.bind(expired.shareId).run();
		expect(await catchFail(shareAuthService.establishSession(c, expLid, expSec, {
			previousSessionToken: expSession.sessionToken
		}))).toBe(UNAVAILABLE_BODY);

		// A cv bump is how revocation of the credential itself lands. The renewal right
		// dies with the credential it was minted under, so the visitor falls back to the
		// metered path — which this capped share refuses.
		const cvLid = randomLid('renew-cv');
		const cvSec = randomSec();
		const cvShare = await insertShare({ lid: cvLid, sec: cvSec, maxSessions: 1 });
		const cvSession = await shareAuthService.establishSession(c, cvLid, cvSec);
		expect(await bumpCredentialsVersion(cvShare.shareId)).toBe(1);
		expect(await catchFail(shareAuthService.establishSession(c, cvLid, cvSec, {
			previousSessionToken: cvSession.sessionToken
		}))).toBe(UNAVAILABLE_BODY);
		expect((await quotaRow(cvShare.shareId)).access_count).toBe(1);
	});

	it('meters a renewal presented long after its token died (T-22B2)', async () => {
		await ensureAccount();
		const insideLid = randomLid('renew-inside');
		const insideSec = randomSec();
		const inside = await insertShare({ lid: insideLid, sec: insideSec, maxSessions: 1 });
		const staleLid = randomLid('renew-stale');
		const staleSec = randomSec();
		const stale = await insertShare({ lid: staleLid, sec: staleSec, maxSessions: 1 });
		const c = ctx();
		const t0 = 1_700_000_000_000;
		const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
		try {
			const insideSession = await shareAuthService.establishSession(c, insideLid, insideSec);
			const staleSession = await shareAuthService.establishSession(c, staleLid, staleSec);

			nowSpy.mockReturnValue(t0 + (900 + RENEWAL_GRACE_SECONDS - 60) * 1000);
			const renewed = await shareAuthService.establishSession(c, insideLid, insideSec, {
				previousSessionToken: insideSession.sessionToken
			});
			expect((await shareAuthService.resolveSession(c, renewed.sessionToken)).shareId)
				.toBe(inside.shareId);
			expect((await quotaRow(inside.shareId)).access_count).toBe(1);

			// Past the window the holder is treated as somebody arriving fresh, which on a
			// share with its single slot already spent means no seat.
			nowSpy.mockReturnValue(t0 + (900 + RENEWAL_GRACE_SECONDS + 10) * 1000);
			expect(await catchFail(shareAuthService.establishSession(c, staleLid, staleSec, {
				previousSessionToken: staleSession.sessionToken
			}))).toBe(UNAVAILABLE_BODY);
			expect((await quotaRow(stale.shareId)).access_count).toBe(1);
		} finally {
			nowSpy.mockRestore();
		}
	});

	it('still demands the AuthKey when renewing a keyed share (T-22B2, AC-AUTH-01)', async () => {
		await ensureAccount();
		const lid = randomLid('renew-keyed');
		const sec = randomSec();
		const { shareId } = await authKeyShare({ lid, sec, maxSessions: 1 });
		const c = ctx();
		const t0 = 1_700_000_000_000;
		const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
		try {
			const first = await shareAuthService.establishSession(c, lid, sec, { authKey: AUTH_KEY });
			expect((await quotaRow(shareId)).access_count).toBe(1);

			nowSpy.mockReturnValue(t0 + 900_000 + 1_000);
			// Holding a token this share signed is not a way around the second factor.
			expect(await catchFail(shareAuthService.establishSession(c, lid, sec, {
				previousSessionToken: first.sessionToken
			}))).toBe(AUTH_REQUIRED_BODY);
			expect((await quotaRow(shareId)).access_count).toBe(1);

			const renewed = await shareAuthService.establishSession(c, lid, sec, {
				authKey: AUTH_KEY,
				previousSessionToken: first.sessionToken
			});
			expect((await shareAuthService.resolveSession(c, renewed.sessionToken)).shareId).toBe(shareId);
			expect((await quotaRow(shareId)).access_count).toBe(1);
		} finally {
			nowSpy.mockRestore();
		}
	});

	// A signature says who minted the token, not that what it minted makes sense. These
	// cases all carry a signature this deployment really produced — the only way to hold
	// one is a leaked signing key or an issuer that malfunctioned — and check that such a
	// token still cannot claim more session life than issueToken could ever have granted.
	// The share is capped at one already-spent slot throughout, so "accepted as a renewal"
	// is observable as a session appearing where the metered path would refuse one.
	it('refuses a validly signed token whose exp is not after its iat (P1-3)', async () => {
		await ensureAccount();
		const lid = randomLid('inv-exp-le-iat');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec, maxSessions: 1 });
		const c = ctx();

		await shareAuthService.establishSession(c, lid, sec);
		expect((await quotaRow(shareId)).access_count).toBe(1);

		const iat = Math.floor(Date.now() / 1000);
		// Both sit inside RENEWAL_GRACE, so the grace window alone cannot refuse them.
		for (const exp of [iat, iat - 1]) {
			const token = await mintToken({ shareId, lid, iat, exp, kid: 'v2', cv: 0 });
			expect(await catchFail(shareAuthService.establishSession(c, lid, sec, {
				previousSessionToken: token
			}))).toBe(UNAVAILABLE_BODY);
			expect(await catchFail(shareAuthService.resolveSession(c, token))).toBe(UNAVAILABLE_BODY);
		}
		expect((await quotaRow(shareId)).access_count).toBe(1);
	});

	it('refuses a validly signed token whose iat is missing or not a finite number (P1-3)', async () => {
		await ensureAccount();
		const lid = randomLid('inv-iat');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec, maxSessions: 1 });
		const c = ctx();

		await shareAuthService.establishSession(c, lid, sec);
		expect((await quotaRow(shareId)).access_count).toBe(1);

		const exp = Math.floor(Date.now() / 1000) + 900;
		// JSON.stringify folds Infinity and NaN into null, so the null row covers them too.
		const payloads = [
			{ shareId, lid, exp, kid: 'v2', cv: 0 },
			{ shareId, lid, iat: null, exp, kid: 'v2', cv: 0 },
			{ shareId, lid, iat: 'yesterday', exp, kid: 'v2', cv: 0 }
		];
		for (const payload of payloads) {
			const token = await mintToken(payload);
			expect(await catchFail(shareAuthService.establishSession(c, lid, sec, {
				previousSessionToken: token
			}))).toBe(UNAVAILABLE_BODY);
			// Without an iat there is no way to tell a live token from one whose exp was
			// simply written far enough forward, so the read path has to refuse it too.
			expect(await catchFail(shareAuthService.resolveSession(c, token))).toBe(UNAVAILABLE_BODY);
		}
		expect((await quotaRow(shareId)).access_count).toBe(1);
	});

	// The mirror of the iat case, and the one that used to be exploitable: the old read path
	// asked `payload.exp <= now`, and `undefined <= number` is false, so a signed token with no
	// exp at all was treated as never expiring. Keeping a direct sample means a future edit that
	// drops back to validating only iat gets caught here rather than in production.
	it('refuses a validly signed token whose exp is missing or not a finite number (P1-3)', async () => {
		await ensureAccount();
		const lid = randomLid('inv-exp');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec, maxSessions: 1 });
		const c = ctx();

		await shareAuthService.establishSession(c, lid, sec);
		expect((await quotaRow(shareId)).access_count).toBe(1);

		const iat = Math.floor(Date.now() / 1000);
		// JSON.stringify folds Infinity and NaN into null, so the null row covers them too.
		const payloads = [
			{ shareId, lid, iat, kid: 'v2', cv: 0 },
			{ shareId, lid, iat, exp: null, kid: 'v2', cv: 0 },
			{ shareId, lid, iat, exp: 'never', kid: 'v2', cv: 0 }
		];
		for (const payload of payloads) {
			const token = await mintToken(payload);
			expect(await catchFail(shareAuthService.establishSession(c, lid, sec, {
				previousSessionToken: token
			}))).toBe(UNAVAILABLE_BODY);
			expect(await catchFail(shareAuthService.resolveSession(c, token))).toBe(UNAVAILABLE_BODY);
		}
		expect((await quotaRow(shareId)).access_count).toBe(1);
	});

	it('refuses a validly signed token claiming more life than any issue path grants (P1-3)', async () => {
		await ensureAccount();
		const lid = randomLid('inv-lifetime');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec, maxSessions: 1 });
		const c = ctx();

		await shareAuthService.establishSession(c, lid, sec);
		expect((await quotaRow(shareId)).access_count).toBe(1);

		const iat = Math.floor(Date.now() / 1000);
		const year = 365 * 24 * 3600;
		for (const exp of [iat + year, iat + 901]) {
			const token = await mintToken({ shareId, lid, iat, exp, kid: 'v2', cv: 0 });
			expect(await catchFail(shareAuthService.establishSession(c, lid, sec, {
				previousSessionToken: token
			}))).toBe(UNAVAILABLE_BODY);
			expect(await catchFail(shareAuthService.resolveSession(c, token))).toBe(UNAVAILABLE_BODY);
		}
		expect((await quotaRow(shareId)).access_count).toBe(1);

		// One second under the same bound is exactly what issueToken mints at
		// SHARE_SESSION_TTL=900, so the bound must not be a hair stricter than the issuer.
		const atBound = await mintToken({ shareId, lid, iat, exp: iat + 900, kid: 'v2', cv: 0 });
		const renewed = await shareAuthService.establishSession(c, lid, sec, {
			previousSessionToken: atBound
		});
		expect((await shareAuthService.resolveSession(c, renewed.sessionToken)).shareId).toBe(shareId);
		expect((await quotaRow(shareId)).access_count).toBe(1);
	});

	it('keeps a normally issued token resolving and renewing after SHARE_SESSION_TTL is lowered (P1-3)', async () => {
		await ensureAccount();
		const lid = randomLid('inv-no-friendly-fire');
		const sec = randomSec();
		const { shareId } = await insertShare({ lid, sec, maxSessions: 1 });
		// issueToken falls back to DEFAULT_SESSION_TTL whenever SHARE_SESSION_TTL is unset
		// or unparseable, so a 900s token is something this deployment can mint whatever
		// the variable currently says. Lowering it afterwards must not kill that token.
		const unset = ctx({ SHARE_SESSION_TTL: '' });
		const lowered = ctx({ SHARE_SESSION_TTL: '300' });

		const first = await shareAuthService.establishSession(unset, lid, sec);
		expect(decodeTokenPayload(first.sessionToken).exp - decodeTokenPayload(first.sessionToken).iat).toBe(900);
		expect((await quotaRow(shareId)).access_count).toBe(1);

		expect((await shareAuthService.resolveSession(lowered, first.sessionToken)).shareId).toBe(shareId);
		const renewed = await shareAuthService.establishSession(lowered, lid, sec, {
			previousSessionToken: first.sessionToken
		});
		expect((await shareAuthService.resolveSession(lowered, renewed.sessionToken)).shareId).toBe(shareId);
		expect((await quotaRow(shareId)).access_count).toBe(1);

		// The other legitimate shape: exp truncated by the share's own expiry, so the
		// lifetime is far below the bound rather than at it.
		const shortLid = randomLid('inv-short-life');
		const shortSec = randomSec();
		const short = await insertShare({ lid: shortLid, sec: shortSec, expiresAt: futureText(60) });
		const shortSession = await shareAuthService.establishSession(unset, shortLid, shortSec);
		const shortPayload = decodeTokenPayload(shortSession.sessionToken);
		expect(shortPayload.exp - shortPayload.iat).toBeLessThanOrEqual(61);
		expect((await shareAuthService.resolveSession(unset, shortSession.sessionToken)).shareId)
			.toBe(short.shareId);
	});

	it('carries the visitor session token on POST /share/session so the page can renew (T-22B2)', async () => {
		await ensureAccount();
		const lid = randomLid('renew-endpoint');
		const sec = randomSec();
		await insertShare({
			lid,
			sec,
			maxSessions: 1,
			pepper: env.SHARE_SEC_PEPPER,
			pepperKid: env.SHARE_SEC_PEPPER_KID
		});

		const first = await shareFetch('POST', '/share/session', { body: { lid, sec } });
		expect(first.status).toBe(200);
		const firstToken = first.json.data.sessionToken;

		// Same request without the Authorization header is a second visitor: capped.
		const stranger = await shareFetch('POST', '/share/session', { body: { lid, sec } });
		expect(stranger.json.code).toBe(501);

		const renewed = await shareFetch('POST', '/share/session', { body: { lid, sec }, bearer: firstToken });
		expect(renewed.status).toBe(200);
		expect(renewed.json.code).toBe(200);
		expect(renewed.json.data.sessionToken).toEqual(expect.any(String));
	});
});
