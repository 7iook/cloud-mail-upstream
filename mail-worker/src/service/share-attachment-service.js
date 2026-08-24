import { and, eq } from 'drizzle-orm';
import { att } from '../entity/att';
import orm from '../entity/orm';
import BizError from '../error/biz-error';
import r2Service from './r2-service';

const SHARE_UNAVAILABLE = 'SHARE_UNAVAILABLE';

function throwUnavailable() {
	throw new BizError(SHARE_UNAVAILABLE);
}

function responseWithNoStore(body, sourceHeaders) {
	const headers = new Headers(sourceHeaders);
	if (!headers.get('Content-Type')) {
		headers.set('Content-Type', 'application/octet-stream');
	}
	headers.set('Cache-Control', 'no-store');
	return new Response(body, { headers });
}

export function normalizeObjectResponse(obj) {
	if (obj == null) {
		return null;
	}

	if (typeof Response !== 'undefined' && obj instanceof Response) {
		return responseWithNoStore(obj.body, obj.headers);
	}

	if (typeof obj === 'object' && 'body' in obj) {
		if (obj.body == null) {
			return null;
		}
		const meta = obj.httpMetadata || {};
		const headers = new Headers();
		headers.set('Content-Type', meta.contentType || 'application/octet-stream');
		if (meta.contentDisposition) {
			headers.set('Content-Disposition', meta.contentDisposition);
		}
		headers.set('Cache-Control', 'no-store');
		return new Response(obj.body, { headers });
	}

	return null;
}

export async function readObjectNormalized(getObj, c, key) {
	let raw;
	try {
		raw = await getObj(c, key);
	} catch (err) {
		if (err && err.name === 'BizError') {
			throw err;
		}
		console.error('share-attachment object read failed', {
			name: err && err.name,
			httpStatus: err && err.$metadata && err.$metadata.httpStatusCode
		});
		return null;
	}
	return normalizeObjectResponse(raw);
}

async function defaultFindAttachment(c, { attId, accountId, emailId }) {
	const row = await orm(c).select().from(att).where(
		and(
			eq(att.attId, attId),
			eq(att.accountId, accountId),
			eq(att.emailId, emailId)
		)
	).get();
	return row || null;
}

async function loadShareAuthService(deps) {
	if (deps.shareAuthService) {
		return deps.shareAuthService;
	}
	const mod = await import('./share-auth-service.js');
	return mod.default;
}

async function loadScopedEmailRepository(deps) {
	if (deps.shareScopedEmailRepository) {
		return deps.shareScopedEmailRepository;
	}
	const mod = await import('./share-scoped-email-repository.js');
	return mod.default;
}

async function resolveShareContext(c, request, deps) {
	const sessionToken = request && request.sessionToken;
	if (sessionToken != null && sessionToken !== '') {
		const shareAuthService = await loadShareAuthService(deps);
		return await shareAuthService.resolveSession(c, sessionToken);
	}
	if (request && request.shareContext) {
		return request.shareContext;
	}
	throwUnavailable();
}

// A reached cap closes the door without clearing the room (AC-SESS-06): the sessions
// already issued keep reading, attachments included. REVOKED and EXPIRED still cut.
const DOWNLOAD_ALLOWED_STATUS = ['ACTIVE', 'ACCESS_LIMIT_REACHED'];

// Only the share-level state is checked here. Which mailboxes the context reaches is
// the scoped repository's call (bindings, window, latest-N), so this no longer reads the
// deprecated single-binding `accountId` shim.
function assertActiveShareContext(shareContext) {
	if (!shareContext) {
		throwUnavailable();
	}
	if (shareContext.effectiveStatus && !DOWNLOAD_ALLOWED_STATUS.includes(shareContext.effectiveStatus)) {
		throwUnavailable();
	}
}

function parsePositiveId(value) {
	const id = Number(value);
	if (!Number.isInteger(id) || id <= 0) {
		return null;
	}
	return id;
}

const shareAttachmentService = {

	normalizeObjectResponse,
	readObjectNormalized,

	async download(c, request, deps = {}) {
		const shareContext = await resolveShareContext(c, request, deps);
		assertActiveShareContext(shareContext);

		const mailId = parsePositiveId(request && request.mailId);
		const attachmentId = parsePositiveId(request && request.attachmentId);
		if (mailId == null || attachmentId == null) {
			throwUnavailable();
		}

		// The mail has to clear the visible set first (window ∩ latest-N, across every
		// Binding). Probing `attachments` before that would answer "does this id exist"
		// for rows the visitor may not see (AC-MAIL-05 / AC-EDGE-08), and the owning
		// account only becomes known once the mail row is in hand.
		const scopedRepo = await loadScopedEmailRepository(deps);
		const emailRow = await scopedRepo.getById(c, shareContext, mailId);
		if (!emailRow) {
			throwUnavailable();
		}

		const findAttachment = deps.findAttachment || defaultFindAttachment;
		const attRow = await findAttachment(c, {
			attId: attachmentId,
			accountId: emailRow.accountId,
			emailId: mailId
		});
		if (!attRow || !attRow.key) {
			throwUnavailable();
		}
		if (attRow.accountId !== emailRow.accountId || attRow.emailId !== mailId) {
			throwUnavailable();
		}

		const getObj = deps.getObj || ((ctx, key) => r2Service.getObj(ctx, key));
		const response = await readObjectNormalized(getObj, c, attRow.key);
		if (!response) {
			throwUnavailable();
		}
		return response;
	}

};

export default shareAttachmentService;
