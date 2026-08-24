import { env, SELF } from 'cloudflare:test';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import shareAuthService from '../src/service/share-auth-service';
import shareAuthSource from '../src/service/share-auth-service.js?raw';
import shareResult from '../src/model/share-result';
import { isDel } from '../src/const/entity-const';

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
async function shareFetch(method, path, { bearer, body } = {}) {
	const headers = { 'accept-language': 'en' };
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
const seededAccountIds = new Set();

async function ensureAccount({ accountId = ACCOUNT_ID, email = MAILBOX, deleted = false } = {}) {
	seededAccountIds.add(accountId);
	await env.db.prepare('DELETE FROM account WHERE account_id = ? OR email = ?').bind(accountId, email).run();
	await env.db.prepare(`
		INSERT INTO account (account_id, email, name, user_id, is_del)
		VALUES (?, ?, ?, ?, ?)
	`).bind(accountId, email, 't08', USER_ID, deleted ? isDel.DELETE : isDel.NORMAL).run();
}

async function insertShare({
	lid,
	sec,
	pepper = PEPPER_V2,
	pepperKid = 'v2',
	status = 'ACTIVE',
	expiresAt = '2099-01-01 00:00:00',
	accountId = ACCOUNT_ID,
	windowStartEmailId = 10,
	maxSessions,
	accessCount,
	credentialsVersion
}) {
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
	// Omitted by default so every pre-existing case keeps max_sessions NULL.
	if (maxSessions !== undefined) {
		columns.push('max_sessions');
		values.push(maxSessions);
	}
	if (accessCount !== undefined) {
		columns.push('access_count');
		values.push(accessCount);
	}
	// W1 has no writer for credentials_version (resetAuthKey lands in T-16), so the
	// cv predicate can only be exercised by seeding the column directly.
	if (credentialsVersion !== undefined) {
		columns.push('credentials_version');
		values.push(credentialsVersion);
	}
	await env.db.prepare(`
		INSERT INTO mail_share (${columns.join(', ')})
		VALUES (${columns.map(() => '?').join(', ')})
	`).bind(...values).run();
	const row = await env.db.prepare('SELECT share_id FROM mail_share WHERE lid = ?').bind(lid).first();
	return { shareId: row.share_id, secHmac };
}

async function cleanup() {
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

		const bodies = await Promise.all([
			catchFail(shareAuthService.establishSession(ctx(), randomLid('missing'), randomSec())),
			catchFail(shareAuthService.establishSession(ctx(), liveLid, randomSec())),
			catchFail(shareAuthService.establishSession(ctx(), expiredLid, expiredSec)),
			catchFail(shareAuthService.establishSession(ctx(), revokedLid, revokedSec)),
			catchFail(shareAuthService.establishSession(ctx(), deadLid, deadSec)),
			catchFail(shareAuthService.establishSession(ctx({ SHARE_ENABLED: '0' }), liveLid, liveSec))
		]);

		const expected = JSON.stringify(shareResult.fail('SHARE_UNAVAILABLE', 501));
		for (const body of bodies) {
			expect(body).toBe(expected);
		}
		expect(new Set(bodies).size).toBe(1);
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

		const afterRevoke = await catchFail(shareAuthService.resolveSession(c, established.sessionToken));
		expect(afterRevoke).toBe(JSON.stringify(shareResult.fail('SHARE_UNAVAILABLE', 501)));
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
		expect(await catchFail(shareAuthService.resolveSession(c, revokedSession.sessionToken)))
			.toBe(JSON.stringify(shareResult.fail('SHARE_UNAVAILABLE', 501)));
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

function futureText(secondsFromNow) {
	const at = new Date(Date.now() + secondsFromNow * 1000);
	const pad = (n) => String(n).padStart(2, '0');
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} `
		+ `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

function functionSource(source, name) {
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
		expect(await catchFail(shareAuthService.resolveSession(ctx(), established.sessionToken)))
			.toBe(UNAVAILABLE_BODY);

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
