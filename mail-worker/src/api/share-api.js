import app from '../hono/hono';
import BizError from '../error/biz-error';
import shareResult from '../model/share-result';
import shareAttachmentService from '../service/share-attachment-service';
import shareAuthService from '../service/share-auth-service';
import shareMailService from '../service/share-mail-service';
import {
	SHARE_READ_RATE_LIMITER,
	SHARE_READ_RETRY_AFTER_SECONDS,
	SHARE_SESSION_RATE_LIMITER,
	SHARE_SESSION_RETRY_AFTER_SECONDS,
	shareRateLimit
} from '../security/share-rate-limit';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function shareJson(c, body) {
	return c.json(body, 200, { 'Cache-Control': 'no-store' });
}

function withShare(handler) {
	return async (c) => {
		try {
			const out = await handler(c);
			if (out instanceof Response) {
				out.headers.set('Cache-Control', 'no-store');
				return out;
			}
			return out;
		} catch (err) {
			if (err && err.name === 'BizError') {
				return shareJson(c, shareResult.fail(err.message, err.code));
			}
			throw err;
		}
	};
}

function readSessionToken(c) {
	const raw = c.req.header('Authorization') || '';
	const matched = /^Bearer\s+(\S+)/i.exec(raw);
	return matched ? matched[1] : raw;
}

function capLimit(limit) {
	const value = Number(limit);
	if (!Number.isFinite(value) || value <= 0) {
		return DEFAULT_LIMIT;
	}
	return Math.min(Math.floor(value), MAX_LIMIT);
}

app.post('/share/session', shareRateLimit(SHARE_SESSION_RATE_LIMITER, SHARE_SESSION_RETRY_AFTER_SECONDS), withShare(async (c) => {
	const body = await c.req.json();
	const idempotencyKey = c.req.header('Idempotency-Key') || '';
	const data = await shareAuthService.establishSession(c, body.lid, body.sec, {
		idempotencyKey,
		authKey: body.authKey
	});
	return shareJson(c, shareResult.ok(data));
}));

app.get('/share/mails', shareRateLimit(SHARE_READ_RATE_LIMITER, SHARE_READ_RETRY_AFTER_SECONDS), withShare(async (c) => {
	const query = c.req.query();
	const ctx = await shareAuthService.resolveSession(c, readSessionToken(c));
	const limit = capLimit(query.limit);
	const list = await shareMailService.list(c, ctx, query.cursor, limit);
	const nextCursor = list.length === limit && list.length > 0
		? String(list[list.length - 1].mailId)
		: null;
	return shareJson(c, shareResult.ok({ list, nextCursor }));
}));

app.get('/share/mail', shareRateLimit(SHARE_READ_RATE_LIMITER, SHARE_READ_RETRY_AFTER_SECONDS), withShare(async (c) => {
	const query = c.req.query();
	const ctx = await shareAuthService.resolveSession(c, readSessionToken(c));
	const mail = await shareMailService.getById(c, ctx, query.mailId);
	if (!mail) {
		throw new BizError('SHARE_UNAVAILABLE');
	}
	return shareJson(c, shareResult.ok(mail));
}));

app.get('/share/attachment', shareRateLimit(SHARE_READ_RATE_LIMITER, SHARE_READ_RETRY_AFTER_SECONDS), withShare(async (c) => {
	const query = c.req.query();
	return await shareAttachmentService.download(c, {
		sessionToken: readSessionToken(c),
		mailId: query.mailId,
		attachmentId: query.attachmentId
	});
}));
