import dayjs from 'dayjs';
import { isDel } from '../const/entity-const';
import BizError from '../error/biz-error';
import shareAuthService from './share-auth-service';

const CREATE_OP = 'create';
const IDEMPOTENCY_TTL_HOURS = 24;
const DEFAULT_RETENTION_SECONDS = 604800;
const UNBOUNDED_ACTIVE_LIMIT = 1000000000;
// AC-CAP-06 / Decision 13:写入侧拒绝小于这个值,下发侧的钳制归 T-08。
const MIN_REFRESH_INTERVAL_MS = 3000;
const encoder = new TextEncoder();

// R3-A5 / AC-CAP-13:每分享 Binding 数量硬上限,create 与 bindings 两个写入口共用。
export const SHARE_BINDING_LIMIT = 50;

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
export const SHARE_EVENT = {
	SESSION_DENIED_QUOTA: 'share.session.denied_quota',
	SESSION_DENIED_AUTH: 'share.session.denied_auth',
	SESSION_DENIED_CV: 'share.session.denied_cv',
	BINDING_CASCADE: 'share.binding.cascade',
	MIGRATE_INVALID_ROW: 'share.migrate.invalid_row',
	SYSTEM_ERROR: 'share.system.error'
};

function nowText() {
	return dayjs().format('YYYY-MM-DD HH:mm:ss');
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
export function assertCapabilityV2(c, intent) {
	if (isCapabilityV2Enabled(c)) {
		return;
	}
	throw new BizError('SHARE_INVALID_CONFIG');
}

// 结构化观测的唯一出口:一行 JSON,恒带 requestId 与 shareId(R2-F2 请求关联字段约定)。
// 调用方只传诊断字段,禁止传 sec / authKey / token / IP / 邮箱地址等 PII 与凭据。
export function logShareEvent(event, fields = {}) {
	const { requestId = null, shareId = null, ...rest } = fields;
	// 诊断字段先铺，规范字段后写：调用方传进来的 event / ts 只能被覆盖，不能反过来改写信封。
	console.log(JSON.stringify({
		...rest,
		event,
		requestId,
		shareId,
		ts: new Date().toISOString()
	}));
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

function toFlag(value, fallback) {
	if (value == null || value === '') {
		return fallback;
	}
	if (value === false || value === 0 || value === '0' || value === 'false') {
		return 0;
	}
	return 1;
}

function toNullableCount(value) {
	if (value == null || value === '') {
		return null;
	}
	return Number(value);
}

// AC-CAP-09/10:`accountIds` 优先,缺失才回落旧 `accountId` 单值。去重 + 升序是三处口径的
// 共同前提 —— 表级 UNIQUE(share_id, account_id) 只收一条,栅栏计数、上限计数与指纹必须同口径;
// 升序还让 accountIds[0] 恒等于 ORDER BY 写入的主 Binding(binding_id 最小)。
function toAccountIdSet(params) {
	const raw = params && params.accountIds != null
		? (Array.isArray(params.accountIds) ? params.accountIds : [params.accountIds])
		: [params && params.accountId];
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

function activeLimit(c) {
	const limit = Number(c.env && c.env.SHARE_ACTIVE_LIMIT);
	if (Number.isFinite(limit) && limit > 0) {
		return Math.floor(limit);
	}
	return UNBOUNDED_ACTIVE_LIMIT;
}

function maxDurationSeconds(c) {
	const max = Number(c.env && c.env.SHARE_MAX_DURATION_SECONDS);
	if (Number.isFinite(max) && max > 0) {
		return Math.floor(max);
	}
	return null;
}

function retentionSeconds(c) {
	const retention = Number(c.env && c.env.SHARE_RETENTION_SECONDS);
	if (Number.isFinite(retention) && retention > 0) {
		return Math.floor(retention);
	}
	return DEFAULT_RETENTION_SECONDS;
}

function idempotencyCutoff() {
	return dayjs().subtract(IDEMPOTENCY_TTL_HOURS, 'hour').format('YYYY-MM-DD HH:mm:ss');
}

function isUniqueConflict(err) {
	return /UNIQUE constraint failed/i.test(String(err && err.message || err));
}

function placeholders(list) {
	return list.map(() => '?').join(', ');
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
	const maxDuration = maxDurationSeconds(c);
	if (!Number.isFinite(body.durationSeconds) || body.durationSeconds <= 0
		|| (maxDuration != null && body.durationSeconds > maxDuration)) {
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

function projectOwnerRow(row, mailbox, now) {
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
		windowStartEmailId: row.windowStartEmailId,
		createTime: row.createTime,
		expiresAt: row.expiresAt,
		deleteAt: row.deleteAt,
		accessCount: row.accessCount,
		lastAccessAt: row.lastAccessAt,
		revokedAt: row.revokedAt
	};
}

async function applyRevoke(c, whereSql, binds) {
	return c.env.db.prepare(`
		UPDATE mail_share
		SET status = 'REVOKED', revoked_at = ?
		WHERE ${whereSql} AND status = 'ACTIVE'
		RETURNING share_id
	`).bind(nowText(), ...binds).all();
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

function firstCreateResponse(c, row, sec, authKey, bindings) {
	const origin = publicOrigin(c);
	const response = {
		shareId: row.share_id,
		lid: row.lid,
		sec,
		expiresAt: row.expires_at,
		shareUrl: `${origin}/s/${row.lid}#${sec}`,
		shareType: shareTypeOf(bindings),
		bindings
	};
	if (authKey) {
		response.authKey = authKey;
	}
	return response;
}

async function readIdempotency(c, userId, idempotencyKey) {
	return c.env.db.prepare(`
		SELECT id, request_fingerprint, share_id, response_fingerprint, created_at
		FROM share_idempotency
		WHERE user_id = ? AND idempotency_key = ? AND operation = ?
	`).bind(userId, idempotencyKey, CREATE_OP).first();
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

async function replayOrConflict(c, userId, idempotencyKey, fingerprint, cutoff) {
	const existing = await readIdempotency(c, userId, idempotencyKey);
	if (!existing || existing.created_at < cutoff) {
		return null;
	}
	if (existing.request_fingerprint !== fingerprint) {
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
			auth_key_enabled, auth_key_hash, auth_key_kid
		)
		SELECT
			?, ?, ?, ?, ?, ?, ?, 'ACTIVE',
			CASE WHEN ? = 1
				THEN (SELECT COALESCE(MAX(email_id), 0) FROM email WHERE account_id = ?)
				ELSE 0 END,
			?, ?, ?,
			?, ?, ?, ?,
			?, ?, ?,
			?, ?, ?
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
// binding 零行,不需要额外守卫。`ORDER BY a.account_id` 让 AUTOINCREMENT 的 binding_id
// 顺序等于 accountIds 的升序,主 Binding 与主表初值因此恒等。
function prepareBindingInsert(c, values) {
	return c.env.db.prepare(`
		INSERT INTO mail_share_binding (share_id, account_id, window_start_email_id)
		SELECT ms.share_id, a.account_id,
			CASE WHEN ? = 1
				THEN (SELECT COALESCE(MAX(e.email_id), 0) FROM email e WHERE e.account_id = a.account_id)
				ELSE 0 END
		FROM mail_share ms
		JOIN account a ON a.account_id IN (${placeholders(values.accountIds)})
			AND a.user_id = ? AND a.is_del = ${isDel.NORMAL}
		WHERE ms.lid = ?
		ORDER BY a.account_id ASC
	`).bind(values.onlyMessagesAfterCreated, ...values.accountIds, values.userId, values.lid);
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

function prepareStaleIdempotencyDelete(c, values) {
	return c.env.db.prepare(`
		DELETE FROM share_idempotency
		WHERE user_id = ? AND idempotency_key = ? AND operation = ? AND created_at < ?
	`).bind(values.userId, values.idempotencyKey, CREATE_OP, values.cutoff);
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
		CREATE_OP,
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
	return replayOrConflict(c, values.userId, values.idempotencyKey, values.fingerprint, values.cutoff);
}

async function insertShareAndIdempotency(c, values) {
	const statements = [];
	if (values.idempotencyKey) {
		statements.push(prepareStaleIdempotencyDelete(c, values));
	}
	const shareIndex = statements.length;
	statements.push(prepareShareInsert(c, values));
	statements.push(prepareBindingInsert(c, values));
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

		const idempotencyKey = params && params.idempotencyKey != null && String(params.idempotencyKey) !== ''
			? String(params.idempotencyKey)
			: '';
		const fingerprint = await requestFingerprint(body);
		const cutoff = idempotencyCutoff();
		if (idempotencyKey) {
			const replay = await replayOrConflict(c, userId, idempotencyKey, fingerprint, cutoff);
			if (replay) {
				return replay;
			}
		}

		const now = dayjs();
		const createdAt = now.format('YYYY-MM-DD HH:mm:ss');
		const expiresAt = now.clone().add(body.durationSeconds, 'second').format('YYYY-MM-DD HH:mm:ss');
		const deleteAt = now.clone().add(body.durationSeconds + retentionSeconds(c), 'second').format('YYYY-MM-DD HH:mm:ss');
		const lid = randomToken(16);
		const sec = randomToken(32);
		// AC-CAP-05:128-bit CSPRNG → base64url 恰 22 字符;只存 hash + kid,明文只在本次响应出现一次。
		const authKey = body.authKeyEnabled ? randomToken(16) : '';
		const pepperKid = c.env.SHARE_SEC_PEPPER_KID || 'v1';
		// R5 契约(T-08 的 establishSession 必须同源):AuthKey 与 sec 共用 SHARE_SEC_PEPPER +
		// SHARE_SEC_PEPPER_KID。`shareAuthService` 只在函数体内解引用 —— 两个模块互相 import,
		// 模块求值期解引用会踩 TDZ。
		const inserted = await insertShareAndIdempotency(c, {
			lid,
			secHmac: await shareAuthService.digestShareSecret(sec, pepper),
			pepperKid,
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
			fingerprint,
			cutoff
		});
		if (inserted && inserted.replay) {
			return inserted.replay;
		}
		return firstCreateResponse(c, inserted, sec, authKey, await loadBindings(c, inserted.share_id));
	},

	async list(c, _params, userId) {
		const rows = await c.env.db.prepare(`
			SELECT
				ms.share_id, ms.lid, ms.user_id, ms.account_id, ms.name, ms.remark,
				ms.status, ms.window_start_email_id, ms.create_time, ms.expires_at,
				ms.delete_at, ms.access_count, ms.last_access_at, ms.revoked_at,
				a.email AS mailbox
			FROM mail_share ms
			LEFT JOIN account a ON a.account_id = ms.account_id
			WHERE ms.user_id = ?
			ORDER BY ms.share_id DESC
		`).bind(userId).all();
		const now = nowText();
		const list = (rows.results || []).map((row) => projectOwnerRow({
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
			revokedAt: row.revoked_at
		}, row.mailbox, now));
		return { list, total: list.length };
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
			return { revoked: 0 };
		}
		const placeholders = ids.map(() => '?').join(', ');
		const applied = await applyRevoke(c, `account_id IN (${placeholders})`, ids);
		return { revoked: applied.meta.changes || 0 };
	}
};

export default mailShareService;
