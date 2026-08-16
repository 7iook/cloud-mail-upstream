import { eq, sql } from 'drizzle-orm';
import dayjs from 'dayjs';
import { isDel } from '../const/entity-const';
import account from '../entity/account';
import { mailShare } from '../entity/mail-share';
import orm from '../entity/orm';
import BizError from '../error/biz-error';

const SHARE_UNAVAILABLE = 'SHARE_UNAVAILABLE';
// 15 minutes: long enough to wait for and copy an OTP, short enough to bound
// the same-tab sessionStorage residual after a hard navigation (AC-VISIT-12 vs 15).
const DEFAULT_SESSION_TTL = 900;
const TOKEN_VER = 's1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function throwUnavailable() {
	throw new BizError(SHARE_UNAVAILABLE);
}

function nowText() {
	return dayjs().format('YYYY-MM-DD HH:mm:ss');
}

function effectiveStatus(row, now) {
	if (!row || row.status === 'REVOKED') {
		return 'REVOKED';
	}
	if (row.expiresAt <= now) {
		return 'EXPIRED';
	}
	return 'ACTIVE';
}

function isShareDisabled(c) {
	const flag = c.env && c.env.SHARE_ENABLED;
	if (flag === '0' || flag === 0 || flag === false || flag === 'false') {
		return true;
	}
	if (typeof c.get === 'function') {
		const setting = c.get('setting');
		if (setting && (setting.share === 1 || setting.share === '1')) {
			return true;
		}
	}
	return false;
}

function base64url(bytes) {
	const str = btoa(String.fromCharCode(...new Uint8Array(bytes)));
	return str.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecode(str) {
	let padded = str.replace(/-/g, '+').replace(/_/g, '/');
	while (padded.length % 4) {
		padded += '=';
	}
	return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function timingSafeEqualBytes(a, b) {
	const len = Math.max(a.length, b.length);
	let diff = a.length ^ b.length;
	for (let i = 0; i < len; i++) {
		diff |= (a[i] || 0) ^ (b[i] || 0);
	}
	return diff === 0;
}

function timingSafeEqualString(left, right) {
	return timingSafeEqualBytes(encoder.encode(String(left)), encoder.encode(String(right)));
}

async function hmacBytes(key, message) {
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		encoder.encode(key),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)));
}

async function digestShareSecret(sec, pepper) {
	const bytes = await hmacBytes(pepper, sec);
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function collectKeyedSecrets(currentKid, currentValue, prevKid, prevValue) {
	const keys = [];
	const seen = new Set();
	const add = (kid, value) => {
		if (!value || seen.has(kid)) {
			return;
		}
		seen.add(kid);
		keys.push({ kid, value });
	};
	add(currentKid || 'v1', currentValue);
	add(prevKid || 'v0', prevValue);
	return keys;
}

function selectKeyedSecret(ring, kid) {
	let value = '';
	let found = false;
	const declared = kid == null ? '' : String(kid);
	for (const item of ring) {
		if (timingSafeEqualString(item.kid, declared)) {
			value = item.value;
			found = true;
		}
	}
	return { value, found };
}

function pepperRing(c) {
	return collectKeyedSecrets(
		c.env.SHARE_SEC_PEPPER_KID,
		c.env.SHARE_SEC_PEPPER,
		c.env.SHARE_SEC_PEPPER_PREV_KID,
		c.env.SHARE_SEC_PEPPER_PREV
	);
}

function signingRing(c) {
	return collectKeyedSecrets(
		c.env.SHARE_SESSION_SIGNING_KID,
		c.env.SHARE_SESSION_SIGNING_KEY,
		c.env.SHARE_SESSION_SIGNING_KID_PREV,
		c.env.SHARE_SESSION_SIGNING_KEY_PREV
	);
}

async function matchSec(c, sec, row) {
	const peppers = pepperRing(c);
	if (!peppers.length) {
		console.error('share-auth sec pepper missing');
		throwUnavailable();
	}
	const expected = row && row.secHmac ? row.secHmac : '0'.repeat(64);
	const selected = selectKeyedSecret(peppers, row && row.pepperKid);
	// Bind to the kid on the row. The second configured pepper serves rows
	// minted under that other kid during overlap; it is not a fallback.
	// An unconfigured kid (key removed too early) fail-closes: still run one
	// HMAC so the compare path stays constant-time, but never accept it.
	const pepper = selected.found ? selected.value : peppers[0].value;
	const digest = await digestShareSecret(sec, pepper);
	const hmacOk = timingSafeEqualString(digest, expected);
	return selected.found && hmacOk;
}

async function issueToken(c, row) {
	const keys = signingRing(c);
	if (!keys.length) {
		console.error('share-auth session signing key missing');
		throwUnavailable();
	}
	const kid = keys[0].kid;
	const iat = Math.floor(Date.now() / 1000);
	const ttlRaw = Number(c.env.SHARE_SESSION_TTL);
	const ttl = Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : DEFAULT_SESSION_TTL;
	const shareExp = dayjs(row.expiresAt).unix();
	const exp = Math.min(Number.isFinite(shareExp) ? shareExp : iat + ttl, iat + ttl);
	if (exp <= iat) {
		throwUnavailable();
	}
	const payloadB64 = base64url(encoder.encode(JSON.stringify({
		shareId: row.shareId,
		lid: row.lid,
		iat,
		exp,
		kid
	})));
	const data = `${TOKEN_VER}.${kid}.${payloadB64}`;
	const sig = await hmacBytes(keys[0].value, data);
	return `${data}.${base64url(sig)}`;
}

async function verifyToken(c, sessionToken) {
	if (sessionToken == null || sessionToken === '') {
		return null;
	}
	const parts = String(sessionToken).split('.');
	if (parts.length !== 4 || parts[0] !== TOKEN_VER) {
		return null;
	}
	const data = `${parts[0]}.${parts[1]}.${parts[2]}`;
	let sig;
	try {
		sig = base64urlDecode(parts[3]);
	} catch (err) {
		console.error('share-auth token decode failed', { name: err && err.name });
		return null;
	}
	const keys = signingRing(c);
	let ok = false;
	for (const item of keys) {
		const expected = await hmacBytes(item.value, data);
		if (timingSafeEqualBytes(expected, sig)) {
			ok = true;
		}
	}
	if (!ok) {
		return null;
	}
	try {
		const payload = JSON.parse(decoder.decode(base64urlDecode(parts[2])));
		const now = Math.floor(Date.now() / 1000);
		if (!payload || payload.exp <= now || payload.shareId == null || !payload.lid) {
			return null;
		}
		return payload;
	} catch (err) {
		console.error('share-auth token payload failed', { name: err && err.name });
		return null;
	}
}

function assertShareActive(row) {
	if (!(row.accountId > 0) || effectiveStatus(row, nowText()) !== 'ACTIVE') {
		throwUnavailable();
	}
}

async function loadLiveAccount(c, accountId) {
	const accountRow = await orm(c).select().from(account).where(eq(account.accountId, accountId)).get();
	if (!accountRow || accountRow.isDel === isDel.DELETE) {
		throwUnavailable();
	}
	return accountRow;
}

async function recordAccess(c, shareId) {
	await orm(c).update(mailShare).set({
		accessCount: sql`${mailShare.accessCount} + 1`,
		lastAccessAt: nowText()
	}).where(eq(mailShare.shareId, shareId)).run();
}

async function establishSession(c, lid, sec, deps = {}) {
	if (isShareDisabled(c)) {
		throwUnavailable();
	}
	const lidText = lid == null ? '' : String(lid);
	const secText = sec == null ? '' : String(sec);
	const row = lidText
		? await orm(c).select().from(mailShare).where(eq(mailShare.lid, lidText)).get()
		: null;
	const matched = await matchSec(c, secText, row);
	if (!row || !matched) {
		throwUnavailable();
	}
	assertShareActive(row);
	const accountRow = await loadLiveAccount(c, row.accountId);
	const sessionToken = await issueToken(c, row);
	try {
		await (deps.recordAccess || recordAccess)(c, row.shareId);
	} catch (err) {
		console.error('share-auth access accounting failed', {
			shareId: row.shareId,
			name: err && err.name
		});
	}
	return {
		sessionToken,
		mailbox: accountRow.email,
		expiresAt: row.expiresAt
	};
}

async function resolveSession(c, sessionToken) {
	if (isShareDisabled(c)) {
		throwUnavailable();
	}
	const payload = await verifyToken(c, sessionToken);
	if (!payload) {
		throwUnavailable();
	}
	const row = await orm(c).select().from(mailShare).where(eq(mailShare.shareId, payload.shareId)).get();
	if (!row || row.lid !== payload.lid) {
		throwUnavailable();
	}
	assertShareActive(row);
	await loadLiveAccount(c, row.accountId);
	return {
		shareId: row.shareId,
		accountId: row.accountId,
		windowStartEmailId: row.windowStartEmailId,
		expiresAt: row.expiresAt,
		effectiveStatus: 'ACTIVE'
	};
}

const shareAuthService = {
	digestShareSecret,
	effectiveStatus,
	establishSession,
	resolveSession
};

export default shareAuthService;
