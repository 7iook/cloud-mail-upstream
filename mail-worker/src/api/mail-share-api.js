import app from '../hono/hono';
import shareResult from '../model/share-result';
import userContext from '../security/user-context';
import mailShareService from '../service/mail-share-service';

function shareJson(c, body) {
	return c.json(body, 200, { 'Cache-Control': 'no-store' });
}

function withShare(handler) {
	return async (c) => {
		try {
			return await handler(c);
		} catch (err) {
			if (err && err.name === 'BizError') {
				return shareJson(c, shareResult.fail(err.message, err.code));
			}
			throw err;
		}
	};
}

app.post('/mailShare/create', withShare(async (c) => {
	const body = await c.req.json();
	const idempotencyKey = c.req.header('Idempotency-Key') || '';
	const data = await mailShareService.create(c, { ...body, idempotencyKey }, userContext.getUserId(c));
	return shareJson(c, shareResult.ok(data));
}));

app.get('/mailShare/list', withShare(async (c) => {
	const data = await mailShareService.list(c, c.req.query(), userContext.getUserId(c));
	return shareJson(c, shareResult.ok(data));
}));

app.put('/mailShare/bindings', withShare(async (c) => {
	const body = await c.req.json();
	const data = await mailShareService.updateBindings(c, body, userContext.getUserId(c));
	return shareJson(c, shareResult.ok(data));
}));

app.delete('/mailShare/revoke', withShare(async (c) => {
	const data = await mailShareService.revoke(c, c.req.query(), userContext.getUserId(c));
	return shareJson(c, shareResult.ok(data));
}));
