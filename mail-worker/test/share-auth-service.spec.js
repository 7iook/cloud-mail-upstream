import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import shareAuthService from '../src/service/share-auth-service';
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
		SHARE_SESSION_TTL: '86400',
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
	windowStartEmailId = 10
}) {
	const secHmac = await hmacHex(pepper, sec);
	seededLids.push(lid);
	await env.db.prepare(`
		INSERT INTO mail_share (
			lid, sec_hmac, pepper_kid, user_id, account_id, status,
			window_start_email_id, expires_at, delete_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		lid, secHmac, pepperKid, USER_ID, accountId, status,
		windowStartEmailId, expiresAt, '2099-12-31 00:00:00'
	).run();
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

	it('still issues a session when access accounting fails (AC-LIFE-14)', async () => {
		await ensureAccount();
		const lid = randomLid('acct-fail');
		const sec = randomSec();
		await insertShare({ lid, sec });
		const established = await shareAuthService.establishSession(ctx(), lid, sec, {
			recordAccess: async () => {
				throw new Error('d1 write failed');
			}
		});
		expect(established.sessionToken).toEqual(expect.any(String));
		const resolved = await shareAuthService.resolveSession(ctx(), established.sessionToken);
		expect(resolved.effectiveStatus).toBe('ACTIVE');
	});

	it('increments access_count only on successful establish (AC-LIFE-10)', async () => {
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
});
