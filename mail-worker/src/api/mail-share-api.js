import app from '../hono/hono';
import shareResult from '../model/share-result';
import { limitedShareResponse } from '../security/share-rate-limit';
import userContext from '../security/user-context';
import mailShareService from '../service/mail-share-service';

export const SHARE_REVEAL_RATE_LIMITER = 'SHARE_REVEAL_RATE_LIMITER';
export const SHARE_REVEAL_RETRY_AFTER_SECONDS = 60;

/*
 * 凭据暴露面的限流。与访客侧同一套机制(Cloudflare Rate Limiting 绑定 → 429 +
 * Retry-After,绑定缺失时 fail-open),唯一的差别是 key:访客是匿名的,IP 是仅有的
 * 稳定标识;Owner 已经过了 JWT + `share:manage`,主体就是 userId。按 IP 计会同时
 * 出两个错 —— 换个出口 IP 就换来一份新配额,而同一间 NAT 后面的同事共用一份。
 *
 * 所以这里没有复用 `shareRateLimit()`(它的 key 恒为 CF-Connecting-IP),但复用了
 * 它的响应形状与 fail-open 语义:限流回的必须是 429 而不是被 hono onError 改写成
 * 200,`limitedShareResponse` 就是那条保证。
 *
 * 恒在全局鉴权中间件之后运行(路由级中间件在 `app.use('*')` 之后),所以
 * `c.get('user')` 一定在;未鉴权的调用早就 401 了,根本进不到这里消耗配额。
 */
function ownerRevealRateLimit() {
	return async (c, next) => {
		const limiter = c.env[SHARE_REVEAL_RATE_LIMITER];
		if (!limiter || typeof limiter.limit !== 'function') {
			return next();
		}
		let outcome;
		try {
			outcome = await limiter.limit({ key: String(userContext.getUserId(c)) });
		} catch (err) {
			// 限流器自己坏掉不该把功能一起带下去(与 share-rate-limit.js:61-67 同款取舍),
			// 但必须留下痕迹 —— 静默 fail-open 就是一条没人知道的敞口。
			console.error('share reveal limiter.limit failed', err && err.message ? err.message : String(err));
			return next();
		}
		if (outcome && outcome.success === false) {
			return limitedShareResponse(c, SHARE_REVEAL_RETRY_AFTER_SECONDS);
		}
		return next();
	};
}

function shareJson(c, body) {
	return c.json(body, 200, { 'Cache-Control': 'no-store' });
}

function withShare(handler) {
	return async (c) => {
		try {
			return await handler(c);
		} catch (err) {
			if (err && err.name === 'BizError') {
				return shareJson(c, shareResult.fail(err.message, err.code));
			}
			throw err;
		}
	};
}

app.post('/mailShare/create', withShare(async (c) => {
	const body = await c.req.json();
	const idempotencyKey = c.req.header('Idempotency-Key') || '';
	const data = await mailShareService.create(c, { ...body, idempotencyKey }, userContext.getUserId(c));
	return shareJson(c, shareResult.ok(data));
}));

app.get('/mailShare/list', withShare(async (c) => {
	const data = await mailShareService.list(c, c.req.query(), userContext.getUserId(c));
	return shareJson(c, shareResult.ok(data));
}));

app.get('/mailShare/get', withShare(async (c) => {
	const data = await mailShareService.get(c, c.req.query(), userContext.getUserId(c));
	return shareJson(c, shareResult.ok(data));
}));

app.put('/mailShare/update', withShare(async (c) => {
	const body = await c.req.json();
	const data = await mailShareService.update(c, body, userContext.getUserId(c));
	return shareJson(c, shareResult.ok(data));
}));

app.delete('/mailShare/delete', withShare(async (c) => {
	const data = await mailShareService.delete(c, c.req.query(), userContext.getUserId(c));
	return shareJson(c, shareResult.ok(data));
}));

// AuthKey 的唯一写入口(enable / reset / disable),POST 而非 PUT:它每次都铸一把新密钥,
// 不是幂等的字段覆盖。明文只在这一次响应里出现。
app.post('/mailShare/resetAuthKey', withShare(async (c) => {
	const body = await c.req.json();
	const data = await mailShareService.resetAuthKey(c, body, userContext.getUserId(c));
	return shareJson(c, shareResult.ok(data));
}));

// 换链接(AC-LIFE-05)。与 resetAuthKey 同理用 POST 而非 PUT:它每次都铸一把新 sec,
// 不是幂等的字段覆盖 —— 幂等由 `Idempotency-Key` 请求头显式表达(AC-SHARE-13),
// 与 create 同一套头、同一张 `share_idempotency` 表。
app.post('/mailShare/regenerate', withShare(async (c) => {
	const body = await c.req.json();
	const idempotencyKey = c.req.header('Idempotency-Key') || '';
	const data = await mailShareService.regenerate(c, { ...body, idempotencyKey }, userContext.getUserId(c));
	return shareJson(c, shareResult.ok(data));
}));

// 查看链接(ADR-share-credential-recoverability 轨一)。POST 而非 GET:它是一次凭据
// 暴露动作,不该被浏览器 / 代理 / 历史记录当成可缓存可预取的读 —— `shareId` 落进
// URL 就等于把「哪条分享被看过」写进了一堆本不该知道的地方。
app.post('/mailShare/revealSec', ownerRevealRateLimit(), withShare(async (c) => {
	const body = await c.req.json();
	const data = await mailShareService.revealSec(c, body, userContext.getUserId(c));
	return shareJson(c, shareResult.ok(data));
}));

app.put('/mailShare/bindings', withShare(async (c) => {
	const body = await c.req.json();
	const data = await mailShareService.updateBindings(c, body, userContext.getUserId(c));
	return shareJson(c, shareResult.ok(data));
}));

app.delete('/mailShare/revoke', withShare(async (c) => {
	const data = await mailShareService.revoke(c, c.req.query(), userContext.getUserId(c));
	return shareJson(c, shareResult.ok(data));
}));
