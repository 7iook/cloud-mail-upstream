/*
 * Reversible envelope encryption for the share credential `sec`
 * (ADR-share-credential-recoverability · "密文持久化协议").
 *
 * This module is the whole cryptographic surface of that decision and nothing
 * else: it neither reads D1 nor logs nor decides HTTP shape. Wiring (create /
 * regenerate writes, the reveal endpoint, alerting) lives in the callers, which
 * is why every failure comes back as a value they can branch on.
 *
 * Guarantees:
 * - AES-256-GCM under a key derived per kid via HKDF-SHA256 (info fixed to
 *   HKDF_INFO, salt = the kid). The same material derives the same key in every
 *   environment, so ciphertext travels with the data.
 * - A fresh 96-bit CSPRNG nonce per encryption. It is never derived from
 *   shareId, a counter, or a clock: under GCM a repeated nonce collapses
 *   confidentiality and leaks the auth key.
 * - shareId is the AAD, so an envelope copied onto another row fails the tag
 *   check instead of decrypting.
 * - Four *distinct* failure reasons (ABSENT / KEK_MISSING / UNKNOWN_KID /
 *   AUTH_FAILED), plus MALFORMED. They are never folded together: the caller
 *   has to tell "created before the feature shipped" (normal) apart from
 *   "the KEK is not deployed" and "this ciphertext was tampered with" (both
 *   incidents) to decide what to show and whether to alert.
 * - A malformed envelope returns MALFORMED; no input shape throws.
 *
 * Does not guarantee:
 * - Protection when D1 and the KEK leak together. That cost is the explicit
 *   subject of the ADR, not an oversight.
 * - More than two live keys. The ring is fixed current+prev, identical in shape
 *   to the pepper and signing rings (share-auth-service.js:152-168), so all
 *   three kinds of key are operated the same way.
 *
 * KEK material is used as HKDF input keying material *verbatim*, as the UTF-8
 * bytes of the configured string — it is deliberately not base64-decoded first.
 * HKDF extracts from arbitrary-length IKM, and skipping the decode removes the
 * only step where two environments could disagree about the same secret and
 * silently derive different keys. The documented format (base64url of 32 random
 * bytes) still governs how operators generate it.
 *
 * The kid on the data row is the single source of truth for which key decrypts
 * it; the ring only supplies material by kid and never votes by position.
 */
import { collectKeyedSecrets } from './keyed-secret-ring';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const ENVELOPE_VERSION = 'v1';
export const HKDF_INFO = 'share-sec-kek';
export const NONCE_BYTES = 12;

export const SEC_CIPHER_FAILURE = {
	ABSENT: 'absent',
	KEK_MISSING: 'kek_missing',
	UNKNOWN_KID: 'unknown_kid',
	AUTH_FAILED: 'auth_failed',
	MALFORMED: 'malformed'
};

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function base64url(bytes) {
	const str = btoa(String.fromCharCode(...new Uint8Array(bytes)));
	return str.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Returns null rather than throwing: on the read path an illegal segment is one
// of the caller's expected outcomes (MALFORMED), not an exception to handle.
function base64urlDecode(str) {
	if (typeof str !== 'string' || !BASE64URL_RE.test(str)) {
		return null;
	}
	let padded = str.replace(/-/g, '+').replace(/_/g, '/');
	while (padded.length % 4) {
		padded += '=';
	}
	try {
		return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
	} catch {
		return null;
	}
}

/*
 * Same current+prev shape as the pepper and signing rings. The nine lines that
 * used to be restated here now live in keyed-secret-ring.js (T-20b2a): the
 * duplicate was only ever there because share-auth-service.js was held by
 * another work package, and three copies of a key ring drift silently until a
 * rotation lands on the odd one out. Only the source of the shape moved — which
 * variables feed it, and the envelope protocol below, are unchanged.
 */
export function kekRing(env) {
	const source = env || {};
	return collectKeyedSecrets(
		source.SHARE_SEC_KEK_KID,
		source.SHARE_SEC_KEK,
		source.SHARE_SEC_KEK_PREV_KID,
		source.SHARE_SEC_KEK_PREV
	);
}

/*
 * Lets the create path fail closed before it writes a row. "Created but not
 * encrypted" is the one outcome the ADR rules out entirely: it produces shares
 * that look recoverable and are not, and nobody finds out until an owner opens
 * the detail drawer days later.
 */
export function probeKek(env) {
	const ring = kekRing(env);
	return {
		available: ring.length > 0,
		currentKid: ring.length ? ring[0].kid : null,
		kids: ring.map((item) => item.kid)
	};
}

function requireShareId(shareId) {
	const value = shareId == null ? '' : String(shareId);
	if (!value) {
		// A programming error, not a runtime failure class: encrypting without the
		// AAD would produce a portable ciphertext, which is precisely what binding
		// to shareId exists to prevent.
		throw new TypeError('share-sec-cipher requires a non-empty shareId');
	}
	return value;
}

function additionalData(shareId) {
	return encoder.encode(`${ENVELOPE_VERSION}:${shareId}`);
}

async function deriveKey(material, kid) {
	const ikm = await crypto.subtle.importKey(
		'raw',
		encoder.encode(material),
		'HKDF',
		false,
		['deriveKey']
	);
	return crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: encoder.encode(kid),
			info: encoder.encode(HKDF_INFO)
		},
		ikm,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

/*
 * Parsed right-to-left so a kid containing ':' cannot break the format: the
 * nonce and ciphertext segments are base64url and therefore colon-free, which
 * makes the two trailing segments unambiguous.
 */
function parseEnvelope(envelope) {
	if (typeof envelope !== 'string') {
		return null;
	}
	const parts = envelope.split(':');
	if (parts.length < 4 || parts[0] !== ENVELOPE_VERSION) {
		return null;
	}
	const kid = parts.slice(1, parts.length - 2).join(':');
	if (!kid) {
		return null;
	}
	const nonce = base64urlDecode(parts[parts.length - 2]);
	const ciphertext = base64urlDecode(parts[parts.length - 1]);
	if (!nonce || nonce.length !== NONCE_BYTES || !ciphertext) {
		return null;
	}
	return { kid, nonce, ciphertext };
}

/*
 * → { ok: true, envelope, kekKid } | { ok: false, reason: KEK_MISSING }
 * Always writes under the ring's current kid; existing rows keep their own.
 */
export async function encryptShareSec(env, { shareId, plaintext } = {}) {
	const boundShareId = requireShareId(shareId);
	if (plaintext == null) {
		throw new TypeError('share-sec-cipher requires a plaintext to encrypt');
	}
	const ring = kekRing(env);
	if (!ring.length) {
		return { ok: false, reason: SEC_CIPHER_FAILURE.KEK_MISSING };
	}
	const { kid, value } = ring[0];
	const key = await deriveKey(value, kid);
	const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
	const sealed = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: nonce, additionalData: additionalData(boundShareId) },
		key,
		encoder.encode(String(plaintext))
	);
	return {
		ok: true,
		envelope: `${ENVELOPE_VERSION}:${kid}:${base64url(nonce)}:${base64url(sealed)}`,
		kekKid: kid
	};
}

/*
 * → { ok: true, plaintext, kekKid }
 * | { ok: false, reason: ABSENT }                  row predates the feature
 * | { ok: false, reason: KEK_MISSING }             nothing configured — deploy incident
 * | { ok: false, reason: UNKNOWN_KID, kekKid }     key already retired from the ring
 * | { ok: false, reason: AUTH_FAILED, kekKid }     tampered, corrupted, or wrong row
 * | { ok: false, reason: MALFORMED }               unparseable envelope
 *
 * Checked in that order on purpose: a missing KEK is a deployment incident and
 * must not be reported as one of the benign outcomes that happen to also apply.
 */
export async function decryptShareSec(env, { shareId, envelope } = {}) {
	const boundShareId = requireShareId(shareId);
	if (envelope == null || (typeof envelope === 'string' && !envelope.trim())) {
		return { ok: false, reason: SEC_CIPHER_FAILURE.ABSENT };
	}
	const ring = kekRing(env);
	if (!ring.length) {
		return { ok: false, reason: SEC_CIPHER_FAILURE.KEK_MISSING };
	}
	const parsed = parseEnvelope(envelope);
	if (!parsed) {
		return { ok: false, reason: SEC_CIPHER_FAILURE.MALFORMED };
	}
	const match = ring.find((item) => item.kid === parsed.kid);
	if (!match) {
		return { ok: false, reason: SEC_CIPHER_FAILURE.UNKNOWN_KID, kekKid: parsed.kid };
	}
	const key = await deriveKey(match.value, match.kid);
	let opened;
	try {
		opened = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: parsed.nonce, additionalData: additionalData(boundShareId) },
			key,
			parsed.ciphertext
		);
	} catch {
		// The only failure subtle.decrypt reports for AES-GCM is tag rejection, and
		// it is deliberately surfaced rather than swallowed: a share whose stored
		// ciphertext no longer authenticates is a data-integrity incident.
		return { ok: false, reason: SEC_CIPHER_FAILURE.AUTH_FAILED, kekKid: parsed.kid };
	}
	return { ok: true, plaintext: decoder.decode(opened), kekKid: parsed.kid };
}
