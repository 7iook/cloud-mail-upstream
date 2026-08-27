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

function connectingIpKey(rawIp) {
	if (typeof rawIp === 'string') {
		const trimmed = rawIp.trim();
		if (trimmed) {
			return trimmed;
		}
	}
	return MISSING_CONNECTING_IP_KEY;
}

export function readRateLimitKey(c) {
	return connectingIpKey(c.req.header('CF-Connecting-IP'));
}

/**
 * 放行(含两种 fail-open:绑定缺失、平台抛错)= true,该拒 = false。
 * 绑定缺失不打日志:那是部署配置的稳态(vitest 就一直是这个状态),每请求一行 error
 * 只会把真正的平台故障淹掉 —— 只有 limit() 抛错才是需要有人看一眼的事。
 */
async function shareLimiterAllows(limiter, key) {
	if (!limiter || typeof limiter.limit !== 'function') {
		return true;
	}
	try {
		const outcome = await limiter.limit({ key });
		return !(outcome && outcome.success === false);
	} catch (err) {
		const detail = err && err.message ? err.message : String(err);
		console.error('share rate limiter.limit failed', detail);
		return true;
	}
}

export function limitedShareResponse(c, retryAfterSeconds) {
	return c.json(shareResult.fail('RATE_LIMITED', 429), 429, {
		'Retry-After': String(retryAfterSeconds),
		'Cache-Control': 'no-store'
	});
}

export async function enforceShareRateLimit(c, limiter, retryAfterSeconds) {
	if (await shareLimiterAllows(limiter, readRateLimitKey(c))) {
		return null;
	}
	return limitedShareResponse(c, retryAfterSeconds);
}

/**
 * hono 之前的裸 fetch 入口(文档 GET /s/:lid)专用:context 还不存在,key 只能从
 * Request headers 取,拒绝响应也只能是空 body —— 那条路径的成功状态是「与浏览器
 * 原生错误页同貌」,回一个 JSON 信封等于把「这里是分享系统」白送给探测者。
 * 同一个 SHARE_READ_RATE_LIMITER 配额,不另开 namespace。
 */
export async function enforceShareRateLimitOnRequest(req, limiter, retryAfterSeconds) {
	const key = connectingIpKey(req.headers.get('CF-Connecting-IP'));
	if (await shareLimiterAllows(limiter, key)) {
		return null;
	}
	return new Response(null, {
		status: 429,
		headers: {
			'Retry-After': String(retryAfterSeconds),
			'Cache-Control': 'no-store'
		}
	});
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
