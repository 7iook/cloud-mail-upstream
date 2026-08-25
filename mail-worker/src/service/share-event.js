// 分享能力结构化观测的唯一出口。刻意不 import 任何项目模块:
// ① 迁移路径(init.js)要用它,而迁移不该依赖 share 服务 —— 那条依赖会与
//    share-auth-service 已有的反向 import 形成回环;
// ② 事件名与信封形状是告警规则的契约,放在无依赖模块里才不会被业务改动带着漂。

export const SHARE_EVENT = {
	SESSION_DENIED_QUOTA: 'share.session.denied_quota',
	SESSION_DENIED_AUTH: 'share.session.denied_auth',
	SESSION_DENIED_CV: 'share.session.denied_cv',
	BINDING_CASCADE: 'share.binding.cascade',
	MIGRATE_INVALID_ROW: 'share.migrate.invalid_row',
	SYSTEM_ERROR: 'share.system.error'
};

const REQUEST_ID_KEY = 'shareRequestId';

// design.md:451「requestId 取既有请求上下文标识」:边缘已经给每个请求发过一个 id,
// 用它而不是自造,运维才能拿日志里的值直接回到 Cloudflare 侧对齐同一次请求。
const PLATFORM_REQUEST_ID_HEADER = 'cf-ray';

/**
 * 取本次请求的关联标识。同一个 context 上恒返回同一个值 —— 一次请求产生的多条事件
 * 必须落在同一个 requestId 上,否则「按 requestId 串成一条时间线」不成立。
 *
 * 定时清理(scheduled)与邮件入口传的是 `{ env }`,没有请求可关联,返回 null。
 * 这是有意的:信封里键在、值为 null,按字段过滤的告警规则才不会把这类事件整类漏掉。
 */
export function shareRequestId(c) {
	if (!c || typeof c.get !== 'function' || typeof c.set !== 'function') {
		return null;
	}
	const cached = c.get(REQUEST_ID_KEY);
	if (cached) {
		return cached;
	}
	// 本地 wrangler dev 不经边缘,没有 cf-ray。此时自造一个:关联性是本函数的职责,
	// 缺了平台标识就退化成「关联不了」会让本地排障与 e2e 都失去这条时间线。
	const platformId = c.req && typeof c.req.header === 'function'
		? c.req.header(PLATFORM_REQUEST_ID_HEADER)
		: null;
	const requestId = platformId || crypto.randomUUID();
	c.set(REQUEST_ID_KEY, requestId);
	return requestId;
}

/**
 * 一行 JSON,恒带 requestId 与 shareId(R2-F2 请求关联字段约定)。
 *
 * `c` 是必参而不是让调用方自己传 requestId:后者正是 requestId 线上恒为 null 的根因 ——
 * 八个调用点没有一个记得传。信封字段由出口自己填,调用方只能传诊断字段,
 * 禁止传 sec / authKey / token / IP / 邮箱地址等 PII 与凭据。
 */
export function logShareEvent(c, event, fields = {}) {
	const { requestId: _ignoredRequestId, shareId = null, ...rest } = fields;
	// 诊断字段先铺，规范字段后写：调用方传进来的 event / requestId / ts 只能被覆盖，
	// 不能反过来改写信封。
	console.log(JSON.stringify({
		...rest,
		event,
		requestId: shareRequestId(c),
		shareId,
		ts: new Date().toISOString()
	}));
}
