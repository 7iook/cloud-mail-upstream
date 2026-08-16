/*
 * Anonymous share abuse protection (AC-ABUSE-08, P-TRANS-01).
 *
 * Uses Cloudflare Workers Rate Limiting bindings. Does not lock by lid
 * (public URL; a third party could DoS the real recipient). Does not
 * count in D1 or KV (non-atomic increment + 60s KV cache).
 *
 * Guarantees:
 * - When limit() returns { success: false }, the Worker returns HTTP 429
 *   + Retry-After and does not map the request to SHARE_UNAVAILABLE.
 * - The key is CF-Connecting-IP only. lid/sec are never part of the key.
 * - X-Forwarded-For is ignored (client-controlled; req-utils.js:3-7).
 * - 429 is a returned Response, not a thrown error, so hono.js onError
 *   cannot rewrite it to HTTP 200.
 *
 * Does not guarantee:
 * - A precise global quota. Counters are per Cloudflare location and
 *   eventually consistent / permissive.
 * - Protection against a distributed attacker (ceiling ~= limit * PoPs).
 * - Periods other than 10 or 60 seconds (platform constraint).
 * - Enforcement when the binding is missing (fail-open so vitest and a
 *   misconfigured deploy do not take down share). Deploy must include
 *   [[ratelimits]] in wrangler.toml.
 *
 * Retry-After is the limiter period (60s), not a remaining-window estimate.
 * Visitors are anonymous, so IP is the only stable actor key. Shared NAT
 * is an accepted limit of this blunt instrument.
 */
import shareResult from '../model/share-result';

export const SHARE_SESSION_RATE_LIMITER = 'SHARE_SESSION_RATE_LIMITER';
export const SHARE_READ_RATE_LIMITER = 'SHARE_READ_RATE_LIMITER';
export const SHARE_SESSION_RETRY_AFTER_SECONDS = 60;
export const SHARE_READ_RETRY_AFTER_SECONDS = 60;
export const MISSING_CONNECTING_IP_KEY = 'missing-cf-connecting-ip';

export function readRateLimitKey(c) {
	const ip = c.req.header('CF-Connecting-IP');
	if (typeof ip === 'string') {
		const trimmed = ip.trim();
		if (trimmed) {
			return trimmed;
		}
	}
	return MISSING_CONNECTING_IP_KEY;
}

export function limitedShareResponse(c, retryAfterSeconds) {
	return c.json(shareResult.fail('RATE_LIMITED', 429), 429, {
		'Retry-After': String(retryAfterSeconds),
		'Cache-Control': 'no-store'
	});
}

export async function enforceShareRateLimit(c, limiter, retryAfterSeconds) {
	if (!limiter || typeof limiter.limit !== 'function') {
		return null;
	}
	const key = readRateLimitKey(c);
	let outcome;
	try {
		outcome = await limiter.limit({ key });
	} catch (err) {
		const detail = err && err.message ? err.message : String(err);
		console.error('share rate limiter.limit failed', detail);
		return null;
	}
	if (outcome && outcome.success === false) {
		return limitedShareResponse(c, retryAfterSeconds);
	}
	return null;
}

export function shareRateLimit(bindingName, retryAfterSeconds) {
	return async (c, next) => {
		const denied = await enforceShareRateLimit(c, c.env[bindingName], retryAfterSeconds);
		if (denied) {
			return denied;
		}
		return next();
	};
}
