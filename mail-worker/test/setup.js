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

let seedSeq = 0;

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
	if (!(row.userId > 0) || !(row.accountId > 0)) {
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
	if (!(shareId > 0) || !(accountId > 0)) {
		throw new Error('seedBindingRow needs positive shareId and accountId');
	}
	const inserted = await env.db.prepare(`
		INSERT INTO mail_share_binding (share_id, account_id, window_start_email_id)
		VALUES (?, ?, ?)
		RETURNING binding_id
	`).bind(shareId, accountId, windowStartEmailId).first();
	return inserted.binding_id;
}
