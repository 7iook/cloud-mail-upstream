import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { isDel } from '../const/entity-const';
import KvConst from '../const/kv-const';
import account from '../entity/account';
import { mailShare } from '../entity/mail-share';
import { mailShareBinding } from '../entity/mail-share-binding';
import orm from '../entity/orm';
import BizError from '../error/biz-error';
// The pepper ring, the signing ring below and the KEK ring in share-sec-cipher.js
// are the same shape; it lives in one place so a rotation cannot behave
// differently depending on which of the three it lands on.
import { collectKeyedSecrets } from '../security/keyed-secret-ring';
import { toUtc } from '../utils/date-uitil';
// Known cycle with mail-share-service: it imports this module too. Both directions
// are dereferenced inside function bodies only, so neither module evaluation hits a
// TDZ. The event names stay in one place until W2 extracts them.
import { SHARE_EVENT, logShareEvent } from './share-event';

const SHARE_UNAVAILABLE = 'SHARE_UNAVAILABLE';
// The only business code a visitor can ever tell apart from SHARE_UNAVAILABLE, and
// only after lid+sec already matched (AC-AUTH-02).
const SHARE_AUTH_REQUIRED = 'SHARE_AUTH_REQUIRED';
// 15 minutes: long enough to wait for and copy an OTP, short enough to bound
// the same-tab sessionStorage residual after a hard navigation (AC-VISIT-12 vs 15).
const DEFAULT_SESSION_TTL = 900;
// Delivery-side floor for the polling interval handed to the visitor page. The
// write-side rejection of a too-small stored value is T-12; this only makes sure a
// row that already holds one cannot turn a client into a self-inflicted DoS.
const MIN_REFRESH_INTERVAL_MS = 3000;
const TOKEN_VER = 's1';
// Workers KV refuses an expirationTtl below 60 seconds, and a token with less life
// than that left is not worth replaying anyway, so the write is skipped instead.
const KV_MIN_TTL = 60;
// The replay window only has to outlive a client retry, not the session.
const ESTABLISH_REPLAY_TTL = 120;
// How long after a session token dies its holder may still trade it for a fresh one
// without spending a second slot (T-22B2). Long enough to survive a closed laptop or a
// dropped connection, short enough that a leaked dead token stops being a free seat.
const RENEWAL_GRACE = 3600;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function throwUnavailable() {
	throw new BizError(SHARE_UNAVAILABLE);
}

function throwAuthRequired() {
	throw new BizError(SHARE_AUTH_REQUIRED);
}

// 恒 UTC：既是 last_access_at 的写入值，也是配额闸门 `expires_at > ?` 的比较基准。
// 取进程本地时区会让本地开发(UTC+8)写出比真实时刻晚 8 小时的裸串。
function nowText() {
	return toUtc().format('YYYY-MM-DD HH:mm:ss');
}

function effectiveStatus(row, now) {
	if (!row || row.status === 'REVOKED') {
		return 'REVOKED';
	}
	if (row.expiresAt <= now) {
		return 'EXPIRED';
	}
	// NULL/undefined max_sessions means unlimited; a configured cap is reached
	// at >=, so a cap of 0 is reached immediately.
	if (row.maxSessions != null && row.accessCount >= row.maxSessions) {
		return 'ACCESS_LIMIT_REACHED';
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

// Same construction as matchSec — HMAC under the pepper named by the row's own kid,
// constant-time compare — because AuthKey is a second factor of the same kind, not a
// password (AC-AUTH-03). Never logged, never stored in the clear.
async function matchAuthKey(c, authKey, row) {
	const peppers = pepperRing(c);
	if (!peppers.length) {
		console.error('share-auth key pepper missing');
		return false;
	}
	const expected = row.authKeyHash ? row.authKeyHash : '0'.repeat(64);
	const selected = selectKeyedSecret(peppers, row.authKeyKid);
	const pepper = selected.found ? selected.value : peppers[0].value;
	const digest = await digestShareSecret(authKey, pepper);
	const hmacOk = timingSafeEqualString(digest, expected);
	return Boolean(row.authKeyHash) && selected.found && hmacOk;
}

function readAuthKey(options) {
	const raw = options && options.authKey;
	return raw == null ? '' : String(raw).trim();
}

function sessionTtl(c) {
	const ttlRaw = Number(c.env.SHARE_SESSION_TTL);
	return Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : DEFAULT_SESSION_TTL;
}

// The longest life this deployment could ever have signed, and therefore the only
// upper bound parseToken may enforce: a bound stricter than the issuer would refuse
// tokens the worker itself minted. It is deliberately not just the currently
// configured TTL — issueToken falls back to DEFAULT_SESSION_TTL whenever
// SHARE_SESSION_TTL is unset or unparseable, so a default-length token is legitimate
// even while the variable reads shorter.
function maxTokenLifetime(c) {
	return Math.max(sessionTtl(c), DEFAULT_SESSION_TTL);
}

async function issueToken(c, row) {
	const keys = signingRing(c);
	if (!keys.length) {
		console.error('share-auth session signing key missing');
		throwUnavailable();
	}
	const kid = keys[0].kid;
	const iat = Math.floor(Date.now() / 1000);
	const ttl = sessionTtl(c);
	// expiresAt 是不带时区标记的 UTC 裸串，必须按 UTC 读回，否则非 UTC 进程会把
	// token 的绝对上界算偏一个时区偏移量。
	const shareExp = toUtc(row.expiresAt).unix();
	const exp = Math.min(Number.isFinite(shareExp) ? shareExp : iat + ttl, iat + ttl);
	if (exp <= iat) {
		throwUnavailable();
	}
	const payloadB64 = base64url(encoder.encode(JSON.stringify({
		shareId: row.shareId,
		lid: row.lid,
		iat,
		exp,
		kid,
		// The token version stays s1: a pre-T-08 token simply has no cv and resolves
		// as version 0, which is exactly the value every un-reset row carries.
		cv: row.credentialsVersion == null ? 0 : row.credentialsVersion
	})));
	const data = `${TOKEN_VER}.${kid}.${payloadB64}`;
	const sig = await hmacBytes(keys[0].value, data);
	// `exp` travels back out so the replay cache can size its TTL against the token's
	// real remaining life rather than re-deriving it from the row.
	return { sessionToken: `${data}.${base64url(sig)}`, exp };
}

// A signature proves who minted the token, never that what it minted makes sense, so
// the pair (iat, exp) is checked for internal consistency on top of it: both finite,
// exp strictly after iat, and a claimed life no longer than issueToken could grant.
// The comparison is between two values inside the token, so no clock skew enters it.
// Only a leaked signing key or a malfunctioning issuer can produce a token that fails
// here; refusing it keeps that blast radius at "no session" instead of "a session with
// whatever life the token asked for".
function hasSaneLifetime(c, payload) {
	if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp) || payload.exp <= payload.iat) {
		return false;
	}
	return payload.exp - payload.iat <= maxTokenLifetime(c);
}

// Signature and shape only. Expiry is verifyToken's own check rather than part of this
// one, because the renewal path deliberately accepts a token that has just died — a
// token at the end of its life is precisely the signal it looks for. The time
// invariants above are part of the shape and live here rather than in either caller,
// so verifyToken and isRenewal cannot drift into disagreeing about what a token is.
async function parseToken(c, sessionToken) {
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
		if (!payload || payload.shareId == null || !payload.lid) {
			return null;
		}
		if (!hasSaneLifetime(c, payload)) {
			// Reason only: this line shares the AC-LEAK-05 fence with the rest of the
			// module, so no lid, token or claim value may reach it. It is worth logging
			// at all because a well-signed token failing here is a signing-key or
			// issuer alarm, not ordinary visitor traffic.
			console.error('share-auth token time invariants failed');
			return null;
		}
		return payload;
	} catch (err) {
		console.error('share-auth token payload failed', { name: err && err.name });
		return null;
	}
}

async function verifyToken(c, sessionToken) {
	const payload = await parseToken(c, sessionToken);
	if (!payload || payload.exp <= Math.floor(Date.now() / 1000)) {
		return null;
	}
	return payload;
}

function readPreviousSessionToken(options) {
	const raw = options && options.previousSessionToken;
	return raw == null ? '' : String(raw).trim();
}

// A renewal is the visitor handing back the session token this very share signed for
// them. The signature is the entire proof, and it has to be: every visitor of one link
// holds the same lid, the same sec and the same AuthKey, so nothing a visitor can author
// tells them apart. A claim carried in the request ("this is a renewal") would let anyone
// opt out of the cap; only a value the worker minted under its own signing key cannot be
// produced by the person it is being checked against.
// Bound to this row on three axes so a signature alone is not enough: shareId+lid stop a
// token earned on a throwaway share from buying a free seat on a capped one, and cv ends
// the chain the moment the credential behind it is rotated or revoked.
// A failed check is not an error — it is somebody opening the link, and it falls through
// to the metered path, which is what keeps forgery pointless rather than merely refused.
async function isRenewal(c, row, lidText, previousSessionToken) {
	if (!previousSessionToken) {
		return false;
	}
	const payload = await parseToken(c, previousSessionToken);
	if (!payload || payload.shareId !== row.shareId || payload.lid !== lidText) {
		return false;
	}
	if ((payload.cv == null ? 0 : payload.cv) !== row.credentialsVersion) {
		return false;
	}
	// parseToken already guaranteed exp is a finite number strictly after iat, so the
	// only question left here is whether the grace window has closed.
	return payload.exp + RENEWAL_GRACE > Math.floor(Date.now() / 1000);
}

// Establishing a session needs a fully ACTIVE share; an already-issued session
// keeps reading through ACCESS_LIMIT_REACHED (AC-SESS-06: close the door,
// don't clear the room). A renewal reads the second list for the same reason.
const ESTABLISH_ALLOWED = ['ACTIVE'];
const RESOLVE_ALLOWED = ['ACTIVE', 'ACCESS_LIMIT_REACHED'];

function assertAllowed(row, allowed) {
	const state = effectiveStatus(row, nowText());
	if (!(row.accountId > 0) || !allowed.includes(state)) {
		throwUnavailable();
	}
	return state;
}

async function loadLiveAccount(c, accountId) {
	const accountRow = await orm(c).select().from(account).where(eq(account.accountId, accountId)).get();
	if (!accountRow || accountRow.isDel === isDel.DELETE) {
		throwUnavailable();
	}
	return accountRow;
}

// The binding rows of one share, lowest binding_id first (that ordering is the
// primary-binding rule), keeping only the ones whose account is still live.
// A share with no binding rows at all is the pre-Binding single-mailbox shape: the
// primary `account_id` / `window_start_email_id` pair on mail_share is the binding,
// and it is presented under bindingId 0 so callers never have to special-case it.
async function loadLiveBindings(c, row) {
	const bindingRows = await orm(c)
		.select()
		.from(mailShareBinding)
		.where(eq(mailShareBinding.shareId, row.shareId))
		.orderBy(asc(mailShareBinding.bindingId))
		.all();
	if (!bindingRows || !bindingRows.length) {
		const accountRow = await loadLiveAccount(c, row.accountId);
		return [{
			bindingId: 0,
			accountId: row.accountId,
			windowStartEmailId: row.windowStartEmailId,
			email: accountRow.email
		}];
	}
	const accountRows = await orm(c)
		.select()
		.from(account)
		.where(inArray(account.accountId, bindingRows.map((item) => item.accountId)))
		.all();
	const live = new Map();
	for (const item of accountRows || []) {
		if (item.isDel !== isDel.DELETE) {
			live.set(item.accountId, item);
		}
	}
	const bindings = bindingRows
		.filter((item) => item.accountId > 0 && live.has(item.accountId))
		.map((item) => ({
			bindingId: item.bindingId,
			accountId: item.accountId,
			windowStartEmailId: item.windowStartEmailId,
			email: live.get(item.accountId).email
		}));
	if (!bindings.length) {
		throwUnavailable();
	}
	return bindings;
}

function toBoolean(value) {
	return value === 1 || value === '1' || value === true;
}

// The ShareContext contract frozen by T-08: W2 consumes `bindings`, nothing else may
// reshape it. `accountId` / `windowStartEmailId` are deprecated single-binding shims
// for the readers that still take scalars; T-11 removes them.
function buildShareContext(row, bindings, state) {
	const list = bindings.map((item) => Object.freeze({
		bindingId: item.bindingId,
		accountId: item.accountId,
		windowStartEmailId: item.windowStartEmailId
	}));
	const primary = list[0];
	return Object.freeze({
		shareId: row.shareId,
		bindings: Object.freeze(list),
		messageLimit: row.messageLimit == null ? null : Number(row.messageLimit),
		otpExtractionEnabled: toBoolean(row.otpExtractionEnabled),
		showFullAddress: toBoolean(row.showFullAddress),
		expiresAt: row.expiresAt,
		accountId: primary.accountId,
		windowStartEmailId: primary.windowStartEmailId,
		effectiveStatus: state
	});
}

// Decision 14: masking is a display preference, not a confidentiality boundary, so it
// lives with the response that renders it. T-11 owns shareMailService.maskAddress for
// the mail projection; duplicating four lines here beats dragging the read path into
// the auth module for one string.
function maskAddress(address) {
	const text = address == null ? '' : String(address);
	const at = text.indexOf('@');
	if (at <= 0) {
		return text ? `${text[0]}***` : '';
	}
	return `${text[0]}***${text.slice(at)}`;
}

function clampRefreshInterval(value) {
	const ms = Number(value);
	if (!Number.isFinite(ms)) {
		return MIN_REFRESH_INTERVAL_MS;
	}
	return Math.max(MIN_REFRESH_INTERVAL_MS, Math.floor(ms));
}

function buildSessionPayload(row, bindings, sessionToken) {
	const showFullAddress = toBoolean(row.showFullAddress);
	return {
		sessionToken,
		// Deprecated: the pre-T-08 single-mailbox field, unmasked, kept until the
		// visitor page reads mailboxes[].
		mailbox: bindings[0].email,
		shareType: bindings.length > 1 ? 'multi' : 'single',
		mailboxes: bindings.map((item) => ({
			bindingId: item.bindingId,
			address: showFullAddress ? item.email : maskAddress(item.email)
		})),
		expiresAt: row.expiresAt,
		config: {
			autoRefresh: toBoolean(row.autoRefresh),
			refreshIntervalMs: clampRefreshInterval(row.refreshIntervalMs),
			otpExtractionEnabled: toBoolean(row.otpExtractionEnabled),
			messageLimit: row.messageLimit == null ? null : Number(row.messageLimit)
		}
	};
}

// Only shareId and reason: this line goes through console.log and is covered by the
// AC-LEAK-05 fence, so no lid, sec or token may reach it.
function denyQuota(c, shareId, reason) {
	logShareEvent(c, SHARE_EVENT.SESSION_DENIED_QUOTA, { shareId, reason });
	throwUnavailable();
}

// The single linearization point for quota and authorization (AC-SESS-01). The WHERE
// re-asserts every fact the snapshot observed, so a revoke, expiry or resetAuthKey
// that commits after the snapshot loses the race instead of being written over. The
// credentials_version predicate doubles as a snapshot-freshness guard: a stale read
// (today impossible, D1 only replicates behind the Sessions API) can never win here.
// auth_key_enabled needs its own predicate because enabling the factor deliberately
// does not bump credentials_version (AC-AUTH-07), so an enable that commits after a
// keyless snapshot would otherwise still mint an unkeyed token on a keyed share.
// An empty RETURNING therefore means "someone else changed the world"; refuse.
// A renewal runs the same statement rather than a second one, so revoke, expiry and cv
// rotation still land on it atomically: skipping the gate for renewals would be exactly
// the "this is a renewal, let it through" hole that makes the cap meaningless.
async function consumeSessionQuota(c, shareId, expectedCv, now, expectedAuthKeyEnabled, renewal) {
	const conditions = [
		eq(mailShare.shareId, shareId),
		eq(mailShare.status, 'ACTIVE'),
		gt(mailShare.expiresAt, now),
		eq(mailShare.credentialsVersion, expectedCv),
		eq(mailShare.authKeyEnabled, expectedAuthKeyEnabled)
	];
	if (!renewal) {
		// The cap is the one predicate a renewal drops. Its holder already paid for a
		// slot, and refusing here is the bug itself: a full share evicting the people
		// who are in it (AC-SESS-06, close the door without clearing the room).
		conditions.push(or(isNull(mailShare.maxSessions), sql`${mailShare.accessCount} < ${mailShare.maxSessions}`));
	}
	return await orm(c).update(mailShare).set({
		// The renewal writes access_count back unchanged instead of leaving the column
		// out, so both paths keep one statement shape and the gate stays the single
		// linearization point rather than forking into a second writer.
		accessCount: renewal ? sql`${mailShare.accessCount}` : sql`${mailShare.accessCount} + 1`,
		lastAccessAt: now
	}).where(and(...conditions)).returning({ accessCount: mailShare.accessCount });
}

function replayCacheKey(lid, key) {
	return `${KvConst.SHARE_EST}${lid}:${key}`;
}

function readIdempotencyKey(options) {
	const raw = options && options.idempotencyKey;
	// Whitespace-only is the same as absent: a client that sends it gets the plain
	// metered path rather than a cache entry nobody can address again.
	return raw == null ? '' : String(raw).trim();
}

// Fail-open on both sides (AC-SESS-10): KV being down must not take the whole share
// surface with it, so a read failure degrades to "cache miss" and a write failure to
// "this attempt has no replay protection". Only shareId and a fixed reason reach the
// log — the cache key embeds the lid, so the key itself must never be logged.
// A hit only counts when the cached token still carries the row's current cv: after a
// reset or disable the visitor arrives with the new key, and replaying the pre-bump
// token would answer a valid credential with a session that dies on its first resolve
// (AC-EDGE-05). Enable does not bump cv, so a same-key replay stays a hit (AC-AUTH-07).
async function readReplayCache(c, lid, key, row) {
	try {
		const cached = await c.env.kv.get(replayCacheKey(lid, key), { type: 'json' });
		if (cached && cached.sessionToken) {
			const payload = await verifyToken(c, cached.sessionToken);
			if (payload && (payload.cv == null ? 0 : payload.cv) === row.credentialsVersion) {
				return cached;
			}
		}
	} catch {
		logShareEvent(c, SHARE_EVENT.SYSTEM_ERROR, { shareId: row.shareId, reason: 'replay_cache_read_failed' });
	}
	return null;
}

// A KV write is visible immediately at the writing location but takes up to 60s to
// reach other PoPs, so a retry routed elsewhere can still miss and spend a second
// slot. That is the documented fail-open window, not a bug to retry around.
async function writeReplayCache(c, lid, key, shareId, result, exp) {
	const remaining = exp - Math.floor(Date.now() / 1000);
	if (remaining < KV_MIN_TTL) {
		return;
	}
	try {
		await c.env.kv.put(replayCacheKey(lid, key), JSON.stringify(result), {
			expirationTtl: Math.min(ESTABLISH_REPLAY_TTL, remaining)
		});
	} catch {
		logShareEvent(c, SHARE_EVENT.SYSTEM_ERROR, { shareId, reason: 'replay_cache_write_failed' });
	}
}

// `options` carries the idempotency key (T-07) and the AuthKey (T-08). The service
// never reads c.req, so the transport decides where each one comes from: the key
// travels in the JSON body, the idempotency key in a header.
async function establishSession(c, lid, sec, options = {}) {
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
	// ① sec already matched. ③ at least one binding account must still be live
	// before we return a cached token, then ④ the AuthKey.
	// Quota / ACTIVE checks are the UPDATE's job and MUST sit after replay:
	// a max_sessions=1 first success leaves the snapshot ACCESS_LIMIT_REACHED,
	// and putting denyQuota/assertAllowed first would refuse the exact retry
	// AC-SESS-10 exists to recover (design.md:357 · requirements.md:95).
	const bindings = await loadLiveBindings(c, row);
	// ④ above the replay lookup on purpose: a visitor without the key must not be
	// handed a token someone else already paid for (AC-AUTH-01).
	if (toBoolean(row.authKeyEnabled)) {
		const matchedKey = await matchAuthKey(c, readAuthKey(options), row);
		if (!matchedKey) {
			// No counter, no lockout, no per-IP state (AC-AUTH-05 / R2-A6): one line of
			// telemetry carrying nothing but the share id and a fixed reason.
			logShareEvent(c, SHARE_EVENT.SESSION_DENIED_AUTH, {
				shareId: row.shareId,
				reason: 'auth_key_mismatch'
			});
			throwAuthRequired();
		}
	}
	const idempotencyKey = readIdempotencyKey(options);
	if (idempotencyKey) {
		const replayed = await readReplayCache(c, lidText, idempotencyKey, row);
		if (replayed) {
			return replayed;
		}
	}
	// The snapshot read above stays: AC-SEC-08 bans a read-then-write state change,
	// not a read. It carries sec_hmac for the credential check and credentials_version
	// into the gate below, while the state change itself is still one statement.
	// T-22B2: max_sessions counts people, not the browser's 15-minute rebuild cycle, so a
	// token this share already signed buys its holder a fresh one on the same slot. It is
	// resolved below the AuthKey gate on purpose — a renewal continues an authorized
	// session, it does not stand in for the authorization.
	const renewal = await isRenewal(c, row, lidText, readPreviousSessionToken(options));
	// assertAllowed throws rather than returning the capped state, so recompute it here
	// to keep the everyday "cap already reached" refusal observable.
	if (!renewal && effectiveStatus(row, nowText()) === 'ACCESS_LIMIT_REACHED') {
		denyQuota(c, row.shareId, 'quota_snapshot');
	}
	// A renewal reads the same allow-list as resolveSession because it is the same
	// question: may an existing session keep going? Only a new one needs a fully ACTIVE
	// share.
	assertAllowed(row, renewal ? RESOLVE_ALLOWED : ESTABLISH_ALLOWED);
	const now = nowText();
	let applied;
	try {
		applied = await consumeSessionQuota(c, row.shareId, row.credentialsVersion, now, row.authKeyEnabled, renewal);
	} catch (err) {
		// AC-SESS-11: a gate that never landed must refuse, not hand out an unmetered
		// session the way the old fire-and-forget accounting did.
		console.error('share-auth quota gate failed', {
			shareId: row.shareId,
			name: err && err.name
		});
		throwUnavailable();
	}
	if (!applied.length) {
		denyQuota(c, row.shareId, 'quota_race');
	}
	// Only now is the slot ours. A state change committing between here and the
	// response is the documented TOCTOU window (AC-EDGE-13): the token dies on its
	// first trip back and the slot is not refunded.
	const { sessionToken, exp } = await issueToken(c, row);
	const result = buildSessionPayload(row, bindings, sessionToken);
	if (idempotencyKey) {
		// Cache the whole response so a replay is byte-identical to the first one.
		await writeReplayCache(c, lidText, idempotencyKey, row.shareId, result, exp);
	}
	return result;
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
	// A token minted before T-08 carries no cv and belongs to version 0, which is what
	// every row that was never reset still holds. Once resetAuthKey bumps the row, the
	// mismatch kills the session on its very next request (AC-AUTH-04 / AC-EDGE-05).
	if ((payload.cv == null ? 0 : payload.cv) !== row.credentialsVersion) {
		logShareEvent(c, SHARE_EVENT.SESSION_DENIED_CV, {
			shareId: row.shareId,
			reason: 'credentials_version_mismatch'
		});
		throwUnavailable();
	}
	const state = assertAllowed(row, RESOLVE_ALLOWED);
	const bindings = await loadLiveBindings(c, row);
	return buildShareContext(row, bindings, state);
}

const shareAuthService = {
	digestShareSecret,
	effectiveStatus,
	establishSession,
	resolveSession
};

export default shareAuthService;
