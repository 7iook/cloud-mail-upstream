import { and, asc, eq, gt, ne } from 'drizzle-orm';
import { emailConst, isDel } from '../const/entity-const';
import email from '../entity/email';
import orm from '../entity/orm';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * ShareContext produced by shareAuthService.resolveSession (T-08).
 * T-10 already calls getById(c, ctx, mailId) with this shape.
 *
 * @typedef {Object} ShareContext
 * @property {number} accountId must be > 0; 0 is unmatched inbound mail and must not query
 * @property {number} windowStartEmailId finite; 0 is allowed (share created with no prior mail)
 * @property {number} [shareId] ignored here
 * @property {string} [expiresAt] ignored here
 * @property {string} [effectiveStatus] ignored here; auth must already have required ACTIVE
 */

function resolveShareScope(ctx) {
	if (!ctx) {
		return null;
	}
	const accountId = Number(ctx.accountId);
	const windowStartEmailId = Number(ctx.windowStartEmailId);
	if (!(accountId > 0) || !Number.isFinite(windowStartEmailId)) {
		return null;
	}
	return { accountId, windowStartEmailId };
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

function resolveLimit(limit) {
	const value = Number(limit);
	if (!Number.isFinite(value) || value <= 0) {
		return DEFAULT_LIMIT;
	}
	return Math.min(Math.floor(value), MAX_LIMIT);
}

function resolveMailId(mailId) {
	const value = Number(mailId);
	if (!Number.isInteger(value) || value <= 0) {
		return null;
	}
	return value;
}

function visibleWindowConditions(scope) {
	return and(
		eq(email.accountId, scope.accountId),
		gt(email.accountId, 0),
		gt(email.emailId, scope.windowStartEmailId),
		eq(email.isDel, isDel.NORMAL),
		ne(email.status, emailConst.status.SAVING)
	);
}

const shareScopedEmailRepository = {

	async list(c, ctx, cursor, limit) {
		const scope = resolveShareScope(ctx);
		if (!scope) {
			return [];
		}

		const conditions = [visibleWindowConditions(scope)];
		const afterCursor = resolveCursor(cursor);
		if (afterCursor != null) {
			conditions.push(gt(email.emailId, afterCursor));
		}

		const rows = await orm(c)
			.select()
			.from(email)
			.where(and(...conditions))
			.orderBy(asc(email.emailId))
			.limit(resolveLimit(limit))
			.all();
		return rows || [];
	},

	async getById(c, ctx, mailId) {
		const scope = resolveShareScope(ctx);
		const id = resolveMailId(mailId);
		if (!scope || id == null) {
			return null;
		}

		const row = await orm(c)
			.select()
			.from(email)
			.where(and(
				eq(email.emailId, id),
				visibleWindowConditions(scope)
			))
			.get();
		return row || null;
	}

};

export default shareScopedEmailRepository;
