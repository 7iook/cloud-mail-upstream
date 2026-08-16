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
