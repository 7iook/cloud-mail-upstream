import { eq } from 'drizzle-orm';
import dayjs from 'dayjs';
import { isDel } from '../const/entity-const';
import account from '../entity/account';
import orm from '../entity/orm';
import BizError from '../error/biz-error';
import shareAuthService from './share-auth-service';

const CREATE_OP = 'create';
const IDEMPOTENCY_TTL_HOURS = 24;
const DEFAULT_RETENTION_SECONDS = 604800;
const UNBOUNDED_ACTIVE_LIMIT = 1000000000;
const encoder = new TextEncoder();

// R3-A5 / AC-CAP-13:每分享 Binding 数量硬上限,create 与 bindings 两个写入口共用。
export const SHARE_BINDING_LIMIT = 50;

// AC-LIFE-11:滚动发布窗口内旧 Worker 无法执行的四类策略写入。
export const SHARE_V2_INTENT = {
	MULTI_CREATE: 'multi_create',
	BINDING_EXPAND: 'binding_expand',
	AUTH_KEY_ENABLE: 'auth_key_enable',
	FINITE_MAX_SESSIONS: 'finite_max_sessions'
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
// `intent` 取 SHARE_V2_INTENT 之一,标记是四条受限写入路径中的哪一条;判定与 intent 无关,
// 它只为调用点自述与后续排障保留(接线见 T-12/T-13/T-15/T-16)。
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

function normalizeCreateBody(params) {
	return {
		accountId: Number(params && params.accountId),
		durationSeconds: Number(params && params.durationSeconds),
		name: params && params.name == null ? '' : String(params.name),
		remark: params && params.remark == null ? '' : String(params.remark)
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

async function loadOwnedAccount(c, accountId, userId) {
	const row = await orm(c).select().from(account).where(eq(account.accountId, accountId)).get();
	if (!row || row.isDel === isDel.DELETE || row.userId !== userId) {
		throw new BizError('SHARE_ACCOUNT_FORBIDDEN');
	}
	return row;
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

function firstCreateResponse(c, row, sec) {
	const origin = publicOrigin(c);
	return {
		shareId: row.share_id,
		lid: row.lid,
		sec,
		expiresAt: row.expires_at,
		shareUrl: `${origin}/s/${row.lid}#${sec}`
	};
}

async function readIdempotency(c, userId, idempotencyKey) {
	return c.env.db.prepare(`
		SELECT id, request_fingerprint, share_id, response_fingerprint, created_at
		FROM share_idempotency
		WHERE user_id = ? AND idempotency_key = ? AND operation = ?
	`).bind(userId, idempotencyKey, CREATE_OP).first();
}

async function replayFromIdempotency(c, row) {
	const share = await c.env.db.prepare(
		'SELECT share_id, lid, expires_at FROM mail_share WHERE share_id = ?'
	).bind(row.share_id).first();
	if (!share) {
		throw new BizError('SHARE_NOT_FOUND');
	}
	return {
		shareId: share.share_id,
		lid: share.lid,
		expiresAt: share.expires_at,
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

function prepareShareInsert(c, values) {
	return c.env.db.prepare(`
		INSERT INTO mail_share (
			lid, sec_hmac, pepper_kid, user_id, account_id, name, remark, status,
			window_start_email_id, expires_at, delete_at, create_time
		)
		SELECT
			?, ?, ?, ?, ?, ?, ?, 'ACTIVE',
			(SELECT COALESCE(MAX(email_id), 0) FROM email WHERE account_id = ?),
			?, ?, ?
		WHERE (
			SELECT COUNT(*) FROM mail_share
			WHERE user_id = ? AND status = 'ACTIVE' AND expires_at > ?
		) < ?
		RETURNING share_id, lid, window_start_email_id, expires_at, delete_at, create_time
	`).bind(
		values.lid,
		values.secHmac,
		values.pepperKid,
		values.userId,
		values.accountId,
		values.name,
		values.remark,
		values.accountId,
		values.expiresAt,
		values.deleteAt,
		values.createdAt,
		values.userId,
		values.now,
		values.limit
	);
}

// Expand 阶段双写(design.md「迁移/发布协议」步骤 1 / AC-LIFE-10):主表 `account_id` 跟随
// 主 Binding(binding_id 最小)。返回未执行的语句,供 T-12/T-13/T-18 放进同一个
// `c.env.db.batch()` 与 Binding 变更一起提交。WHERE 的 EXISTS 使无可用 Binding 时零变更 ——
// 主表列宁可停在旧值让旧 Worker 读旧语义,也绝不写 0(旧 Worker 见 0 即链接不可用)。
export function syncPrimaryAccountId(c, shareId) {
	return c.env.db.prepare(`
		UPDATE mail_share
		SET account_id = (
			SELECT b.account_id FROM mail_share_binding b
			WHERE b.share_id = mail_share.share_id AND b.account_id > 0
			ORDER BY b.binding_id ASC LIMIT 1
		)
		WHERE share_id = ?
			AND EXISTS (
				SELECT 1 FROM mail_share_binding b
				WHERE b.share_id = mail_share.share_id AND b.account_id > 0
			)
	`).bind(shareId);
}

async function insertShareAndIdempotency(c, values) {
	const insertShare = prepareShareInsert(c, values);
	if (!values.idempotencyKey) {
		const inserted = await insertShare.all();
		if (!inserted.meta.changes) {
			throw new BizError('SHARE_LIMIT_EXCEEDED');
		}
		return inserted.results[0];
	}

	const deleteStale = c.env.db.prepare(`
		DELETE FROM share_idempotency
		WHERE user_id = ? AND idempotency_key = ? AND operation = ? AND created_at < ?
	`).bind(values.userId, values.idempotencyKey, CREATE_OP, values.cutoff);

	const insertIdempotency = c.env.db.prepare(`
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

	try {
		const results = await c.env.db.batch([deleteStale, insertShare, insertIdempotency]);
		const shareResult = results[1];
		if (!shareResult.meta.changes) {
			const replay = await replayOrConflict(
				c,
				values.userId,
				values.idempotencyKey,
				values.fingerprint,
				values.cutoff
			);
			if (replay) {
				return { replay };
			}
			throw new BizError('SHARE_LIMIT_EXCEEDED');
		}
		return shareResult.results[0];
	} catch (err) {
		if (err instanceof BizError) {
			throw err;
		}
		if (isUniqueConflict(err)) {
			const replay = await replayOrConflict(
				c,
				values.userId,
				values.idempotencyKey,
				values.fingerprint,
				values.cutoff
			);
			if (replay) {
				return { replay };
			}
		}
		throw err;
	}
}

const mailShareService = {
	async create(c, params, userId) {
		if (isShareDisabled(c)) {
			throw new BizError('SHARE_DISABLED');
		}

		const body = normalizeCreateBody(params);
		if (!Number.isFinite(body.accountId) || body.accountId <= 0) {
			throw new BizError('SHARE_ACCOUNT_FORBIDDEN');
		}
		const maxDuration = maxDurationSeconds(c);
		if (!Number.isFinite(body.durationSeconds) || body.durationSeconds <= 0
			|| (maxDuration != null && body.durationSeconds > maxDuration)) {
			throw new BizError('SHARE_DURATION_EXCEEDED');
		}
		await loadOwnedAccount(c, body.accountId, userId);

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
		const inserted = await insertShareAndIdempotency(c, {
			lid,
			secHmac: await shareAuthService.digestShareSecret(sec, pepper),
			pepperKid: c.env.SHARE_SEC_PEPPER_KID || 'v1',
			userId,
			accountId: body.accountId,
			name: body.name,
			remark: body.remark,
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
		return firstCreateResponse(c, inserted, sec);
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
