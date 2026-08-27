// P4:销毁链接的文档入口拦截(p4-destroyed-entrypoints.md #1/#2/#10)。
// 「gone」只有两种事实:无 mail_share 行,或 status='REVOKED'。EXPIRED 不是 gone ——
// 过期分享仍交给 assets 出 SPA,由访客页画「不再可用」(AC-VISIT-04 拆分后的过期分支)。
// 放在 security/ 而不是 service/:它跑在 hono 之前的裸 fetch 入口,只读一列、不进业务域,
// 和 share-rate-limit 一样属于「请求还没成为业务请求之前」的那一层。
import { SHARE_EVENT, logShareEvent } from '../service/share-event';
import {
	SHARE_READ_RATE_LIMITER,
	SHARE_READ_RETRY_AFTER_SECONDS,
	enforceShareRateLimitOnRequest
} from './share-rate-limit';

// 恰好一段路径(可带一个尾斜杠)。/s/a/b 这类形状不是分享 URL,交回 assets ——
// 拦截面越窄,fail-open 的敞口越小。
const SHARE_DOC_PATH = /^\/s\/([^/]+)\/?$/i;

export function parseShareLidPath(pathname) {
	const matched = SHARE_DOC_PATH.exec(pathname);
	if (!matched) {
		return '';
	}
	// SPA 路由会把 %61bc 解码成 abc 再去建会话,文档侧不同步解码就会漏拦这种写法。
	try {
		return decodeURIComponent(matched[1]);
	} catch {
		return matched[1];
	}
}

// 空 body:浏览器对「404 + 空响应」渲染的是自己的原生错误页,任何自定义 HTML
// 都会顶掉它 —— 而「销毁后是浏览器原生 404」正是 P4 的成功状态原话。
// no-store:销毁是终态,但一条被中间缓存住的 404 会在 lid 复用(不可能)之外
// 掩盖 fail-open 恢复 —— DB 抖动窗口里发出的 404 不该被缓存进 CDN。
// Referrer-Policy / X-Robots-Tag:lid 就在 URL 里,所以「这一跳不把 URL 交给第三方、
// 不让它进搜索索引」是这条 404 的本职。刻意不加 CSP:body 是空的,没有可被约束的文档 ——
// 浏览器画的是自己的错误页,不受本响应的 CSP 管辖,收益为零,却给一个「要与原生 404 同貌」
// 的响应加上二百多字节的应用指纹。也刻意不加任何「这是被销毁的分享」自述头:零消费方,
// 且它主动广播的正是本模块要藏的那件事。
export function nativeGoneResponse() {
	return new Response(null, {
		status: 404,
		headers: {
			'Cache-Control': 'no-store',
			'Referrer-Policy': 'no-referrer',
			'X-Robots-Tag': 'noindex, nofollow'
		}
	});
}

/**
 * gone → 404 Response;不是分享文档请求 / 活着 / 过期 / DB 抖动 → null(继续走 assets)。
 *
 * fail-open 是硬约束:把活链接误打成原生 404 的代价(访客彻底打不开,且无从排障)
 * 远高于让一条销毁链接多活一次 DB 抖动窗口。异常走既有 `share.system.error` 信封,
 * 与告警规则同一事件名;固定 reason、不带 lid(URL 路径即凭据面,禁止入日志)。
 * 正常 gone 404 不打事件 —— 404 是这条链路的成功态,不是事故。
 */
export async function shareDocumentIfGone(req, env) {
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		return null;
	}
	const lid = parseShareLidPath(new URL(req.url).pathname);
	if (!lid) {
		return null;
	}
	// 限流在 DB 查询之前:这条路径的存在性判定就是一次 D1 查询,放到查询之后等于
	// 「DB 已经挨完打才开始计数」。窄到只算真正的 /s/:lid GET|HEAD —— assets 和别的
	// 路径不该花这份配额。限流器缺失/抛错时 fail-open,可用性优先于限流。
	const denied = await enforceShareRateLimitOnRequest(
		req,
		env[SHARE_READ_RATE_LIMITER],
		SHARE_READ_RETRY_AFTER_SECONDS
	);
	if (denied) {
		return denied;
	}
	try {
		const row = await env.db.prepare('SELECT status FROM mail_share WHERE lid = ?').bind(lid).first();
		if (!row || row.status === 'REVOKED') {
			return nativeGoneResponse();
		}
	} catch (err) {
		// logShareEvent 对无 hono context 的调用方(这里是裸 fetch 入口)约定 requestId=null。
		logShareEvent({ env }, SHARE_EVENT.SYSTEM_ERROR, { reason: 'gone-check-failed' });
	}
	return null;
}
