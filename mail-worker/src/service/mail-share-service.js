import { isDel } from '../const/entity-const';
import BizError from '../error/biz-error';
import { SEC_CIPHER_FAILURE, decryptShareSec, encryptShareSec, probeKek } from '../security/share-sec-cipher';
import { toUtc } from '../utils/date-uitil';
import { SHARE_EVENT, logShareEvent } from './share-event';
import shareAuthService from './share-auth-service';

const CREATE_OP = 'create';
// `share_idempotency` 的唯一键含 `operation`,所以两个写入口可以共用同一把 Idempotency-Key
// 而互不重放 —— 前端对一次「新建 + 立刻换链接」用同一个请求 id 是完全合理的。
const REGENERATE_OP = 'regenerate';
const IDEMPOTENCY_TTL_HOURS = 24;
const DEFAULT_RETENTION_SECONDS = 604800;
const UNBOUNDED_ACTIVE_LIMIT = 1000000000;
// I-2 兜底上限 90 天。前端 `share-admin/presets.js:77` 的 `MAX_DURATION_DAYS = 90` 是它的镜像,
// 权威在这里;两处不一致时以本常量为准(前端过得去、后端拒,而不是反过来)。
const MAX_DURATION_FALLBACK_SECONDS = 7776000;
// AC-CAP-06 / Decision 13:写入侧拒绝小于这个值,下发侧的钳制归 T-08。
const MIN_REFRESH_INTERVAL_MS = 3000;
const encoder = new TextEncoder();

// R3-A5 / AC-CAP-13:每分享 Binding 数量硬上限,create 与 bindings 两个写入口共用。
export const SHARE_BINDING_LIMIT = 50;

// R1-F2 的 list 分页口径:`size` 默认 20 / 上限 100;真正无参调用是兼容期的 deprecated
// 全量转储,不套默认分页(前端 `request/mail-share.js:34` 至今不带参数),只压一条硬上限。
// 带 `status?` 的筛选不是无参,走默认 page=1/size=20。
const LIST_DEFAULT_SIZE = 20;
const LIST_MAX_SIZE = 100;
const LIST_DEPRECATED_CAP = 500;

// AC-LIFE-01:落库只有 ACTIVE/REVOKED,四态是实时算的。筛选因此不能直接比 status 列,
// 必须在 SQL 里重算同一条优先级链,而且 `total` 与结果集要用同一份 CASE ——
// 用「先取页再在内存里筛」会让 total 与筛选结果对不上。
const OWNER_STATUSES = ['ACTIVE', 'EXPIRED', 'REVOKED', 'ACCESS_LIMIT_REACHED'];

// AC-LIFE-11:滚动发布窗口内旧 Worker 无法执行的策略写入。message_limit 与前四条同构 ——
// 旧 Worker 不认识该列,落库即「可见集被放宽到窗口内全部邮件」。
export const SHARE_V2_INTENT = {
	MULTI_CREATE: 'multi_create',
	BINDING_EXPAND: 'binding_expand',
	AUTH_KEY_ENABLE: 'auth_key_enable',
	FINITE_MAX_SESSIONS: 'finite_max_sessions',
	MESSAGE_LIMIT: 'message_limit'
};

// design.md「结构化观测」固定事件名清单,拒绝/异常路径共用。
// 恒 UTC。落库的 create_time / expires_at / delete_at 都是不带时区标记的裸串，
// 前端(访客页倒计时、管理台失效时间)一律按 UTC 解析，所以写入方不能跟随进程时区 ——
// 否则同一份代码在 Cloudflare(恒 UTC)与本地开发(UTC+8)会写出相差 8 小时的行。
function nowText() {
	return toUtc().format('YYYY-MM-DD HH:mm:ss');
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

function isCapabilityV2Enabled(c) {
	const flag = c.env && c.env.SHARE_CAPABILITY_V2;
	return flag === '1' || flag === 1 || flag === true || flag === 'true';
}

// AC-LIFE-11 全能力发布栅栏。开关缺省即 false:兼容窗口内旧 Worker 不认识 AuthKey /
// credentials_version / 配额条件,任何这类策略一旦落库,随机路由到旧 Worker 的请求就是
// 一条策略降级入口,所以拦在写入侧而不是读取侧。
// `intent` 取 SHARE_V2_INTENT 之一,标记是哪一条受限写入路径;判定与 intent 无关,
// 它只为调用点自述与后续排障保留(create 侧已接线,bindings/update 见 T-13/T-15/T-16)。
// 抛 `SHARE_CAPABILITY_NOT_ENABLED` 而不是 `SHARE_INVALID_CONFIG`:后者还承载「状态不匹配」
// 与「配置越域」两种永久领域错误,而栅栏只是暂时的发布态。三者共用一个码时管理台只能靠
// 语句顺序猜,把「平台还没开这项能力」显示成「你的配置写错了」,指向完全错误的自助动作。
export function assertCapabilityV2(c, intent) {
	if (isCapabilityV2Enabled(c)) {
		return;
	}
	throw new BizError('SHARE_CAPABILITY_NOT_ENABLED');
}

function randomToken(byteLength) {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function publicOrigin(c) {
	const fromEnv = c.env && c.env.SHARE_PUBLIC_ORIGIN;
	if (fromEnv) {
		return String(fromEnv).replace(/\/$/, '');
	}
	if (c.req && c.req.url) {
		try {
			return new URL(c.req.url).origin;
		} catch (err) {
			console.error('share create origin parse failed', { name: err && err.name });
		}
	}
	return '';
}

function isRowId(value) {
	return Number.isSafeInteger(value) && value > 0;
}

// 布尔要显式挡掉:`Number(true) === 1` 会把 `shareId: true` 变成一次对 share_id=1 的
// 越权探测。不合法一律折成 0,调用方按「不存在」处理(不新增可区分错误码)。
function toShareId(value) {
	const id = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
	return isRowId(id) ? id : 0;
}

function hasKey(params, key) {
	return params != null && Object.prototype.hasOwnProperty.call(params, key);
}

function hasValue(params, key) {
	return hasKey(params, key) && params[key] != null && params[key] !== '';
}

// AC-CAP-06:值域封在归一化边界,不是转换之后。`assertCreateBody` 只看得见转换后的数值,
// 一旦 `'invalid'` / `2` / `{}` 在这里被折成 1,静默打开 AuthKey、关掉地址掩码就再也认不出来了。
// 空串按「没传」处理:前端表单空值与缺省同义,当 falsy 会把 only_messages_after_created 打成 0。
const FLAG_TOKENS = new Map([
	[true, 1], [1, 1], ['1', 1], ['true', 1],
	[false, 0], [0, 0], ['0', 0], ['false', 0]
]);

function toFlag(value, fallback) {
	if (value == null || value === '') {
		return fallback;
	}
	const flag = FLAG_TOKENS.get(value);
	if (flag === undefined) {
		throw new BizError('SHARE_INVALID_CONFIG');
	}
	return flag;
}

// 布尔要显式挡掉:`Number(true) === 1` 会让 `true` 变成一条合法配额。下界 `< 1` 归 assertCreateBody。
function toNullableCount(value) {
	if (value == null || value === '') {
		return null;
	}
	const count = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
	if (!Number.isSafeInteger(count)) {
		throw new BizError('SHARE_INVALID_CONFIG');
	}
	return count;
}

// 去重 + 升序是三处口径的共同前提 —— 表级 UNIQUE(share_id, account_id) 只收一条,
// 栅栏计数、上限计数与指纹必须同口径;升序还让 ids[0] 恒等于 ORDER BY 写入的主 Binding
// (binding_id 最小)。单值与数组同收,`null`/缺省即空集。
function toIdSet(value) {
	const raw = value == null ? [] : (Array.isArray(value) ? value : [value]);
	const seen = new Set();
	const ids = [];
	for (const item of raw) {
		const id = Number(item);
		if (seen.has(id)) {
			continue;
		}
		seen.add(id);
		ids.push(id);
	}
	return ids.sort((left, right) => left - right);
}

// AC-CAP-09/10:`accountIds` 优先,缺失才回落旧 `accountId` 单值。
function toAccountIdSet(params) {
	return toIdSet(params && params.accountIds != null ? params.accountIds : (params && params.accountId));
}

// 字段顺序是指纹的一部分:JSON.stringify 按插入顺序序列化,所以这里必须一次性构造整个字面量,
// 不能 `{...defaults, ...params}` —— 后者的键顺序随调用方传了哪些字段而变,同一语义两个指纹。
// 默认值逐个对齐 init.js v3_2DB 的 DDL DEFAULT(max_sessions / message_limit 无 DEFAULT 即 NULL)。
function normalizeCreateBody(params) {
	return {
		accountIds: toAccountIdSet(params),
		durationSeconds: Number(params && params.durationSeconds),
		name: params && params.name == null ? '' : String(params.name),
		remark: params && params.remark == null ? '' : String(params.remark),
		maxSessions: toNullableCount(params && params.maxSessions),
		messageLimit: toNullableCount(params && params.messageLimit),
		onlyMessagesAfterCreated: toFlag(params && params.onlyMessagesAfterCreated, 1),
		otpExtractionEnabled: toFlag(params && params.otpExtractionEnabled, 1),
		autoRefresh: toFlag(params && params.autoRefresh, 1),
		refreshIntervalMs: params && params.refreshIntervalMs != null
			? Number(params.refreshIntervalMs)
			: MIN_REFRESH_INTERVAL_MS,
		showFullAddress: toFlag(params && params.showFullAddress, 0),
		authKeyEnabled: toFlag(params && params.authKeyEnabled, 0)
	};
}

async function sha256Hex(text) {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function requestFingerprint(body) {
	return sha256Hex(JSON.stringify(body));
}

// AC-LIFE-10 滚动发布:旧 Worker(基线 `5a81065`)的指纹只含 accountId/durationSeconds/name/remark。
// 「兼容载荷」= 单邮箱且全部新字段停在 DDL 默认值 —— 这类请求旧/新 Worker 建出的行逐列相同,
// 所以两边必须算出同一个指纹。字段顺序照抄旧 `normalizeCreateBody`,它也是指纹的一部分。
// 非兼容载荷(multi / AuthKey / 有限配额 / 非默认 flag)返回 null:旧 Worker 根本执行不了这些策略,
// 让它重放出来比 CONFLICT 更糟。
function legacyCompatibleBody(body) {
	if (body.accountIds.length !== 1
		|| body.maxSessions != null
		|| body.messageLimit != null
		|| body.onlyMessagesAfterCreated !== 1
		|| body.otpExtractionEnabled !== 1
		|| body.autoRefresh !== 1
		|| body.refreshIntervalMs !== MIN_REFRESH_INTERVAL_MS
		|| body.showFullAddress !== 0
		|| body.authKeyEnabled !== 0) {
		return null;
	}
	return {
		accountId: body.accountIds[0],
		durationSeconds: body.durationSeconds,
		name: body.name,
		remark: body.remark
	};
}

// `stored` 是要落库的那一个:兼容载荷落旧 hash,旧 Worker 才能重放新 Worker 建出的分享。
// `accepted` 是重放时认的集合:同时收新 12 字段 hash,兼容窗口两侧写下的存量行都能命中。
// 兼容载荷的四字段唯一决定整个 body,所以两个 hash 是一一对应,多认一个不会误重放另一个请求。
async function createFingerprints(body) {
	const modern = await requestFingerprint(body);
	const legacy = legacyCompatibleBody(body);
	if (!legacy) {
		return { stored: modern, accepted: [modern] };
	}
	const legacyHash = await requestFingerprint(legacy);
	return { stored: legacyHash, accepted: [modern, legacyHash] };
}

function activeLimit(c) {
	const limit = Number(c.env && c.env.SHARE_ACTIVE_LIMIT);
	if (Number.isFinite(limit) && limit > 0) {
		return Math.floor(limit);
	}
	return UNBOUNDED_ACTIVE_LIMIT;
}

// 不变量 I-2:任何部署下都存在有效期上限。`SHARE_MAX_DURATION_SECONDS` 是可选变量,
// 生产 `wrangler.toml` 从来没写过它 —— 缺失时返回 null(= 跳过校验)等于把「运维忘了配」
// 这个最常见的部署形态直接变成「不设防」,而这正是当前生产的真实状态。
// 兜底不是默认值:配了就以配置为准(可宽可严),没配也绝不退化为无上限。
// 非数字 / 0 / 负数与「没配」同义 —— 它们不是解除上限的暗门。
function maxDurationSeconds(c) {
	const max = Number(c.env && c.env.SHARE_MAX_DURATION_SECONDS);
	if (Number.isFinite(max) && max > 0) {
		return Math.floor(max);
	}
	return MAX_DURATION_FALLBACK_SECONDS;
}

function retentionSeconds(c) {
	const retention = Number(c.env && c.env.SHARE_RETENTION_SECONDS);
	if (Number.isFinite(retention) && retention > 0) {
		return Math.floor(retention);
	}
	return DEFAULT_RETENTION_SECONDS;
}

function idempotencyCutoff() {
	return toUtc().subtract(IDEMPOTENCY_TTL_HOURS, 'hour').format('YYYY-MM-DD HH:mm:ss');
}

function isUniqueConflict(err) {
	return /UNIQUE constraint failed/i.test(String(err && err.message || err));
}

function placeholders(list) {
	return list.map(() => '?').join(', ');
}

// P0-1:预读到的 Binding 集合就是本次命令的乐观锁。写入侧统一用这一对谓词表达
// 「集合恰好还是快照那一份」—— 没有快照之外的行 + 行数相等 ⇒ 集合相等(binding_id 全局唯一)。
// `allowedAccounts` 让同批在前的 INSERT 落下的新行不算「集合外」。
// id 列表走 `json_each(?)` 而不是展开成第二组 IN:D1 每条语句最多 100 个绑定参数
// (https://developers.cloudflare.com/d1/platform/limits/),而 SHARE_BINDING_LIMIT=50
// 是契约允许的合法上界 —— 每个集合最多展开一次占位符是这条路径上的硬预算。
function snapshotPredicate(shareRef, allowedAccounts) {
	const accountEscape = allowedAccounts
		? `AND snap.account_id NOT IN (SELECT value FROM json_each(?))`
		: '';
	return `NOT EXISTS (
				SELECT 1 FROM mail_share_binding snap
				WHERE snap.share_id = ${shareRef}
					AND snap.binding_id NOT IN (SELECT value FROM json_each(?))
					${accountEscape}
			)
			AND (SELECT COUNT(*) FROM mail_share_binding snap WHERE snap.share_id = ${shareRef}) = ?`;
}

async function countOwnedAccounts(c, accountIds, userId) {
	const row = await c.env.db.prepare(`
		SELECT COUNT(*) AS owned FROM account
		WHERE account_id IN (${placeholders(accountIds)}) AND user_id = ? AND is_del = ${isDel.NORMAL}
	`).bind(...accountIds, userId).first();
	return row.owned;
}

// TOCTOU 预检,不是防线 —— 防线是写入语句里的同款归属计数谓词。这一步只为让
// SHARE_ACCOUNT_FORBIDDEN 与 SHARE_LIMIT_EXCEEDED 在 changes=0 时仍可区分。
async function assertOwnedAccounts(c, accountIds, userId) {
	if (await countOwnedAccounts(c, accountIds, userId) !== accountIds.length) {
		throw new BizError('SHARE_ACCOUNT_FORBIDDEN');
	}
}

// 顺序即语义:域校验 → 上限 → 栅栏。上限排在栅栏前,51 个 accountId 在 V2=false 下也返回
// SHARE_BINDING_LIMIT_EXCEEDED —— 「51 > 50」是永久领域错误,栅栏只是暂时的发布态。
function assertCreateBody(c, body) {
	if (!body.accountIds.length || !body.accountIds.every(isRowId)) {
		throw new BizError('SHARE_ACCOUNT_FORBIDDEN');
	}
	if (!Number.isFinite(body.durationSeconds) || body.durationSeconds <= 0
		|| body.durationSeconds > maxDurationSeconds(c)) {
		throw new BizError('SHARE_DURATION_EXCEEDED');
	}
	if (body.accountIds.length > SHARE_BINDING_LIMIT) {
		throw new BizError('SHARE_BINDING_LIMIT_EXCEEDED');
	}
	if (!Number.isSafeInteger(body.refreshIntervalMs) || body.refreshIntervalMs < MIN_REFRESH_INTERVAL_MS) {
		throw new BizError('SHARE_INVALID_CONFIG');
	}
	if (body.messageLimit != null && (!Number.isSafeInteger(body.messageLimit) || body.messageLimit < 1)) {
		throw new BizError('SHARE_INVALID_CONFIG');
	}
	if (body.maxSessions != null && (!Number.isSafeInteger(body.maxSessions) || body.maxSessions < 1)) {
		throw new BizError('SHARE_INVALID_CONFIG');
	}
	if (body.accountIds.length > 1) {
		assertCapabilityV2(c, SHARE_V2_INTENT.MULTI_CREATE);
	}
	if (body.authKeyEnabled) {
		assertCapabilityV2(c, SHARE_V2_INTENT.AUTH_KEY_ENABLE);
	}
	if (body.maxSessions != null) {
		assertCapabilityV2(c, SHARE_V2_INTENT.FINITE_MAX_SESSIONS);
	}
	if (body.messageLimit != null) {
		assertCapabilityV2(c, SHARE_V2_INTENT.MESSAGE_LIMIT);
	}
}

// Owner 面唯一的列清单。凭据物料(`sec_hmac` / `pepper_kid` / `auth_key_hash` /
// `auth_key_kid` / `sec_cipher` / `kek_kid`)与 `credentials_version` 一律不进 SELECT ——
// 取不到就漏不掉。`sec_cipher` 尤其如此:它是可逆的,一旦跟着列表投影漏出去,
// 「明文恰一次」就退化成「每次列表都发一遍链接」。取回明文是解密端点的单独授权路径。
const OWNER_ROW_COLUMNS = `
	ms.share_id, ms.lid, ms.user_id, ms.account_id, ms.name, ms.remark, ms.status,
	ms.window_start_email_id, ms.create_time, ms.expires_at, ms.delete_at,
	ms.access_count, ms.last_access_at, ms.revoked_at,
	ms.max_sessions, ms.message_limit, ms.only_messages_after_created,
	ms.otp_extraction_enabled, ms.auto_refresh, ms.refresh_interval_ms,
	ms.show_full_address, ms.auth_key_enabled
`;

// `share-auth-service.effectiveStatus` 的 SQL 孪生:同一条优先级链
// REVOKED > EXPIRED > ACCESS_LIMIT_REACHED > ACTIVE,`expires_at` 与 `now` 同为
// `YYYY-MM-DD HH:mm:ss`,字典序比较与 JS 侧逐字一致。唯一的绑定参数是 now。
const OWNER_STATUS_CASE = `CASE
	WHEN ms.status = 'REVOKED' THEN 'REVOKED'
	WHEN ms.expires_at <= ? THEN 'EXPIRED'
	WHEN ms.max_sessions IS NOT NULL AND ms.access_count >= ms.max_sessions THEN 'ACCESS_LIMIT_REACHED'
	ELSE 'ACTIVE'
END`;

function toOwnerRow(row) {
	return {
		shareId: row.share_id,
		lid: row.lid,
		userId: row.user_id,
		accountId: row.account_id,
		name: row.name,
		remark: row.remark,
		status: row.status,
		windowStartEmailId: row.window_start_email_id,
		createTime: row.create_time,
		expiresAt: row.expires_at,
		deleteAt: row.delete_at,
		accessCount: row.access_count,
		lastAccessAt: row.last_access_at,
		revokedAt: row.revoked_at,
		maxSessions: row.max_sessions,
		messageLimit: row.message_limit,
		onlyMessagesAfterCreated: row.only_messages_after_created,
		otpExtractionEnabled: row.otp_extraction_enabled,
		autoRefresh: row.auto_refresh,
		refreshIntervalMs: row.refresh_interval_ms,
		authKeyEnabled: row.auth_key_enabled,
		showFullAddress: row.show_full_address
	};
}

function toBoolean(value) {
	return value === 1 || value === '1' || value === true;
}

// 列表行与详情共用一套字段名(详情 = 列表行 + bindings 明细),两处分叉出两套键名
// 是前端最容易踩的坑。`maxSessions` 必须在这里出现:`effectiveStatus` 拿不到它时
// ACCESS_LIMIT_REACHED 那条分支恒不可达,AC-ADMIN-04/09 会假绿。
function projectOwnerRow(row, mailbox, now, bindings = []) {
	return {
		shareId: row.shareId,
		lid: row.lid,
		userId: row.userId,
		accountId: row.accountId,
		mailbox: mailbox || '',
		name: row.name,
		remark: row.remark,
		status: row.status,
		effectiveStatus: shareAuthService.effectiveStatus(row, now),
		shareType: shareTypeOf(bindings),
		windowStartEmailId: row.windowStartEmailId,
		createTime: row.createTime,
		expiresAt: row.expiresAt,
		deleteAt: row.deleteAt,
		// D4/R1-A1:物理列名 `access_count` 不改,`usedSessions` 是新增的 DTO 别名。
		// 两个键并存,删掉 `accessCount` 会打红三条 list 基线断言。
		accessCount: row.accessCount,
		usedSessions: row.accessCount,
		maxSessions: row.maxSessions == null ? null : row.maxSessions,
		messageLimit: row.messageLimit == null ? null : row.messageLimit,
		onlyMessagesAfterCreated: toBoolean(row.onlyMessagesAfterCreated),
		otpExtractionEnabled: toBoolean(row.otpExtractionEnabled),
		autoRefresh: toBoolean(row.autoRefresh),
		refreshIntervalMs: row.refreshIntervalMs,
		showFullAddress: toBoolean(row.showFullAddress),
		authKeyEnabled: toBoolean(row.authKeyEnabled),
		lastAccessAt: row.lastAccessAt,
		revokedAt: row.revokedAt,
		bindings
	};
}

// 撤销谓词的唯一真源:revoke / 级联 / T-13 删空转撤销共用。返回未执行的语句,
// 让「删空即撤销」能与同一批的 DELETE 一起提交(AC-BIND-04)。
function prepareRevoke(c, whereSql, binds) {
	return c.env.db.prepare(`
		UPDATE mail_share
		SET status = 'REVOKED', revoked_at = ?
		WHERE ${whereSql} AND status = 'ACTIVE'
		RETURNING share_id
	`).bind(nowText(), ...binds);
}

async function applyRevoke(c, whereSql, binds) {
	return prepareRevoke(c, whereSql, binds).all();
}

// AC-CAP-02:shareType 由现存 Binding 计数实时派生,不落库(落列即双真源)。
function shareTypeOf(bindings) {
	return bindings.length > 1 ? 'multi' : 'single';
}

async function loadBindings(c, shareId) {
	const rows = await c.env.db.prepare(`
		SELECT binding_id, account_id FROM mail_share_binding
		WHERE share_id = ? ORDER BY binding_id ASC
	`).bind(shareId).all();
	return (rows.results || []).map((row) => ({ bindingId: row.binding_id, accountId: row.account_id }));
}

// Owner 面的 Binding 摘要,按 share 分组。两条硬约束决定了这个形状:
// ① 摘要绝不能 JOIN 进 list 主查询 —— LIMIT/OFFSET 会作用在展开后的行上,
//    一个 5 邮箱的分享就吃掉 5 个名额;
// ② shareId 列表走 `json_each(?)` 而不是展开 `IN (?,?,…)` —— size 上限恰是 100,
//    而 D1 每条语句最多 100 个绑定参数,展开即越界。
async function loadBindingSummaries(c, shareIds) {
	const grouped = new Map();
	if (!shareIds.length) {
		return grouped;
	}
	const rows = await c.env.db.prepare(`
		SELECT b.share_id, b.binding_id, b.account_id, a.email AS mailbox
		FROM mail_share_binding b
		LEFT JOIN account a ON a.account_id = b.account_id
		WHERE b.share_id IN (SELECT value FROM json_each(?))
		ORDER BY b.share_id ASC, b.binding_id ASC
	`).bind(JSON.stringify(shareIds)).all();
	for (const row of rows.results || []) {
		const list = grouped.get(row.share_id) || [];
		list.push({ bindingId: row.binding_id, accountId: row.account_id, mailbox: row.mailbox || '' });
		grouped.set(row.share_id, list);
	}
	return grouped;
}

// get / update 的读出口。谓词只有 `share_id + user_id`:AC-ADMIN-09 要求 EXPIRED /
// REVOKED / ACCESS_LIMIT_REACHED 行仍可读可审计,套上 `loadMutableShare` 的 ACTIVE
// 谓词会直接把审计面砍掉。他人 shareId 与不存在共用 `SHARE_NOT_FOUND`。
async function loadOwnerDetail(c, shareId, userId) {
	const row = shareId ? await c.env.db.prepare(`
		SELECT ${OWNER_ROW_COLUMNS}, a.email AS mailbox
		FROM mail_share ms
		LEFT JOIN account a ON a.account_id = ms.account_id
		WHERE ms.share_id = ? AND ms.user_id = ?
	`).bind(shareId, userId).first() : null;
	if (!row) {
		throw new BizError('SHARE_NOT_FOUND');
	}
	const bindings = (await loadBindingSummaries(c, [shareId])).get(shareId) || [];
	return projectOwnerRow(toOwnerRow(row), row.mailbox, nowText(), bindings);
}

// 访客链接的唯一拼装点。create / regenerate / revealSec 三处共用:三条路径发出去的
// 必须是同一个字符串,`revealSec` 交回的链接与当初创建响应逐字不等就是一条坏链接,
// 而管理员没有任何办法看出来。
function shareUrlOf(c, lid, sec) {
	return `${publicOrigin(c)}/s/${lid}#${sec}`;
}

function firstCreateResponse(c, row, sec, authKey, bindings) {
	const response = {
		shareId: row.share_id,
		lid: row.lid,
		sec,
		expiresAt: row.expires_at,
		shareUrl: shareUrlOf(c, row.lid, sec),
		shareType: shareTypeOf(bindings),
		bindings
	};
	if (authKey) {
		response.authKey = authKey;
	}
	return response;
}

// `operation` 必须显式传:它是唯一键的一部分,写死 CREATE_OP 会让 regenerate 去读
// create 的幂等行,把「同一把 Key 的两次不同操作」误判成冲突或误重放。
async function readIdempotency(c, userId, idempotencyKey, operation) {
	return c.env.db.prepare(`
		SELECT id, request_fingerprint, share_id, response_fingerprint, created_at
		FROM share_idempotency
		WHERE user_id = ? AND idempotency_key = ? AND operation = ?
	`).bind(userId, idempotencyKey, operation).first();
}

// AC-CAP-14:重放补齐 shareType/bindings,但 sec 与 AuthKey 明文一个字符都不给。
// Binding 计数用 LEFT JOIN 顺带取回,不比原来多一次往返。
async function replayFromIdempotency(c, row) {
	const found = await c.env.db.prepare(`
		SELECT ms.share_id, ms.lid, ms.expires_at, b.binding_id, b.account_id
		FROM mail_share ms
		LEFT JOIN mail_share_binding b ON b.share_id = ms.share_id
		WHERE ms.share_id = ?
		ORDER BY b.binding_id ASC
	`).bind(row.share_id).all();
	const rows = found.results || [];
	if (!rows.length) {
		throw new BizError('SHARE_NOT_FOUND');
	}
	const bindings = rows
		.filter((item) => item.binding_id != null)
		.map((item) => ({ bindingId: item.binding_id, accountId: item.account_id }));
	return {
		shareId: rows[0].share_id,
		lid: rows[0].lid,
		expiresAt: rows[0].expires_at,
		shareType: shareTypeOf(bindings),
		bindings,
		idempotentReplay: true
	};
}

async function replayOrConflict(c, userId, idempotencyKey, accepted, cutoff, operation) {
	const existing = await readIdempotency(c, userId, idempotencyKey, operation);
	if (!existing || existing.created_at < cutoff) {
		return null;
	}
	if (!accepted.includes(existing.request_fingerprint)) {
		throw new BizError('SHARE_IDEMPOTENCY_CONFLICT');
	}
	return replayFromIdempotency(c, existing);
}

// 主表 `account_id` 与 `window_start_email_id` 都写 accountIds[0] 的口径 —— 升序去重后的首个
// 恰是 Binding INSERT 按 `ORDER BY a.account_id` 落下的主 Binding。account_id 是 NOT NULL 且
// AC-LIFE-10 禁止写 0,所以必须给 >0 初值,不能留空等 sync。
// 限额谓词之外再挂一条归属计数谓词:与 account 删除并发时整个 batch 零变更,AC-CAP-03 的
// 「零残留」就落在这里(D1 没有 BEGIN,batch 提交后没有回头路)。
function prepareShareInsert(c, values) {
	return c.env.db.prepare(`
		INSERT INTO mail_share (
			lid, sec_hmac, pepper_kid, user_id, account_id, name, remark, status,
			window_start_email_id, expires_at, delete_at, create_time,
			max_sessions, message_limit, only_messages_after_created, otp_extraction_enabled,
			auto_refresh, refresh_interval_ms, show_full_address,
			auth_key_enabled, auth_key_hash, auth_key_kid,
			sec_cipher, kek_kid
		)
		SELECT
			?, ?, ?, ?, ?, ?, ?, 'ACTIVE',
			CASE WHEN ? = 1
				THEN (SELECT COALESCE(MAX(email_id), 0) FROM email WHERE account_id = ?)
				ELSE 0 END,
			?, ?, ?,
			?, ?, ?, ?,
			?, ?, ?,
			?, ?, ?,
			?, ?
		WHERE (
			SELECT COUNT(*) FROM mail_share
			WHERE user_id = ? AND status = 'ACTIVE' AND expires_at > ?
		) < ?
		AND (
			SELECT COUNT(*) FROM account
			WHERE account_id IN (${placeholders(values.accountIds)}) AND user_id = ? AND is_del = ${isDel.NORMAL}
		) = ?
		RETURNING share_id, lid, window_start_email_id, expires_at, delete_at, create_time
	`).bind(
		values.lid,
		values.secHmac,
		values.pepperKid,
		values.userId,
		values.accountIds[0],
		values.name,
		values.remark,
		values.onlyMessagesAfterCreated,
		values.accountIds[0],
		values.expiresAt,
		values.deleteAt,
		values.createdAt,
		values.maxSessions,
		values.messageLimit,
		values.onlyMessagesAfterCreated,
		values.otpExtractionEnabled,
		values.autoRefresh,
		values.refreshIntervalMs,
		values.showFullAddress,
		values.authKeyEnabled,
		values.authKeyHash,
		values.authKeyKid,
		// 轨一:密文与主行同一条 INSERT。拆成「先插行、再补密文」就会留下一条
		// 看起来正常、实际永远取不回链接的分享 —— D1 没有 BEGIN,补不上就补不上了。
		values.secCipher,
		values.kekKid,
		values.userId,
		values.now,
		values.limit,
		...values.accountIds,
		values.userId,
		values.accountIds.length
	);
}

// 一条语句同时满足三条 AC:AC-CAP-07(per-binding 原子快照)、AC-CAP-08(false 写 0)、
// AC-BIND-10(条件 INSERT,account 存活且归属)。share 未插入 → `ms.lid = ?` 零行 →
// binding 零行,不需要额外守卫。`ORDER BY account_id` 让 AUTOINCREMENT 的 binding_id
// 顺序等于 accountIds 的升序,主 Binding 与主表初值因此恒等。
// 「全有或全无」由 `COUNT(*) OVER () AS matched = ?` 表达:只要有一个 account 在预检之后被
// 删掉,匹配行数就对不上,整条语句零行而不是插一半 —— D1 的 batch 只在语句报错时回滚,
// 插一半不报错,会就地提交。窗口计数复用 JOIN 已经展开的那一组占位符,不再为归属计数展开
// 第二组 IN(N=48 时 2N+5 就撞上 D1 的 100 个绑定参数,合法上界反而不可达)。
// 窗口函数强制内层先物化,所以快照谓词恒在任何一行落库之前求值。create 传空快照
// (`'[]'` / 0)—— 同批新建的 share 此刻本就没有 Binding,两个写入口因此共用同一段 SQL 文本。
function prepareBindingInsert(c, values) {
	return c.env.db.prepare(`
		INSERT INTO mail_share_binding (share_id, account_id, window_start_email_id)
		SELECT share_id, account_id, window_start_email_id FROM (
			SELECT ms.share_id AS share_id, a.account_id AS account_id,
				CASE WHEN ? = 1
					THEN (SELECT COALESCE(MAX(e.email_id), 0) FROM email e WHERE e.account_id = a.account_id)
					ELSE 0 END AS window_start_email_id,
				COUNT(*) OVER () AS matched
			FROM mail_share ms
			JOIN account a ON a.account_id IN (${placeholders(values.accountIds)})
				AND a.user_id = ? AND a.is_del = ${isDel.NORMAL}
			WHERE ms.lid = ?
			AND ${snapshotPredicate('ms.share_id', false)}
		)
		WHERE matched = ?
		ORDER BY account_id ASC
	`).bind(
		values.onlyMessagesAfterCreated,
		...values.accountIds,
		values.userId,
		values.lid,
		values.snapshotIds,
		values.snapshotCount,
		values.accountIds.length
	);
}

// AC-BIND-12 的三重资源谓词:binding_id + share_id + owner(经 mail_share 回查 user_id)。
// 再挂同款快照谓词,期望行数取「快照 + 同批 add」——它同时顶掉了原来那条独立的 add 守卫:
// 0 行 INSERT 不报错也就不触发回滚,行数对不上时 DELETE 自己必须零行,否则会单独提交成
// 半单变更。快照谓词按 DELETE 之前的状态求值一次(SQLite 先收集 rowid 再删),
// 所以一条命令删多个 Binding 不会从第二行起自我否定。
function prepareBindingDelete(c, values) {
	return c.env.db.prepare(`
		DELETE FROM mail_share_binding
		WHERE binding_id IN (${placeholders(values.bindingIds)})
			AND share_id = ?
			AND EXISTS (
				SELECT 1 FROM mail_share ms
				WHERE ms.share_id = mail_share_binding.share_id AND ms.user_id = ?
			)
			AND ${snapshotPredicate('mail_share_binding.share_id', true)}
	`).bind(
		...values.bindingIds,
		values.shareId,
		values.userId,
		values.snapshotIds,
		JSON.stringify(values.addAccountIds),
		values.snapshotCount + values.addAccountIds.length
	);
}

// P0-1 的乐观锁本体,恒为 batch 的第一条语句:D1 的 batch 是一个事务,CAS 命中之后
// 集合在批内就不会再动。同列自赋值 —— 这条语句只回答「预读快照还成立吗」,不碰
// credentials_version / access_count / account_id / window_start_email_id 这些有语义的列。
// changes=0 即本次命令输掉了竞争;写入语句各自带同款谓词,所以输的一方零残留。
function prepareBindingCas(c, values) {
	return c.env.db.prepare(`
		UPDATE mail_share SET remark = remark
		WHERE share_id = ? AND user_id = ? AND status = 'ACTIVE'
			AND ${snapshotPredicate('mail_share.share_id', false)}
	`).bind(values.shareId, values.userId, values.snapshotIds, values.snapshotCount);
}

// Expand 阶段双写(design.md「迁移/发布协议」步骤 1 / AC-LIFE-10 + R2):主表 `account_id` 与
// `window_start_email_id` 一并跟随主 Binding(binding_id 最小)—— 兼容窗口内的旧 Worker 仍在读
// 主表这两列,不双写 window 下界就退化成 0,`only_messages_after_created=true` 的分享会放出
// 创建之前的历史邮件。返回未执行的语句,供 create/T-13/T-18 放进同一个 `c.env.db.batch()`。
// `target` 收 shareId,或收 `{ lid }` —— create 组装本语句时 share_id 尚由同批 INSERT 决定。
// WHERE 的 EXISTS 使无可用 Binding 时零变更:主表列宁可停在旧值让旧 Worker 读旧语义,
// 也绝不写 0(旧 Worker 见 0 即链接不可用)。
export function syncPrimaryAccountId(c, target) {
	const byLid = target != null && typeof target === 'object';
	const locator = byLid ? '(SELECT share_id FROM mail_share WHERE lid = ?)' : '?';
	return c.env.db.prepare(`
		UPDATE mail_share
		SET account_id = (
			SELECT b.account_id FROM mail_share_binding b
			WHERE b.share_id = mail_share.share_id AND b.account_id > 0
			ORDER BY b.binding_id ASC LIMIT 1
		),
		window_start_email_id = (
			SELECT b.window_start_email_id FROM mail_share_binding b
			WHERE b.share_id = mail_share.share_id AND b.account_id > 0
			ORDER BY b.binding_id ASC LIMIT 1
		)
		WHERE share_id = ${locator}
			AND EXISTS (
				SELECT 1 FROM mail_share_binding b
				WHERE b.share_id = mail_share.share_id AND b.account_id > 0
			)
	`).bind(byLid ? target.lid : target);
}

// T-18 级联的「受影响且无幸存者」谓词。两条臂互斥,不可能重复撤销:
// ① Binding 臂(主):本分享有一条 Binding 指向将死账号;
// ② 回落臂:本分享一条 Binding 都没有(R3-A2 迁移窗口晚写的合法遗留形状,
//    `share-auth-service.loadLiveBindings` 为它留了影子 Binding 读路径),此时主表
//    `account_id` 就是它唯一的绑定事实。少了这条臂,这类行的账号被删后永久停在 ACTIVE。
// 末尾的「无幸存者」半句同样不可省:少了它,删任意一个邮箱都会顺手撤掉还有存活邮箱的分享。
// 集合恒走 `json_each(?)`:它在这条谓词里出现 3 次,展开 `IN (?,?,…)` 就是 3N 个绑定参数,
// N=26 即越过 D1 单语句 100 个参数的硬顶,而 `physicsDeleteByUserIds` 的集合无上限。
const CASCADE_REVOKE_WHERE = `(
			EXISTS (
				SELECT 1 FROM mail_share_binding b
				WHERE b.share_id = mail_share.share_id
					AND b.account_id IN (SELECT value FROM json_each(?))
			)
			OR (
				NOT EXISTS (SELECT 1 FROM mail_share_binding b WHERE b.share_id = mail_share.share_id)
				AND mail_share.account_id IN (SELECT value FROM json_each(?))
			)
		)
		AND NOT EXISTS (
			SELECT 1 FROM mail_share_binding b
			WHERE b.share_id = mail_share.share_id
				AND b.account_id NOT IN (SELECT value FROM json_each(?))
		)`;

// `syncPrimaryAccountId` 的「排除将死集合」变体。不能复用后者:它按 binding_id 最小挑主
// Binding,而此刻将死的 Binding 行还在表里(级联恒在删 Binding 之前重指),挑出来的会是
// 一个马上就要消失的 account。两条守卫逐字保留:`account_id > 0` 与 `EXISTS(幸存者)` ——
// 无幸存者时零变更,主表两列宁可停在旧值,也绝不写 0/NULL(旧 Worker 见 0 即判链接不可用)。
function prepareCascadeResync(c, idsJson) {
	return c.env.db.prepare(`
		UPDATE mail_share
		SET account_id = (
			SELECT b.account_id FROM mail_share_binding b
			WHERE b.share_id = mail_share.share_id AND b.account_id > 0
				AND b.account_id NOT IN (SELECT value FROM json_each(?))
			ORDER BY b.binding_id ASC LIMIT 1
		),
		window_start_email_id = (
			SELECT b.window_start_email_id FROM mail_share_binding b
			WHERE b.share_id = mail_share.share_id AND b.account_id > 0
				AND b.account_id NOT IN (SELECT value FROM json_each(?))
			ORDER BY b.binding_id ASC LIMIT 1
		)
		WHERE mail_share.account_id IN (SELECT value FROM json_each(?))
			AND EXISTS (
				SELECT 1 FROM mail_share_binding b
				WHERE b.share_id = mail_share.share_id AND b.account_id > 0
					AND b.account_id NOT IN (SELECT value FROM json_each(?))
			)
	`).bind(idsJson, idsJson, idsJson, idsJson);
}

function prepareCascadeBindingDelete(c, idsJson) {
	return c.env.db.prepare(`
		DELETE FROM mail_share_binding
		WHERE account_id IN (SELECT value FROM json_each(?))
		RETURNING share_id, account_id
	`).bind(idsJson);
}

function prepareStaleIdempotencyDelete(c, values) {
	return c.env.db.prepare(`
		DELETE FROM share_idempotency
		WHERE user_id = ? AND idempotency_key = ? AND operation = ? AND created_at < ?
	`).bind(values.userId, values.idempotencyKey, values.operation, values.cutoff);
}

function prepareIdempotencyInsert(c, values) {
	return c.env.db.prepare(`
		INSERT INTO share_idempotency (
			user_id, idempotency_key, operation, request_fingerprint, share_id, response_fingerprint, created_at
		)
		SELECT ?, ?, ?, ?, share_id, ?, ?
		FROM mail_share
		WHERE lid = ?
	`).bind(
		values.userId,
		values.idempotencyKey,
		values.operation,
		values.fingerprint,
		JSON.stringify({ lid: values.lid }),
		values.createdAt,
		values.lid
	);
}

async function resolveReplay(c, values) {
	if (!values.idempotencyKey) {
		return null;
	}
	return replayOrConflict(c, values.userId, values.idempotencyKey, values.accepted, values.cutoff, values.operation);
}

async function insertShareAndIdempotency(c, values) {
	const statements = [];
	if (values.idempotencyKey) {
		statements.push(prepareStaleIdempotencyDelete(c, values));
	}
	const shareIndex = statements.length;
	statements.push(prepareShareInsert(c, values));
	// 同批新建的 share 此刻没有任何 Binding,空快照即它的写入侧前置条件。
	statements.push(prepareBindingInsert(c, { ...values, snapshotIds: '[]', snapshotCount: 0 }));
	statements.push(syncPrimaryAccountId(c, { lid: values.lid }));
	if (values.idempotencyKey) {
		statements.push(prepareIdempotencyInsert(c, values));
	}

	try {
		const results = await c.env.db.batch(statements);
		const shareResult = results[shareIndex];
		if (shareResult.meta.changes) {
			return shareResult.results[0];
		}
	} catch (err) {
		if (err instanceof BizError) {
			throw err;
		}
		if (isUniqueConflict(err)) {
			const replay = await resolveReplay(c, values);
			if (replay) {
				return { replay };
			}
		}
		throw err;
	}

	// changes === 0 现在有两个可能原因(限额谓词 / 归属谓词)。沿用仓内既有的事后消歧模式:
	// 先看幂等重放,没有重放再补一次归属查询,归属不过归 SHARE_ACCOUNT_FORBIDDEN。
	const replay = await resolveReplay(c, values);
	if (replay) {
		return { replay };
	}
	await assertOwnedAccounts(c, values.accountIds, values.userId);
	throw new BizError('SHARE_LIMIT_EXCEEDED');
}

// patch 语义与 create 归一化恰好相反,所以**不能**复用 `normalizeCreateBody`:
// 后者是「缺省即 DDL 默认值」,用在 patch 上会把 Owner 没提交的 otp_extraction_enabled
// 悄悄打回 1、把 max_sessions 悄悄清成 NULL。这里一律以「键在不在」判在场
// (`hasOwnProperty`,不是真值判断),「键不存在 = 不改」与「键存在且为 null = 清空」
// 必须可区分。顺带:`normalizeCreateBody` 的字段顺序是幂等指纹的一部分,也不许反过来改它。
function toPatchFlag(value) {
	const flag = FLAG_TOKENS.get(value);
	if (flag === undefined) {
		throw new BizError('SHARE_INVALID_CONFIG');
	}
	return flag;
}

function toPatchCount(value) {
	const count = toNullableCount(value);
	if (count != null && count < 1) {
		throw new BizError('SHARE_INVALID_CONFIG');
	}
	return count;
}

function toPatchInterval(value) {
	const ms = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
	if (!Number.isSafeInteger(ms) || ms < MIN_REFRESH_INTERVAL_MS) {
		throw new BizError('SHARE_INVALID_CONFIG');
	}
	return ms;
}

function toPatchText(value) {
	return value == null ? '' : String(value);
}

// 续期只接受绝对时刻,不接受「再加 N 秒」:后者的基准是服务端收到请求时的 now,
// 管理台上看到的到期时刻与真正落库的值会随往返延迟漂移,而这一列是访客侧倒计时的唯一来源。
// 形状锁死为 API 自己发出去的那一种(`YYYY-MM-DD HH:mm:ss`,容许 `T` 分隔与结尾 `Z`)。
// 带偏移量的写法(`+08:00`)一律拒:本模块全部裸串恒按 UTC 解析(见 `nowText`),
// 放行偏移量等于允许写入方按本地时区提交、读取方按 UTC 解释 —— 一次静默的 8 小时错位。
// 末尾的往返比对不是冗余:`2026-13-45` 会被 dayjs 悄悄滚成一个合法时刻,
// 只有把格式化结果与输入逐字比对才认得出来。
const EXPIRES_AT_SHAPE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}Z?$/;

function toPatchExpiresAt(value) {
	if (typeof value !== 'string' || !EXPIRES_AT_SHAPE.test(value)) {
		throw new BizError('SHARE_INVALID_CONFIG');
	}
	const text = value.replace('T', ' ').replace(/Z$/, '');
	const parsed = toUtc(text);
	if (!parsed.isValid() || parsed.format('YYYY-MM-DD HH:mm:ss') !== text) {
		throw new BizError('SHARE_INVALID_CONFIG');
	}
	return text;
}

// design.md:303 的可变字段白名单,一字不多。SET 子句只从这张表生成 ——
// 禁止 `Object.keys(patch)` 拼 SQL,否则 lid / sec_hmac / auth_key_* /
// credentials_version / status / user_id / account_id / window_start_email_id
// 全都成了可写列。`onlyMessagesAfterCreated` 刻意不在表内:改它会让主表与 Binding 的
// window 下界与新口径失配,而重算窗口是 create/bindings 两条写入口的语义。
// `expiresAt`(T-22b-1b 续期)是表里唯一一个还要过行级判据的字段 —— `read` 只管值域,
// 上限与 `delete_at` 顺延在 `applyRenewal` 里,它拿得到行上下文。
// `delete_at` 本身永远不进表:它恒是派生列(到期 + 保留期),开放给调用方就等于允许
// 「到期后立刻被删」或「永不被删」两种越界。
const UPDATE_FIELDS = [
	{ key: 'name', column: 'name', read: toPatchText },
	{ key: 'remark', column: 'remark', read: toPatchText },
	{ key: 'maxSessions', column: 'max_sessions', read: toPatchCount },
	{ key: 'messageLimit', column: 'message_limit', read: toPatchCount },
	{ key: 'otpExtractionEnabled', column: 'otp_extraction_enabled', read: toPatchFlag },
	{ key: 'autoRefresh', column: 'auto_refresh', read: toPatchFlag },
	{ key: 'refreshIntervalMs', column: 'refresh_interval_ms', read: toPatchInterval },
	{ key: 'showFullAddress', column: 'show_full_address', read: toPatchFlag },
	{ key: 'expiresAt', column: 'expires_at', read: toPatchExpiresAt }
];

function normalizeUpdateBody(params) {
	const patch = [];
	for (const field of UPDATE_FIELDS) {
		if (!hasKey(params, field.key)) {
			continue;
		}
		patch.push({ key: field.key, column: field.column, value: field.read(params[field.key]) });
	}
	return patch;
}

// 续期的两条判据都需要行上下文,进不了 `UPDATE_FIELDS` 的 `read`:
// ① **上限从 create_time 起算,不是从续期时刻起算**。按后者算的话,每次快到期续一下
//    就能把一条分享续成事实上的永久分享,I-2 形同虚设。
// ② 到期时刻必须仍在未来。落在过去是一次不可逆的自锁:行立刻变 EXPIRED,而 EXPIRED 行
//    连 `loadMutableShare` 都过不去,管理员再也改不回来。要立即失效请走 revoke ——
//    那条路径写 status='REVOKED' + revoked_at,在飞 Session 由 `consumeSessionQuota` 的
//    `status = 'ACTIVE'` 谓词当场掐断(它不动 credentials_version,也不需要动)。
// `create_time` 解析不出来时按超限处置(fail-closed):这一列 NOT NULL,真解析失败说明
// 行已经不可信,此时放行等于把兜底上限让给一条脏数据。
// `delete_at` 在这里派生,与 create 同式(`:1126` 的 `duration + retention`)——
// 不同步顺延的话,续期后的分享会在还没到期时就被清理任务删掉。
function applyRenewal(c, patch, share) {
	const renewal = patch.find((item) => item.key === 'expiresAt');
	if (!renewal) {
		return patch;
	}
	const expiresAt = toUtc(renewal.value);
	if (!expiresAt.isAfter(toUtc())) {
		throw new BizError('SHARE_INVALID_CONFIG');
	}
	const createdAt = toUtc(share.create_time);
	if (!createdAt.isValid() || expiresAt.diff(createdAt, 'second') > maxDurationSeconds(c)) {
		throw new BizError('SHARE_DURATION_EXCEEDED');
	}
	return [...patch, {
		key: 'deleteAt',
		column: 'delete_at',
		value: expiresAt.add(retentionSeconds(c), 'second').format('YYYY-MM-DD HH:mm:ss')
	}];
}

// 顺序即语义,与 `assertCreateBody` 同构:值域(已在 normalize 里逐字段抛出)在前,
// 栅栏在后。update 侧恰好且只有两条 intent —— AuthKey 归 resetAuthKey 单入口、
// accountIds 归 bindings,都不在白名单里。
// 触发条件是「设为有限值」而不是「键出现在 patch 里」:显式 null 是取消限制,
// 旧 Worker 语义完全兼容,放行。少接 MESSAGE_LIMIT 这条就是绕过栅栏写 message_limit
// 的后门 —— 旧 Worker 不认识该列,落库即可见集被放宽到窗口内全部邮件。
// `expiresAt` 不在这里门控:`expires_at` 是 v1 就有的列,旧 Worker 认得,不属于
// AC-LIFE-11 的「滚动发布窗口内旧 Worker 执行不了的策略写入」。
function assertUpdatePatch(c, patch) {
	const setsFinite = (key) => patch.some((item) => item.key === key && item.value != null);
	if (setsFinite('maxSessions')) {
		assertCapabilityV2(c, SHARE_V2_INTENT.FINITE_MAX_SESSIONS);
	}
	if (setsFinite('messageLimit')) {
		assertCapabilityV2(c, SHARE_V2_INTENT.MESSAGE_LIMIT);
	}
}

// AC-EDGE-14:配额纪元基线只建立一次。判据取**旧值** —— SQLite 单条 UPDATE 的所有 SET
// 表达式都读更新前的行值,所以 `max_sessions IS NULL` 在这条语句里恒指旧值,与 SET 子句
// 的先后顺序无关。别把它「优化」成先 SELECT 再判:那就是一次先读后写。
// CAS(T-22b P0-2):预读到的 `credentials_version` 与 `expires_at` 原样进 WHERE,与
// `prepareAuthKeyUpdate:1153-1154` 的迁移守卫、`share-auth-service` 的 `consumeSessionQuota`
// 同款 —— 本模块所有敏感写入共用「预读到的事实必须进写入谓词」这一条。少了它,预读之后、
// 这条语句之前发生的 resetAuthKey/disable 会被本次写入无声盖过,而两次并发续期会各按各的
// 旧快照判上限、由到达次序决定最终到期时刻。
// CAS 两列都不能省:`credentials_version` 认凭据轮换,`expires_at` 认另一次续期
// (续期不动 cv,所以 cv 拦不住它)。撤销由既有的 `status = 'ACTIVE'` 认。
// `expires_at > ?` 仍单独保留:CAS 只证明「没人动过这一行」,证明不了「此刻还没过期」——
// 预读与写入之间流逝的真实时间只有它能拦。
// 谓词覆盖整张 `UPDATE_FIELDS` 白名单而不只是续期:`prepareUpdate` 是 `update` 的唯一
// 写入语句,name/remark/配额/开关与 expiresAt 共用它。让改名也输给并发的凭据轮换是刻意的 ——
// 它们同样是「先读后写」,同样会盖掉期间的安全状态变化;放宽到只在 patch 含 expiresAt 时
// 才 CAS,等于给其余八个字段留一条无守卫的写入路径。
function prepareUpdate(c, values) {
	const assignments = values.patch.map((item) => `${item.column} = ?`);
	if (values.resetUsedSessions) {
		assignments.push('access_count = CASE WHEN max_sessions IS NULL THEN 0 ELSE access_count END');
	}
	return c.env.db.prepare(`
		UPDATE mail_share
		SET ${assignments.join(', ')}
		WHERE share_id = ? AND user_id = ? AND status = 'ACTIVE' AND expires_at > ?
			AND credentials_version = ? AND expires_at = ?
	`).bind(
		...values.patch.map((item) => item.value),
		values.shareId,
		values.userId,
		nowText(),
		values.credentialsVersion,
		values.expiresAt
	);
}

// 零命中有两种成因,对管理员的下一步动作恰好相反:行真的没了(撤销 / 过期 / 易主)只能收工,
// 而行还在、只是预读快照被并发写入取代,重读后重发就能成。回查一次活跃谓词把两者分开,
// 免得把一次「重试即可」报成「这条分享不存在」。
// 这次回查只是**解释**,不是判据 —— 判据永远是那条 CAS UPDATE 自己的谓词;回查本身也会被
// 下一次并发赶上,所以它只负责挑错误码,不负责决定写不写,更不允许据此重发写入。
// 放出可区分的 `SHARE_UPDATE_CONFLICT` 不重开存在性探针:能走到这里的调用方早已过了
// `loadMutableShare` 的归属门,行的存在与归属对它不是秘密。这与 `:1105` 那条「不新增可区分
// 错误码」不冲突 —— 那条约束的是预读**之前**的探测面。
async function throwUpdateMiss(c, shareId, userId) {
	await loadMutableShare(c, shareId, userId);
	throw new BizError('SHARE_UPDATE_CONFLICT');
}

// 入参抗污染:`size='abc'` / `0` / `-1` / `page=true` 一律钳到默认或上限,而不是抛错 ——
// 前端传一个脏参数不该把整页打死。deprecated 全量转储只留给真正的无参调用
// (老前端 `http.get('/mailShare/list')`);带 `status` 就是有参筛选,套默认 20。
function clampPositive(value, fallback, max) {
	const num = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
	if (!Number.isSafeInteger(num) || num < 1) {
		return fallback;
	}
	return Math.min(num, max);
}

function normalizeListPaging(params) {
	const hasPaging = hasValue(params, 'page') || hasValue(params, 'size');
	const hasFilter = hasValue(params, 'status');
	if (!hasPaging && !hasFilter) {
		return { paged: false, limit: LIST_DEPRECATED_CAP, offset: 0 };
	}
	const size = clampPositive(params.size, LIST_DEFAULT_SIZE, LIST_MAX_SIZE);
	const page = clampPositive(params.page, 1, Number.MAX_SAFE_INTEGER);
	return { paged: true, page, size, limit: size, offset: (page - 1) * size };
}

function normalizeListStatus(params) {
	if (!hasValue(params, 'status')) {
		return null;
	}
	const status = String(params.status).toUpperCase();
	if (!OWNER_STATUSES.includes(status)) {
		throw new BizError('SHARE_INVALID_CONFIG');
	}
	return status;
}

// 变更入口只认 effectiveStatus=ACTIVE 的本人分享(AC-BIND-02)。他人 / 不存在 / 已撤销 /
// 已过期共用 revoke 的 `SHARE_NOT_FOUND`,不新增可区分错误码。
// `auth_key_enabled` 只为 resetAuthKey 选错误码而取:并发下的正确性由写入语句自己的
// 同款守卫谓词负责,预读不是防线。
// `credentials_version` / `expires_at` 反过来正是要当防线用的:它们随 `update` 的 CAS
// 谓词原样进写入语句(`prepareUpdate:1046-1047`)。取列本身不设防 —— 设防在 WHERE 里。
async function loadMutableShare(c, shareId, userId) {
	const row = isRowId(shareId) ? await c.env.db.prepare(`
		SELECT share_id, lid, only_messages_after_created, auth_key_enabled, create_time,
			credentials_version, expires_at FROM mail_share
		WHERE share_id = ? AND user_id = ? AND status = 'ACTIVE' AND expires_at > ?
	`).bind(shareId, userId, nowText()).first() : null;
	if (!row) {
		throw new BizError('SHARE_NOT_FOUND');
	}
	return row;
}

// design.md:311-329 的状态机表:源态 → 目标列值 → cv 增量 → 是否过 V2 栅栏。
// `fromEnabled` 是迁移守卫,`reset` 的 1 尤其关键 —— AC-LIFE-11 只门控 enable,一旦允许
// `reset` 落在 `auth_key_enabled=0` 的行上,它就是一次绕过 `AUTH_KEY_ENABLE` 栅栏的 enable。
// 守卫是栅栏的一部分,不是可选的健壮性装饰。
// `enable` 的 cvBump 恒为 0(AC-AUTH-07:建立时本无 Key 要求的 Session 不追溯失效);
// 它留下的在飞 establish 窗口由 `consumeSessionQuota` 的 `auth_key_enabled` 谓词关闭,
// 不要在这里「求稳」加一。
const AUTH_KEY_TRANSITIONS = {
	enable: { fromEnabled: 0, toEnabled: 1, mintsKey: true, cvBump: 0, gated: true },
	reset: { fromEnabled: 1, toEnabled: 1, mintsKey: true, cvBump: 1, gated: false },
	disable: { fromEnabled: 1, toEnabled: 0, mintsKey: false, cvBump: 1, gated: false }
};

// 严格枚举:不 trim、不 toLowerCase、不接受数组包装(`String(['reset'])` 恰是 `'reset'`)、
// 缺省不折成任何一条迁移。与 `FLAG_TOKENS:141-144` 同款教训 —— 归一化阶段把非法值折成
// 合法值,「静默打开 AuthKey」就再也认不出来了。
function toAuthKeyTransition(value) {
	if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(AUTH_KEY_TRANSITIONS, value)) {
		throw new BizError('SHARE_INVALID_CONFIG');
	}
	return AUTH_KEY_TRANSITIONS[value];
}

// 三列恒在同一条 UPDATE 的同一个 SET 里赋值,物理上不存在 `enabled=1 / hash=NULL` 的中间态
// (design.md:327 的不变量)。迁移守卫 `auth_key_enabled = ?` 与活跃谓词同在 WHERE:并发的两条
// 命令只有一条能命中,输的一方零变更 —— DDL 侧没有 CHECK 兜底(`init.js:48-51` 是纯 ALTER)。
function prepareAuthKeyUpdate(c, values) {
	return c.env.db.prepare(`
		UPDATE mail_share
		SET auth_key_enabled = ?, auth_key_hash = ?, auth_key_kid = ?,
			credentials_version = credentials_version + ?
		WHERE share_id = ? AND user_id = ? AND status = 'ACTIVE' AND expires_at > ?
			AND auth_key_enabled = ?
	`).bind(
		values.move.toEnabled,
		values.authKeyHash,
		values.authKeyKid,
		values.move.cvBump,
		values.shareId,
		values.userId,
		nowText(),
		values.move.fromEnabled
	);
}

// AC-LIFE-05 的写入本体:同一行内原子换掉 `lid` + `sec_hmac` + `pepper_kid`,并把
// `credentials_version` 加一让在飞 Session 当场断开(`share-auth-service` 每次请求都比对它)。
// **SET 里没有 `expires_at`、没有 `window_start_email_id`,这是本语句的核心语义**:
// 换链接只换凭据,不是续期、也不重置可见窗口 —— 任何一列漏进 SET,AC-LIFE-05 就破了。
// 同理 `status` 不进 SET:活跃谓词只放行 ACTIVE 行,已过期/已撤销的授权不许靠换凭据原地复活
// (AC-LIFE-11),Owner 必须新建。
// CAS 与 `prepareUpdate:1048` 同款:预读到的 `credentials_version` 与 `expires_at` 原样进
// WHERE。少了它,预读之后本语句之前发生的 resetAuthKey / 续期会被这次轮换无声盖过 ——
// 管理员以为「只换了链接」,实际把别人刚做的凭据轮换回滚成了一次可用状态。
// `expires_at > ?` 与 CAS 的 `expires_at = ?` 各管一件事:后者证明「没人动过这一行」,
// 前者证明「此刻还没过期」—— 预读与写入之间流逝的真实时间只有前者能拦。
function prepareRegenerateUpdate(c, values) {
	return c.env.db.prepare(`
		UPDATE mail_share
		SET lid = ?, sec_hmac = ?, pepper_kid = ?,
			sec_cipher = ?, kek_kid = ?,
			credentials_version = credentials_version + 1
		WHERE share_id = ? AND user_id = ? AND status = 'ACTIVE' AND expires_at > ?
			AND credentials_version = ? AND expires_at = ?
		RETURNING share_id, lid, expires_at
	`).bind(
		values.lid,
		values.secHmac,
		values.pepperKid,
		// 与 `lid`/`sec_hmac` 同在一个 SET:轮换后残留旧密文 = 详情页交回一条已经失效的
		// 链接,比取不回来更糟。
		values.secCipher,
		values.kekKid,
		values.shareId,
		values.userId,
		nowText(),
		values.credentialsVersion,
		values.expiresAt
	);
}

// KEK 未配置时的 fail-closed 门,恒在**建任何写入语句之前**调用(轨一硬约束)。
// 判据取 `probeKek` 而不是等 `encryptShareSec` 回 `kek_missing`:创建阶段
// fail-closed 的语义是「不写这一行」,而不是「写了再想办法」—— D1 没有 BEGIN,
// batch 一提交就没有回头路。放行一条无密文的行等于产出一条看起来正常、几天后
// Owner 点开详情才发现取不回来的分享,那正是 ADR 唯一排除的结局。
// 抛裸 `Error` 而不是 BizError,与同文件的 pepper 缺失同款:这不是调用方能改的
// 请求错误,是一次部署事故,要的是 500 + 告警而不是一条可自助的业务码。
function assertKekConfigured(c, stage) {
	if (!probeKek(c.env).available) {
		console.error(`share ${stage} sec kek missing`);
		throw new Error(`share ${stage} sec kek missing`);
	}
}

// 明文凭据的唯一铸造点,create 与 regenerate 共用同一条不变量:库里只留 HMAC + kid
// 与一份可逆信封,明文只经由本次响应出现一次。
// 【轨一】密文在这里与明文同时产出,调用方把 `secCipher` / `kekKid` 原样绑进它那条
// INSERT / UPDATE —— 铸造与落库之间没有第二次机会,所以也不许有第二条语句。
// AAD 绑 `lid` 而不是 `share_id`:create 的 `share_id` 要等 INSERT 返回才存在,绑它
// 就只能拆成两次写入。`lid` 与 `sec` 恒由同一次铸造产生、同一条语句落库,唯一性由
// `idx_mail_share_lid` 保证,所以它同样能让「密文被搬到另一行」验签失败;额外的好处是
// 轮换后残留的旧密文也解不开,而不是悄悄交回一个已经失效的 sec。
async function mintShareCredentials(c, lid, stage) {
	const pepper = c.env.SHARE_SEC_PEPPER;
	if (!pepper) {
		console.error(`share ${stage} sec pepper missing`);
		throw new Error(`share ${stage} pepper missing`);
	}
	const sec = randomToken(32);
	const sealed = await encryptShareSec(c.env, { shareId: lid, plaintext: sec });
	if (!sealed.ok) {
		// `assertKekConfigured` 已经在更早的地方拦过一次;走到这里说明环在两次调用之间
		// 消失了(或将来多了一种失败原因)。仍然 fail-closed,绝不降级成「先写行再说」。
		console.error(`share ${stage} sec cipher failed`, { reason: sealed.reason });
		throw new Error(`share ${stage} sec kek missing`);
	}
	return {
		sec,
		secHmac: await shareAuthService.digestShareSecret(sec, pepper),
		pepperKid: c.env.SHARE_SEC_PEPPER_KID || 'v1',
		secCipher: sealed.envelope,
		kekKid: sealed.kekKid
	};
}

// 解密模块的五种失败 → 对外错误码 + 是否告警(决策卡 §1.4 四类失败表 + 模块新增的
// MALFORMED)。这张表是本端点的全部风险所在:任意两类共用一个码,一次部署事故
// (KEK 没配)或一次数据损坏就会以「这条老分享不可恢复」的样子交给管理员,而那是
// 一句让他放过去的话。所以 ABSENT 与 UNKNOWN_KID(都可重新生成、都不是事故)也各占
// 一个码 —— 前者说「上线前建的」,后者说「密钥退环了」,自助动作相同但成因不同,
// 合并会让「密钥环被误删」看起来像一批陈年老数据。
// AUTH_FAILED 与 MALFORMED 是仅有的一对共用码:对管理员都是「凭据数据异常」,同一个
// 自助动作(找管理员),分开只会让他猜。两者的差别在成因(篡改/搬行 vs 写入侧写坏),
// 只有排障需要,所以留在事件的 `outcome` 里而不是错误码里。
const REVEAL_FAILURE = {
	[SEC_CIPHER_FAILURE.ABSENT]: { code: 'SHARE_SEC_ABSENT', alert: false },
	[SEC_CIPHER_FAILURE.KEK_MISSING]: { code: 'SHARE_SEC_UNAVAILABLE', alert: true },
	[SEC_CIPHER_FAILURE.UNKNOWN_KID]: { code: 'SHARE_SEC_KEY_RETIRED', alert: false },
	[SEC_CIPHER_FAILURE.AUTH_FAILED]: { code: 'SHARE_SEC_CORRUPTED', alert: true },
	[SEC_CIPHER_FAILURE.MALFORMED]: { code: 'SHARE_SEC_CORRUPTED', alert: true }
};

// 解密模块将来多一种失败原因时,这里 fail-loud 而不是静默当成良性降级:
// 未知成因按事故处置是安全的方向,反过来不是。
const REVEAL_UNKNOWN_FAILURE = { code: 'SHARE_SEC_CORRUPTED', alert: true };

// `lid` 与 `sec_cipher` 必须来自**同一次**读取:AAD 绑的是 `lid`,分两条语句取的话,
// 中间落地的一次 regenerate 会让新 lid 配旧密文,解出来是一条 AUTH_FAILED ——
// 把一次正常轮换报成数据完整性事故。
async function loadShareCipher(c, shareId) {
	return c.env.db.prepare(`
		SELECT lid, sec_cipher FROM mail_share WHERE share_id = ?
	`).bind(shareId).first();
}

// 全部拒绝路径都排在建 batch 之前(AC-BIND-12「零残留」):D1 没有 BEGIN,batch 一旦提交
// 就没有回头路,只有语句报错才回滚。写入侧仍各自带同款谓词,与并发删除赛跑时整批零变更。
function assertBindingChange(c, values) {
	if (!values.add.every(isRowId)) {
		throw new BizError('SHARE_ACCOUNT_FORBIDDEN');
	}
	// 不属于本分享的 bindingId(他人分享 / 已删 / 根本不存在)共用一个错误码:
	// 错误码可区分本身就是存在性探针。
	const known = new Set(values.current.map((binding) => binding.bindingId));
	if (!values.remove.every((bindingId) => known.has(bindingId))) {
		throw new BizError('SHARE_BINDING_FORBIDDEN');
	}
	// 表级 UNIQUE(share_id, account_id) 兜底,但先拒才有零残留:同批 INSERT 在 DELETE 之前,
	// 「移除某邮箱又同时加回来」也走这条 —— 想换窗口快照请分两次提交。
	const bound = new Set(values.current.map((binding) => binding.accountId));
	if (values.add.some((accountId) => bound.has(accountId))) {
		throw new BizError('SHARE_BINDING_DUPLICATE');
	}
	// 上限看变更后的投影数,不是现存数;与 create 同序 —— 上限(永久领域错误)排在栅栏(暂时发布态)前。
	const projected = values.current.length + values.add.length - values.remove.length;
	if (projected > SHARE_BINDING_LIMIT) {
		throw new BizError('SHARE_BINDING_LIMIT_EXCEEDED');
	}
	// AC-LIFE-11 ②:使现存 Binding 数变大且大于 1 的变更,旧 Worker 执行不了。
	// 缩减(N→1 / 1→0)与等量替换不触发。
	if (projected > 1 && projected > values.current.length) {
		assertCapabilityV2(c, SHARE_V2_INTENT.BINDING_EXPAND);
	}
}

const mailShareService = {
	async create(c, params, userId) {
		if (isShareDisabled(c)) {
			throw new BizError('SHARE_DISABLED');
		}

		const body = normalizeCreateBody(params);
		assertCreateBody(c, body);
		await assertOwnedAccounts(c, body.accountIds, userId);

		const pepper = c.env.SHARE_SEC_PEPPER;
		if (!pepper) {
			console.error('share create sec pepper missing');
			throw new Error('share create pepper missing');
		}
		// 与 pepper 检查同处:两者都是「这次部署配好了吗」,都必须在任何一条语句之前答完。
		assertKekConfigured(c, 'create');

		const idempotencyKey = params && params.idempotencyKey != null && String(params.idempotencyKey) !== ''
			? String(params.idempotencyKey)
			: '';
		const { stored: fingerprint, accepted } = await createFingerprints(body);
		const cutoff = idempotencyCutoff();
		if (idempotencyKey) {
			const replay = await replayOrConflict(c, userId, idempotencyKey, accepted, cutoff, CREATE_OP);
			if (replay) {
				return replay;
			}
		}

		const now = toUtc();
		const createdAt = now.format('YYYY-MM-DD HH:mm:ss');
		const expiresAt = now.clone().add(body.durationSeconds, 'second').format('YYYY-MM-DD HH:mm:ss');
		const deleteAt = now.clone().add(body.durationSeconds + retentionSeconds(c), 'second').format('YYYY-MM-DD HH:mm:ss');
		const lid = randomToken(16);
		// create 与 regenerate 共用同一个铸造点(T-20b2a 收编):两条路径各自铸 sec 时,
		// 「顺手给一条加了密文、另一条忘了」是这类双入口最典型的漏法。
		const minted = await mintShareCredentials(c, lid, 'create');
		const sec = minted.sec;
		// AC-CAP-05:128-bit CSPRNG → base64url 恰 22 字符;只存 hash + kid,明文只在本次响应出现一次。
		// AuthKey 刻意**不**进可逆信封(ADR「AuthKey 不纳入可逆范围」):它只有 hash。
		const authKey = body.authKeyEnabled ? randomToken(16) : '';
		const pepperKid = minted.pepperKid;
		// R5 契约(T-08 的 establishSession 必须同源):AuthKey 与 sec 共用 SHARE_SEC_PEPPER +
		// SHARE_SEC_PEPPER_KID。`shareAuthService` 只在函数体内解引用 —— 两个模块互相 import,
		// 模块求值期解引用会踩 TDZ。
		const inserted = await insertShareAndIdempotency(c, {
			lid,
			secHmac: minted.secHmac,
			pepperKid,
			secCipher: minted.secCipher,
			kekKid: minted.kekKid,
			userId,
			accountIds: body.accountIds,
			name: body.name,
			remark: body.remark,
			maxSessions: body.maxSessions,
			messageLimit: body.messageLimit,
			onlyMessagesAfterCreated: body.onlyMessagesAfterCreated,
			otpExtractionEnabled: body.otpExtractionEnabled,
			autoRefresh: body.autoRefresh,
			refreshIntervalMs: body.refreshIntervalMs,
			showFullAddress: body.showFullAddress,
			authKeyEnabled: body.authKeyEnabled,
			authKeyHash: authKey ? await shareAuthService.digestShareSecret(authKey, pepper) : null,
			authKeyKid: authKey ? pepperKid : null,
			expiresAt,
			deleteAt,
			createdAt,
			now: createdAt,
			limit: activeLimit(c),
			idempotencyKey,
			operation: CREATE_OP,
			fingerprint,
			accepted,
			cutoff
		});
		if (inserted && inserted.replay) {
			return inserted.replay;
		}
		return firstCreateResponse(c, inserted, sec, authKey, await loadBindings(c, inserted.share_id));
	},

	// AC-BIND-12:add/remove 是一条全有或全无的命令,全部变更进同一个 `c.env.db.batch()`。
	async updateBindings(c, params, userId) {
		const shareId = Number(params && params.shareId);
		const share = await loadMutableShare(c, shareId, userId);
		const add = toIdSet(params && params.add);
		const remove = toIdSet(params && params.remove);
		const current = await loadBindings(c, shareId);
		assertBindingChange(c, { add, remove, current });
		if (add.length) {
			await assertOwnedAccounts(c, add, userId);
		}

		// 预读到的集合原样进写入侧:任何一条写语句看到的集合与这份快照不符,整批零变更。
		const snapshotIds = JSON.stringify(current.map((binding) => binding.bindingId));
		const snapshotCount = current.length;

		const statements = [prepareBindingCas(c, { shareId, userId, snapshotIds, snapshotCount })];
		let addIndex = -1;
		let removeIndex = -1;
		if (add.length) {
			addIndex = statements.length;
			// 同一条 INSERT…SELECT,与 create 共用:窗口快照口径取本分享的 only_messages_after_created
			// (true → 加入时刻 MAX(email_id),false → 0,AC-BIND-02)。
			statements.push(prepareBindingInsert(c, {
				onlyMessagesAfterCreated: share.only_messages_after_created,
				accountIds: add,
				userId,
				lid: share.lid,
				snapshotIds,
				snapshotCount
			}));
		}
		if (remove.length) {
			removeIndex = statements.length;
			statements.push(prepareBindingDelete(c, {
				bindingIds: remove, shareId, userId, addAccountIds: add, snapshotIds, snapshotCount
			}));
		}
		// AC-BIND-04:删空即撤销。谓词读同批 DELETE 之后的真实状态,不信预检算出的投影数。
		statements.push(prepareRevoke(c, `share_id = ? AND user_id = ? AND NOT EXISTS (
			SELECT 1 FROM mail_share_binding b WHERE b.share_id = mail_share.share_id
		)`, [shareId, userId]));
		// AC-LIFE-10 双写:主表两列跟随剩余主 Binding;无 Binding 时助手自身零变更,不写 0。
		statements.push(syncPrimaryAccountId(c, shareId));

		try {
			const results = await c.env.db.batch(statements);
			// CAS 落空 = 预读的集合已被并发命令改写,写入语句的同款谓词已让整批零变更。
			// 调用方必须重读再决定,不能拿同一份 remove 列表原样重试 —— 那些 bindingId
			// 可能已经不存在,重试只会变成一个语义完全不同的 SHARE_BINDING_FORBIDDEN。
			if (!results[0].meta.changes) {
				throw new BizError('SHARE_BINDING_CONFLICT');
			}
			// 与 account 删除并发时 INSERT 是零行而不是报错;DELETE 的谓词已让整批零变更,
			// 这里只负责把它翻译成 AC-BIND-10 的错误码。
			if (addIndex >= 0 && results[addIndex].meta.changes !== add.length) {
				throw new BizError('SHARE_ACCOUNT_FORBIDDEN');
			}
			// CAS 命中之后集合在批内不会再动,所以 remove 少命中只可能是谓词自身拦下了整批。
			if (removeIndex >= 0 && results[removeIndex].meta.changes !== remove.length) {
				throw new BizError('SHARE_BINDING_CONFLICT');
			}
		} catch (err) {
			if (err instanceof BizError) {
				throw err;
			}
			if (isUniqueConflict(err)) {
				throw new BizError('SHARE_BINDING_DUPLICATE');
			}
			throw err;
		}

		const bindings = await loadBindings(c, shareId);
		return {
			shareId,
			status: bindings.length ? 'ACTIVE' : 'REVOKED',
			shareType: shareTypeOf(bindings),
			bindings
		};
	},

	// AC-ADMIN-02:单条详情 = 列表行 + Binding 明细 + 全部配置,非 ACTIVE 行同样可读。
	async get(c, params, userId) {
		return loadOwnerDetail(c, toShareId(params && params.shareId), userId);
	},

	// AC-ADMIN-03 / AC-EDGE-14:白名单 patch。「下次 Visitor 请求生效」不需要额外动作 ——
	// 读路径每请求回源查库,落库即生效。
	async update(c, params, userId) {
		const shareId = toShareId(params && params.shareId);
		// 改配置只对活分享有意义,与 updateBindings 同一把锁;他人/已撤销/已过期共用
		// SHARE_NOT_FOUND(存在性探针封闭)。
		const share = await loadMutableShare(c, shareId, userId);
		// 顺序即语义,与 `assertCreateBody` 同构:值域(normalize 里逐字段抛出)→ 上限 → 栅栏。
		const patch = applyRenewal(c, normalizeUpdateBody(params), share);
		assertUpdatePatch(c, patch);
		if (patch.length) {
			const resetUsedSessions = patch.some((item) => item.key === 'maxSessions' && item.value != null)
				&& toFlag(params.resetUsedSessions, 1) === 1;
			// 预读到的两列原样回到 WHERE:期间的凭据轮换 / 另一次续期必须让本次零命中。
			const applied = await prepareUpdate(c, {
				patch,
				resetUsedSessions,
				shareId,
				userId,
				credentialsVersion: share.credentials_version,
				expiresAt: share.expires_at
			}).run();
			// 零命中分流:行没了 → SHARE_NOT_FOUND;行还在但快照过时 → SHARE_UPDATE_CONFLICT。
			if (!applied.meta.changes) {
				await throwUpdateMiss(c, shareId, userId);
			}
		}
		return loadOwnerDetail(c, shareId, userId);
	},

	// AC-ADMIN-07:物理删除。两张子表都没有 FOREIGN KEY,D1 也不开 ON DELETE CASCADE,
	// 级联全靠这三条语句。顺序是子表在前、主表在后:子表的归属谓词要经 mail_share 回查
	// user_id,主表行一旦先删,归属判据就消失了。同一个 batch 才有原子性。
	// 谓词只有 `share_id + user_id`(不带 status/expires_at)—— 删的往往正是
	// REVOKED / EXPIRED 行,套上 revoke 的活跃谓词就删不掉了。
	async delete(c, params, userId) {
		const shareId = toShareId(params && params.shareId);
		if (!shareId) {
			throw new BizError('SHARE_NOT_FOUND');
		}
		const results = await c.env.db.batch([
			c.env.db.prepare(`
				DELETE FROM mail_share_binding
				WHERE share_id = ? AND EXISTS (
					SELECT 1 FROM mail_share ms WHERE ms.share_id = ? AND ms.user_id = ?
				)
			`).bind(shareId, shareId, userId),
			c.env.db.prepare(`
				DELETE FROM share_idempotency
				WHERE share_id = ? AND EXISTS (
					SELECT 1 FROM mail_share ms WHERE ms.share_id = ? AND ms.user_id = ?
				)
			`).bind(shareId, shareId, userId),
			c.env.db.prepare(`
				DELETE FROM mail_share WHERE share_id = ? AND user_id = ?
			`).bind(shareId, userId)
		]);
		if (!results[results.length - 1].meta.changes) {
			throw new BizError('SHARE_NOT_FOUND');
		}
		return { shareId };
	},

	// AC-AUTH-07 / AC-AUTH-08 / AC-ADMIN-05:AuthKey 的唯一写入口。三条迁移共用一条带守卫的
	// 条件 UPDATE,`update` 的白名单里没有、也不许有这四列(design.md:328)。
	// 顺序即语义,与 `assertCreateBody` / `assertUpdatePatch` 同构:
	// ① action 值域 → ② 归属 + ACTIVE → ③ 迁移合法性 → ④ V2 栅栏。
	// 前三条是永久领域错误,共用 `SHARE_INVALID_CONFIG`;栅栏只是暂时的发布态,已拆出
	// `SHARE_CAPABILITY_NOT_ENABLED`,管理台不必再靠语句顺序反推该找管理员还是改自己的值。
	async resetAuthKey(c, params, userId) {
		const move = toAuthKeyTransition(params == null ? undefined : params.action);
		const shareId = toShareId(params && params.shareId);
		const share = await loadMutableShare(c, shareId, userId);
		if (share.auth_key_enabled !== move.fromEnabled) {
			throw new BizError('SHARE_INVALID_CONFIG');
		}
		if (move.gated) {
			assertCapabilityV2(c, SHARE_V2_INTENT.AUTH_KEY_ENABLE);
		}

		// 与 create 同源:同一个 pepper、同一个 kid、同一个 `digestShareSecret`,否则
		// `matchAuthKey` 永远验不过。kid 写**当前**值而不是行上原有值 —— 那等于顺手完成
		// 一次 pepper 前滚;写回旧 kid 会在旧 pepper 退环后 fail-closed。
		// disable 不需要 pepper,所以不为它做无谓的前置检查。
		let authKey = '';
		let authKeyHash = null;
		let authKeyKid = null;
		if (move.mintsKey) {
			const pepper = c.env.SHARE_SEC_PEPPER;
			if (!pepper) {
				console.error('share reset auth key pepper missing');
				throw new Error('share reset auth key pepper missing');
			}
			authKey = randomToken(16);
			authKeyHash = await shareAuthService.digestShareSecret(authKey, pepper);
			authKeyKid = c.env.SHARE_SEC_PEPPER_KID || 'v1';
		}

		const applied = await prepareAuthKeyUpdate(c, { move, authKeyHash, authKeyKid, shareId, userId }).run();
		// 零变更有两个原因(并发 revoke / 过期,或并发迁移让守卫失配),一律按不存在处置 ——
		// 与 `update` 同码,存在性探针保持封闭。正确的重试姿势本来就是重读再决定。
		if (!applied.meta.changes) {
			throw new BizError('SHARE_NOT_FOUND');
		}

		const detail = await loadOwnerDetail(c, shareId, userId);
		// 明文恰一次,而且只在 enable / reset 挂键:disable 是「没有这个键」而不是空串。
		return authKey ? { ...detail, authKey } : detail;
	},

	// AC-LIFE-05 / AC-LIFE-11 / AC-SHARE-13:链接可能外泄或丢失时的「换一条继续用」。
	// 结构逐段对应 `resetAuthKey`(同为凭据轮换的单入口):
	// ① 幂等重放前置 → ② 归属 + ACTIVE 状态门 → ③ 铸新凭据 → ④ 带 CAS 的条件 UPDATE
	// → ⑤ 零命中分流 → ⑥ 明文恰一次返回。
	// 与 resetAuthKey 的唯一结构差别是这条走 `batch()`:幂等行必须与轮换同生共死,
	// 否则要么留下指向旧 lid 的孤儿幂等行,要么轮换了却记不上账、重试再轮换一次。
	// **不设 V2 栅栏**:本路径只写 v1 就有的 `lid`/`sec_hmac`/`pepper_kid`,滚动发布窗口里的
	// 旧 Worker 完全认得(它照样会拒掉旧 sec);`credentials_version` 是纯加严,旧 Worker
	// 读不到也不会因此放宽任何东西 —— 与 AC-LIFE-11 门控的「旧 Worker 执行不了的策略写入」不同类。
	async regenerate(c, params, userId) {
		const shareId = toShareId(params && params.shareId);
		// 与 create 同款,排在一切之前:KEK 没配好时整条轮换面都该拒,包括幂等重放 ——
		// 让它「重放成功」等于把一次部署事故藏进一条看着正常的响应里。
		assertKekConfigured(c, 'regenerate');
		const idempotencyKey = params && params.idempotencyKey != null && String(params.idempotencyKey) !== ''
			? String(params.idempotencyKey)
			: '';
		// 指纹只含 shareId:regenerate 没有别的请求体字段,「同 Key 换了另一条分享」必须是冲突
		// 而不是重放 —— 否则一次手滑会拿回上一条分享的 lid,以为自己换掉了这一条。
		const fingerprint = await requestFingerprint({ shareId });
		const cutoff = idempotencyCutoff();
		const values = {
			userId, idempotencyKey, operation: REGENERATE_OP,
			fingerprint, accepted: [fingerprint], cutoff
		};
		if (idempotencyKey) {
			const replay = await resolveReplay(c, values);
			if (replay) {
				return replay;
			}
		}

		// 他人 / 不存在 / 已撤销 / 已过期共用 SHARE_NOT_FOUND(存在性探针保持封闭),
		// 也正是 AC-LIFE-11 要的「过期授权不得原地复活」。
		const share = await loadMutableShare(c, shareId, userId);
		const lid = randomToken(16);
		const minted = await mintShareCredentials(c, lid, 'regenerate');

		const statements = [];
		if (idempotencyKey) {
			statements.push(prepareStaleIdempotencyDelete(c, values));
		}
		const rotateIndex = statements.length;
		statements.push(prepareRegenerateUpdate(c, {
			lid,
			secHmac: minted.secHmac,
			pepperKid: minted.pepperKid,
			secCipher: minted.secCipher,
			kekKid: minted.kekKid,
			shareId,
			userId,
			credentialsVersion: share.credentials_version,
			expiresAt: share.expires_at
		}));
		if (idempotencyKey) {
			// 与 create 共用同一条语句:它 `SELECT ... FROM mail_share WHERE lid = ?` 绑**新** lid,
			// 所以 CAS 落空(没有行拿到新 lid)时它自然零行,不需要另一套守卫。
			statements.push(prepareIdempotencyInsert(c, { ...values, lid, createdAt: nowText() }));
		}

		let rotated;
		try {
			rotated = (await c.env.db.batch(statements))[rotateIndex];
		} catch (err) {
			// 同 Key 并发:唯一键报错让整批回滚(轮换也没发生),回读那一行按重放处置。
			if (isUniqueConflict(err)) {
				const replay = await resolveReplay(c, values);
				if (replay) {
					return replay;
				}
			}
			throw err;
		}
		// 零命中分流与 `update` 同码:行没了 → SHARE_NOT_FOUND;行还在但预读快照已被
		// 并发的轮换 / 续期取代 → SHARE_UPDATE_CONFLICT,调用方重读再决定。
		if (!rotated.meta.changes) {
			await throwUpdateMiss(c, shareId, userId);
		}

		// 明文恰一次:`sec` 只在这一次响应里出现,库里只有 HMAC。
		return firstCreateResponse(c, rotated.results[0], minted.sec, '', await loadBindings(c, shareId));
	},

	// 轨一的读取端(ADR-share-credential-recoverability):把当初创建时发出的那条完整
	// 链接原样交回给 Owner。明文只从密文列解出来,库里依然只有 HMAC + 信封。
	//
	// **状态门:刻意不设**。归属走 `loadOwnerDetail` 的谓词(`share_id + user_id`,
	// 与 `get` 同一个入口),而不是 `loadMutableShare` 的 ACTIVE + 未过期谓词。
	// 理由是「查看不等于使用」在这里成立得很硬:已过期 / 已撤销的行,其链接在访客侧
	// 恒被 `consumeSessionQuota` 的活跃谓词当场拒掉,而且没有任何路径能让它复活 ——
	// `regenerate` 与 `update`(含续期)都只认 ACTIVE 且未过期的行。所以交回这条链接
	// 不给出任何可用能力;反过来套上活跃谓词,就把 AC-ADMIN-09 要求「非 ACTIVE 行仍
	// 可读可审计」的那一半砍掉了 —— 管理员恰恰是在这些行上排查「当初发出去的是哪条」。
	//
	// `authKey` 不在返回范围内(ADR「AuthKey 不纳入可逆范围」):它只有 hash。
	async revealSec(c, params, userId) {
		const shareId = toShareId(params && params.shareId);
		const audit = (fields) => logShareEvent(c, SHARE_EVENT.SEC_REVEAL, { shareId, userId, ...fields });

		try {
			// 归属与存在性判定的唯一来源。⛔ 不在这里重写一遍 `user_id = ?` ——
			// 两份归属判据迟早会分叉,而分叉的那一侧就是一次越权。
			await loadOwnerDetail(c, shareId, userId);
		} catch (err) {
			// 被拒的调用同样要留痕(这是凭据暴露面,试探比成功更值得记),但对调用方
			// 一个字都不多说:错误原样抛出,他人 / 不存在共用 SHARE_NOT_FOUND。
			if (err instanceof BizError) {
				audit({ outcome: 'denied', alert: false });
			}
			throw err;
		}

		const row = await loadShareCipher(c, shareId);
		if (!row) {
			// 归属校验与本次读取之间行被删掉了。按不存在处置,与上面同码。
			audit({ outcome: 'denied', alert: false });
			throw new BizError('SHARE_NOT_FOUND');
		}

		const opened = await decryptShareSec(c.env, { shareId: row.lid, envelope: row.sec_cipher });
		if (!opened.ok) {
			const mapped = REVEAL_FAILURE[opened.reason] || REVEAL_UNKNOWN_FAILURE;
			audit({ outcome: opened.reason, alert: mapped.alert, kekKid: opened.kekKid || null });
			throw new BizError(mapped.code);
		}

		audit({ outcome: 'ok', alert: false, kekKid: opened.kekKid });
		// 只回链接,不单独回裸 `sec`:管理员要的是能复制的那一条,多一个字段就多一处
		// 会被日志 / 埋点顺手带走的明文。
		return { shareId, lid: row.lid, shareUrl: shareUrlOf(c, row.lid, opened.plaintext) };
	},

	async list(c, params, userId) {
		const now = nowText();
		const status = normalizeListStatus(params);
		const paging = normalizeListPaging(params);
		const filterSql = status ? ` AND ${OWNER_STATUS_CASE} = ?` : '';
		const filterBinds = status ? [now, status] : [];

		// `total` 与结果集共用同一条 CASE 与同一个 now,所以分页后两者仍然自洽;
		// 单独数一次而不是 `COUNT(*) OVER ()`,是为了让越界页(空结果集)也报得出真实总数。
		const counted = await c.env.db.prepare(`
			SELECT COUNT(*) AS total FROM mail_share ms
			WHERE ms.user_id = ?${filterSql}
		`).bind(userId, ...filterBinds).first();

		const rows = await c.env.db.prepare(`
			SELECT ${OWNER_ROW_COLUMNS}, a.email AS mailbox
			FROM mail_share ms
			LEFT JOIN account a ON a.account_id = ms.account_id
			WHERE ms.user_id = ?${filterSql}
			ORDER BY ms.share_id DESC
			LIMIT ? OFFSET ?
		`).bind(userId, ...filterBinds, paging.limit, paging.offset).all();

		const results = rows.results || [];
		const bindings = await loadBindingSummaries(c, results.map((row) => row.share_id));
		const list = results.map((row) => projectOwnerRow(
			toOwnerRow(row), row.mailbox, now, bindings.get(row.share_id) || []
		));
		const response = { list, total: counted.total };
		if (paging.paged) {
			response.page = paging.page;
			response.size = paging.size;
		} else {
			// 无参调用不是分页,而是「不分页 + 硬顶 500 行」;`total` 仍给真实总数,
			// `total > list.length` 即被截断。前端应改走 page/size。
			response.deprecated = true;
		}
		return response;
	},

	async revoke(c, params, userId) {
		const shareId = Number(params && params.shareId);
		const applied = await applyRevoke(c, 'share_id = ? AND user_id = ?', [shareId, userId]);
		if (!applied.meta.changes) {
			throw new BizError('SHARE_NOT_FOUND');
		}
		return { shareId: applied.results[0].share_id };
	},

	async revokeByAccountId(c, accountId) {
		return this.revokeByAccountIds(c, [accountId]);
	},

	async revokeByAccountIds(c, accountIds) {
		const ids = [];
		const seen = new Set();
		for (const raw of accountIds || []) {
			const id = Number(raw);
			if (!Number.isInteger(id) || id <= 0 || seen.has(id)) {
				continue;
			}
			seen.add(id);
			ids.push(id);
		}
		if (!ids.length) {
			// 空集合早退不可省:空 `json_each` 让 `IN` 恒假而 `NOT IN` 恒真,
			// 「删 0 个邮箱」会走成「撤销全库所有零 Binding 的 ACTIVE 行」。
			return { revoked: 0 };
		}
		const idsJson = JSON.stringify(ids);
		// 顺序即语义:①撤销 与 ②重指 都要读「将死 Binding 还在」这个事实,③销毁它。
		// D1 的 batch 是一个事务,三条要么全成要么全不成。
		// 判据只有「accountId ∈ 本次传入集合」—— 三个挂钩点(account-service :159/:184/:250)
		// 全在 account 行仍存活、仍 NORMAL 时调用,拿「account 已删」当判据会恒零命中,
		// 静默退化成空操作。也不加 try/catch:级联抛错必须让整个账号删除失败(fail-closed),
		// 吞掉就变成「账号删了、分享还活着」。
		const results = await c.env.db.batch([
			prepareRevoke(c, CASCADE_REVOKE_WHERE, [idsJson, idsJson, idsJson]),
			prepareCascadeResync(c, idsJson),
			prepareCascadeBindingDelete(c, idsJson)
		]);

		const revokedIds = new Set((results[0].results || []).map((row) => row.share_id));
		// 每个受影响 share 一行,不是每个 binding 一行:`physicsDeleteByUserIds` 一次可能
		// 剔除上百条 Binding。字段只放行号与计数,绝不放邮箱地址 / sec / authKey。
		const removed = new Map();
		for (const shareId of revokedIds) {
			removed.set(shareId, 0);
		}
		for (const row of results[2].results || []) {
			removed.set(row.share_id, (removed.get(row.share_id) || 0) + 1);
		}
		for (const [shareId, removedBindings] of removed) {
			logShareEvent(c, SHARE_EVENT.BINDING_CASCADE, {
				shareId,
				reason: 'account_deleted',
				removedBindings,
				revoked: revokedIds.has(shareId)
			});
		}

		// `revoked` 的语义不变,仍是「被置 REVOKED 的分享数」(①的 changes),不是「受影响分享数」。
		return { revoked: results[0].meta.changes || 0, unbound: results[2].meta.changes || 0 };
	}
};

export default mailShareService;
