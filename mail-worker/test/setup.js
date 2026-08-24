import { env, SELF } from 'cloudflare:test';

const secret = env.jwt_secret;
if (!secret) {
	throw new Error('jwt_secret binding missing; check wrangler-vitest.toml');
}

if (!env.db) {
	throw new Error('D1 binding db missing; check wrangler-vitest.toml');
}

const response = await SELF.fetch(`http://example.com/api/init/${encodeURIComponent(secret)}`);
const body = await response.text();
if (body !== 'success') {
	throw new Error(`test schema init failed: status=${response.status} body=${body}`);
}

// ── 回归基线（design.md「基线守恒」）──────────────────────────────────────────
// 历史地板（本 charter 开工前，recon-crosscut §7 亲跑）：worker 16 文件 / 138 用例、
// vue 17 文件 / 95 用例、E2E 13 场景。这三组数字是只增不减的底线。
// T-01 落地后 worker 实测 17 文件 / 153 用例，后续任务会继续加，所以这里只记录、
// 不写成断言 —— 钉死总数只会变成每加一个用例就要改一次的维护陷阱。
// 单邮箱旧断言（lid 128-bit / sec 256-bit / HMAC 存库、SHARE_ACTIVE_LIMIT、
// SHARE_MAX_DURATION_SECONDS 上限）只允许扩展，不允许改写。
// ─────────────────────────────────────────────────────────────────────────────

// 建表 DDL 只在 src/init/init.js 的 v3_2DB 里（单 owner）。这里只做 seed。

const MAIL_SHARE_COLUMNS = [
	['lid', 'lid'],
	['sec_hmac', 'secHmac'],
	['pepper_kid', 'pepperKid'],
	['user_id', 'userId'],
	['account_id', 'accountId'],
	['name', 'name'],
	['remark', 'remark'],
	['status', 'status'],
	['window_start_email_id', 'windowStartEmailId'],
	['expires_at', 'expiresAt'],
	['delete_at', 'deleteAt'],
	['access_count', 'accessCount'],
	['last_access_at', 'lastAccessAt'],
	['revoked_at', 'revokedAt'],
	['create_time', 'createTime'],
	['max_sessions', 'maxSessions'],
	['message_limit', 'messageLimit'],
	['only_messages_after_created', 'onlyMessagesAfterCreated'],
	['otp_extraction_enabled', 'otpExtractionEnabled'],
	['auto_refresh', 'autoRefresh'],
	['refresh_interval_ms', 'refreshIntervalMs'],
	['show_full_address', 'showFullAddress'],
	['auth_key_enabled', 'authKeyEnabled'],
	['auth_key_hash', 'authKeyHash'],
	['auth_key_kid', 'authKeyKid'],
	['credentials_version', 'credentialsVersion']
];

// workerd 恒 UTC，所以「写入方用了进程本地时区」这个缺陷在这里是黑盒不可见的：
// local === UTC 时 `dayjs().format()` 与 `dayjs.utc().format()` 逐字相同。
// 这个夹具只改 Date 暴露的本地时间 getter —— 正是 `dayjs().format()` 读的那一组 ——
// 从而在运行时内部模拟一个 UTC+N 进程。`getUTC*` / `Date.now()` / SQLite 的
// CURRENT_TIMESTAMP 一概不动，它们仍是真 UTC，可当作对照锚点。
// （Windows 上 `TZ` 环境变量对 Node 有效，但 vitest-pool-workers 跑的是 workerd，
// 拿不到进程时区这个旋钮，所以只能在 Date 这一层做对照实验。）
const LOCAL_TIME_GETTERS = [
	'getFullYear', 'getMonth', 'getDate', 'getDay',
	'getHours', 'getMinutes', 'getSeconds', 'getMilliseconds'
];

export async function withLocalTimezoneShift(offsetHours, fn) {
	const shiftMs = offsetHours * 3600 * 1000;
	const saved = LOCAL_TIME_GETTERS.map((name) => [name, Date.prototype[name]]);
	const savedOffset = Date.prototype.getTimezoneOffset;
	for (const [name] of saved) {
		const utcName = name.replace('get', 'getUTC');
		Date.prototype[name] = function shiftedLocalGetter() {
			return new Date(this.getTime() + shiftMs)[utcName]();
		};
	}
	Date.prototype.getTimezoneOffset = function shiftedOffset() {
		return -offsetHours * 60;
	};
	try {
		return await fn();
	} finally {
		for (const [name, impl] of saved) {
			Date.prototype[name] = impl;
		}
		Date.prototype.getTimezoneOffset = savedOffset;
	}
}

// 裸串 'YYYY-MM-DD HH:mm:ss' 不带时区标记，「按 UTC 读」就是它的全部契约。
export function utcTextToMs(text) {
	return Date.parse(`${String(text).replace(' ', 'T')}Z`);
}

let seedSeq = 0;

// 行 ID 只接受安全整数正数。`value > 0` 单独用会放行 '1e3' / '1.5' / true / Infinity ——
// 这些形状进到 D1 绑定后被静默强转，种子行的主键语义就和用例断言对不上了。
function isRowId(value) {
	return Number.isSafeInteger(value) && value > 0;
}

function sqlTime(offsetSeconds = 0) {
	return new Date(Date.now() + offsetSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * 插入一条含 v3_2DB 全部新列的 `mail_share` 行。
 * `userId`/`accountId` 必填且为正：`account_id` 是 Expand 阶段的双写列，0 表示
 * 「旧 Worker 读到即不可用」，工厂不提供这个默认值（AC-LIFE-10）。
 */
export async function seedShareRow(overrides = {}) {
	seedSeq += 1;
	const tag = `t04-seed-${Date.now()}-${seedSeq}`;
	const row = {
		lid: tag,
		secHmac: `${tag}-hmac`,
		pepperKid: 'v1',
		name: '',
		remark: '',
		status: 'ACTIVE',
		windowStartEmailId: 0,
		expiresAt: sqlTime(3600),
		deleteAt: sqlTime(7200),
		accessCount: 0,
		lastAccessAt: null,
		revokedAt: null,
		createTime: sqlTime(0),
		maxSessions: null,
		messageLimit: null,
		onlyMessagesAfterCreated: 1,
		otpExtractionEnabled: 1,
		autoRefresh: 1,
		refreshIntervalMs: 3000,
		showFullAddress: 0,
		authKeyEnabled: 0,
		authKeyHash: null,
		authKeyKid: null,
		credentialsVersion: 0,
		...overrides
	};
	if (!isRowId(row.userId) || !isRowId(row.accountId)) {
		throw new Error('seedShareRow needs positive userId and accountId (AC-LIFE-10 forbids a 0 primary account_id)');
	}
	const columns = MAIL_SHARE_COLUMNS.map(([column]) => column).join(', ');
	const placeholders = MAIL_SHARE_COLUMNS.map(() => '?').join(', ');
	const values = MAIL_SHARE_COLUMNS.map(([, prop]) => row[prop]);
	const inserted = await env.db.prepare(`
		INSERT INTO mail_share (${columns}) VALUES (${placeholders})
		RETURNING share_id
	`).bind(...values).first();
	return { ...row, shareId: inserted.share_id };
}

/**
 * 插入一条 `mail_share_binding` 行，返回自增 `binding_id`。
 * 主 Binding = 同一 share 下 `binding_id` 最小的那条，所以调用顺序即主次顺序。
 */
export async function seedBindingRow({ shareId, accountId, windowStartEmailId = 0 } = {}) {
	if (!isRowId(shareId) || !isRowId(accountId)) {
		throw new Error('seedBindingRow needs positive shareId and accountId');
	}
	const inserted = await env.db.prepare(`
		INSERT INTO mail_share_binding (share_id, account_id, window_start_email_id)
		VALUES (?, ?, ?)
		RETURNING binding_id
	`).bind(shareId, accountId, windowStartEmailId).first();
	return inserted.binding_id;
}
