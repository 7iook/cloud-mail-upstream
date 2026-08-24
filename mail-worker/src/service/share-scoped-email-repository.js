import { and, desc, eq, getTableColumns, gt, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { emailConst, isDel } from '../const/entity-const';
import email from '../entity/email';
import orm from '../entity/orm';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const EMAIL_COLUMNS = Object.keys(getTableColumns(email));

/**
 * ShareContext frozen by T-09 (`share-auth-service.js` buildShareContext).
 * Consumed here, never rebuilt: `bindings` is the scope source of truth and
 * `accountId`/`windowStartEmailId` are deprecated shims derived from bindings[0].
 *
 * @typedef {Object} ShareBinding
 * @property {number} bindingId
 * @property {number} accountId must be > 0; 0 is unmatched inbound mail and must not query
 * @property {number} windowStartEmailId finite; 0 is allowed (only_messages_after_created=false)
 *
 * @typedef {Object} ShareContext
 * @property {ShareBinding[]} [bindings]
 * @property {number|null} [messageLimit] latest-N per binding; null/0 means unbounded
 * @property {number} [accountId] deprecated shim, only authoritative when bindings is empty
 * @property {number} [windowStartEmailId] deprecated shim, see above
 */

function toScope(binding) {
	if (!binding) {
		return null;
	}
	const accountId = Number(binding.accountId);
	const windowStartEmailId = Number(binding.windowStartEmailId);
	if (!(accountId > 0) || !Number.isFinite(windowStartEmailId)) {
		return null;
	}
	return { bindingId: resolveRowId(binding.bindingId), accountId, windowStartEmailId };
}

function resolveScopes(ctx) {
	if (!ctx) {
		return [];
	}
	const bindings = Array.isArray(ctx.bindings) && ctx.bindings.length > 0 ? ctx.bindings : [ctx];
	return bindings.map(toScope).filter(Boolean);
}

function resolveMessageLimit(ctx) {
	const value = Number(ctx && ctx.messageLimit);
	return Number.isInteger(value) && value > 0 ? value : null;
}

function resolveCursor(cursor) {
	if (cursor == null || cursor === '') {
		return null;
	}
	const value = Number(cursor);
	if (!Number.isFinite(value)) {
		return null;
	}
	return value;
}

function resolveLimit(limit, cap) {
	const value = Number(limit);
	const requested = Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_LIMIT;
	return Math.min(requested, MAX_LIMIT, cap == null ? Infinity : cap);
}

function resolveRowId(value) {
	const id = Number(value);
	return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Single range SSOT: the per-binding VisibleWindow intersected with the latest-N
 * truncation, as a subquery. `list`, `listForBinding` and `getById` all read
 * through it, so there is no second window model to keep in sync.
 *
 * ponytail: 每页代价是 O(窗口内行数) —— row_number 与跨 Binding 归并都在 LIMIT 之前
 * 物化(EXPLAIN 仍走 idx_email_account_id_email_id,无表扫描)。真出现巨型窗口再换成
 * per-binding `UNION ALL (... ORDER BY email_id DESC LIMIT n)` 的索引短路写法。
 */
function visibleSubquery(c, scopes, messageLimit) {
	const ranked = orm(c)
		.select({
			...getTableColumns(email),
			rowNo: sql`row_number() over (partition by ${email.accountId} order by ${email.emailId} desc)`.as('row_no')
		})
		.from(email)
		.where(and(
			inArray(email.accountId, scopes.map((scope) => scope.accountId)),
			gt(email.accountId, 0),
			eq(email.isDel, isDel.NORMAL),
			ne(email.status, emailConst.status.SAVING),
			or(...scopes.map((scope) => and(
				eq(email.accountId, scope.accountId),
				gt(email.emailId, scope.windowStartEmailId)
			)))
		))
		.as('visible');

	const columns = Object.fromEntries(EMAIL_COLUMNS.map((key) => [key, ranked[key]]));
	const truncation = messageLimit == null ? undefined : sql`${ranked.rowNo} <= ${messageLimit}`;
	return { ranked, columns, truncation };
}

async function selectVisible(c, scopes, messageLimit, cursor, limit) {
	if (scopes.length === 0) {
		return [];
	}
	const { ranked, columns, truncation } = visibleSubquery(c, scopes, messageLimit);
	const before = resolveCursor(cursor);

	const rows = await orm(c)
		.select(columns)
		.from(ranked)
		.where(and(truncation, before == null ? undefined : lt(ranked.emailId, before)))
		.orderBy(desc(ranked.emailId))
		.limit(limit)
		.all();
	return rows || [];
}

const shareScopedEmailRepository = {

	async list(c, ctx, cursor, limit) {
		const scopes = resolveScopes(ctx);
		const messageLimit = resolveMessageLimit(ctx);
		// 单 scope 时总量上界就是 per-binding 上界；多 scope 时每个邮箱的最新 N 已在 SQL 内
		// 各自截断，总量再压到 N 会让排在后面的邮箱拿不到自己的名额。
		const cap = scopes.length === 1 ? messageLimit : null;
		return selectVisible(c, scopes, messageLimit, cursor, resolveLimit(limit, cap));
	},

	async listForBinding(c, ctx, bindingId, cursor, limit) {
		const id = resolveRowId(bindingId);
		const scopes = resolveScopes(ctx).filter((scope) => scope.bindingId != null && scope.bindingId === id);
		const messageLimit = resolveMessageLimit(ctx);
		return selectVisible(c, scopes, messageLimit, cursor, resolveLimit(limit, messageLimit));
	},

	async getById(c, ctx, mailId) {
		const scopes = resolveScopes(ctx);
		const id = resolveRowId(mailId);
		if (scopes.length === 0 || id == null) {
			return null;
		}
		const { ranked, columns, truncation } = visibleSubquery(c, scopes, resolveMessageLimit(ctx));

		const row = await orm(c)
			.select(columns)
			.from(ranked)
			.where(and(eq(ranked.emailId, id), truncation))
			.get();
		return row || null;
	}

};

export default shareScopedEmailRepository;
