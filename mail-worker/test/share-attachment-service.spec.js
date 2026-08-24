import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import shareAttachmentService, {
	normalizeObjectResponse,
	readObjectNormalized
} from '../src/service/share-attachment-service';
import { attConst, emailConst, isDel } from '../src/const/entity-const';
import BizError from '../src/error/biz-error';

function storageResponse(body, headers = {}) {
	return new Response(body, {
		headers: {
			'Content-Type': headers.contentType || 'application/pdf',
			'Content-Disposition': headers.contentDisposition || 'attachment;filename=doc.pdf',
			'Cache-Control': headers.cacheControl || 'max-age=259200'
		}
	});
}

function r2Object(body, httpMetadata = {}) {
	return {
		body,
		httpMetadata: {
			contentType: httpMetadata.contentType || 'application/pdf',
			contentDisposition: httpMetadata.contentDisposition || 'attachment;filename=doc.pdf'
		}
	};
}

// ShareContext 由用例自造（T-09 冻结形状），不经 resolveSession。
// 范围只认 bindings；accountId/windowStartEmailId 垫片带着只为形状完整。
function activeContext(overrides = {}) {
	const bindings = overrides.bindings || [{ bindingId: 8201, accountId: 42, windowStartEmailId: 10 }];
	const primary = bindings[0] || {};
	return {
		shareId: 9,
		bindings,
		messageLimit: null,
		showFullAddress: false,
		accountId: primary.accountId,
		windowStartEmailId: primary.windowStartEmailId,
		expiresAt: '2099-01-01 00:00:00',
		effectiveStatus: 'ACTIVE',
		...overrides
	};
}

function inScopeAttachment(overrides = {}) {
	return {
		attId: 7,
		accountId: 42,
		emailId: 11,
		key: 'attachments/real-hash.pdf',
		filename: 'invoice.pdf',
		mimeType: 'application/pdf',
		...overrides
	};
}

async function expectUnavailable(promise) {
	await expect(promise).rejects.toMatchObject({
		name: 'BizError',
		message: 'SHARE_UNAVAILABLE'
	});
}

describe('normalizeObjectResponse', () => {
	it('normalizes a KV Response to one Response with Cache-Control no-store', async () => {
		const out = normalizeObjectResponse(storageResponse('kv-bytes'));
		expect(out).toBeInstanceOf(Response);
		expect(out.headers.get('Cache-Control')).toBe('no-store');
		expect(out.headers.get('Content-Type')).toBe('application/pdf');
		expect(out.headers.get('Content-Disposition')).toBe('attachment;filename=doc.pdf');
		expect(await out.text()).toBe('kv-bytes');
	});

	it('normalizes an R2Object to one Response with Cache-Control no-store', async () => {
		const out = normalizeObjectResponse(r2Object('r2-bytes'));
		expect(out).toBeInstanceOf(Response);
		expect(out.headers.get('Cache-Control')).toBe('no-store');
		expect(out.headers.get('Content-Type')).toBe('application/pdf');
		expect(out.headers.get('Content-Disposition')).toBe('attachment;filename=doc.pdf');
		expect(await out.text()).toBe('r2-bytes');
	});

	it('normalizes an S3 Response to one Response with Cache-Control no-store', async () => {
		const out = normalizeObjectResponse(storageResponse('s3-bytes', {
			cacheControl: 'public, max-age=3600'
		}));
		expect(out).toBeInstanceOf(Response);
		expect(out.headers.get('Cache-Control')).toBe('no-store');
		expect(await out.text()).toBe('s3-bytes');
	});

	it('returns null when a KV or R2 missing key is null', () => {
		expect(normalizeObjectResponse(null)).toBeNull();
	});
});

describe('readObjectNormalized missing-key cases', () => {
	it('returns null when KV getObj returns null', async () => {
		const out = await readObjectNormalized(async () => null, {}, 'attachments/hash.pdf');
		expect(out).toBeNull();
	});

	it('returns null when R2 getObj returns null', async () => {
		const out = await readObjectNormalized(async () => null, {}, 'attachments/hash.pdf');
		expect(out).toBeNull();
	});

	it('returns null when S3 getObj throws NoSuchKey and does not leak the SDK message', async () => {
		const err = new Error('The specified key does not exist. RequestId: ABCD');
		err.name = 'NoSuchKey';
		err.$metadata = { httpStatusCode: 404 };
		const out = await readObjectNormalized(async () => {
			throw err;
		}, {}, 'attachments/hash.pdf');
		expect(out).toBeNull();
	});
});

describe('shareAttachmentService.download scope', () => {
	it('rejects download when resolveSession says the share is expired or revoked', async () => {
		await expectUnavailable(shareAttachmentService.download({}, {
			sessionToken: 'dead',
			mailId: 11,
			attachmentId: 7
		}, {
			shareAuthService: {
				async resolveSession() {
					throw new BizError('SHARE_UNAVAILABLE');
				}
			}
		}));
	});

	it('rejects download when the share context effectiveStatus is not ACTIVE', async () => {
		const getObj = vi.fn();
		await expectUnavailable(shareAttachmentService.download({}, {
			shareContext: activeContext({ effectiveStatus: 'REVOKED' }),
			mailId: 11,
			attachmentId: 7
		}, {
			findAttachment: async () => inScopeAttachment(),
			getObj,
			shareScopedEmailRepository: {
				getById: async () => ({ emailId: 11, accountId: 42 })
			}
		}));
		expect(getObj).not.toHaveBeenCalled();
	});

	it('still serves a download when the share context is ACCESS_LIMIT_REACHED (AC-SESS-06)', async () => {
		const out = await shareAttachmentService.download({}, {
			shareContext: activeContext({ effectiveStatus: 'ACCESS_LIMIT_REACHED' }),
			mailId: 11,
			attachmentId: 7
		}, {
			findAttachment: async () => inScopeAttachment(),
			getObj: async () => storageResponse('capped-bytes'),
			shareScopedEmailRepository: {
				getById: async () => ({ emailId: 11, accountId: 42 })
			}
		});
		expect(await out.text()).toBe('capped-bytes');
	});

	it('rejects when the attachment account_id does not match the mail that passed the scope check', async () => {
		const getObj = vi.fn();
		await expectUnavailable(shareAttachmentService.download({}, {
			shareContext: activeContext(),
			mailId: 11,
			attachmentId: 7
		}, {
			findAttachment: async () => inScopeAttachment({ accountId: 99 }),
			getObj,
			shareScopedEmailRepository: {
				getById: async () => ({ emailId: 11, accountId: 42 })
			}
		}));
		expect(getObj).not.toHaveBeenCalled();
	});

	it('rejects when the mail is outside the share visible window', async () => {
		const getObj = vi.fn();
		await expectUnavailable(shareAttachmentService.download({}, {
			shareContext: activeContext(),
			mailId: 5,
			attachmentId: 7
		}, {
			findAttachment: async () => inScopeAttachment({ emailId: 5 }),
			getObj,
			shareScopedEmailRepository: {
				getById: async () => null
			}
		}));
		expect(getObj).not.toHaveBeenCalled();
	});

	it('does not treat a client-supplied storage key as authorization', async () => {
		const getObj = vi.fn();
		await expectUnavailable(shareAttachmentService.download({}, {
			shareContext: activeContext(),
			mailId: 11,
			attachmentId: 7,
			key: 'attachments/other-tenant-hash.pdf'
		}, {
			findAttachment: async () => null,
			getObj,
			shareScopedEmailRepository: {
				getById: async () => ({ emailId: 11, accountId: 42 })
			}
		}));
		expect(getObj).not.toHaveBeenCalled();
	});

	it('returns bytes with Cache-Control no-store when the attachment is in scope', async () => {
		const res = await shareAttachmentService.download({}, {
			shareContext: activeContext(),
			mailId: 11,
			attachmentId: 7
		}, {
			findAttachment: async () => inScopeAttachment(),
			getObj: async () => r2Object('file-bytes'),
			shareScopedEmailRepository: {
				getById: async () => ({ emailId: 11, accountId: 42 })
			}
		});
		expect(res).toBeInstanceOf(Response);
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(await res.text()).toBe('file-bytes');
	});

	it('maps a missing object after a scoped hit to SHARE_UNAVAILABLE not a 500', async () => {
		const err = new Error('AccessDenied: secret-bucket');
		err.name = 'NoSuchKey';
		await expectUnavailable(shareAttachmentService.download({}, {
			shareContext: activeContext(),
			mailId: 11,
			attachmentId: 7
		}, {
			findAttachment: async () => inScopeAttachment(),
			getObj: async () => {
				throw err;
			},
			shareScopedEmailRepository: {
				getById: async () => ({ emailId: 11, accountId: 42 })
			}
		}));
	});

	it('scopes the attachment to the mail row instead of the deprecated accountId shim', async () => {
		const findAttachment = vi.fn(async () => inScopeAttachment({ accountId: 77, emailId: 11 }));
		const res = await shareAttachmentService.download({}, {
			shareContext: activeContext({
				bindings: [{ bindingId: 8202, accountId: 77, windowStartEmailId: 0 }],
				accountId: 42,
				windowStartEmailId: 10
			}),
			mailId: 11,
			attachmentId: 7
		}, {
			findAttachment,
			getObj: async () => r2Object('second-binding-bytes'),
			shareScopedEmailRepository: {
				getById: async () => ({ emailId: 11, accountId: 77 })
			}
		});
		expect(await res.text()).toBe('second-binding-bytes');
		expect(findAttachment).toHaveBeenCalledWith(expect.anything(), {
			attId: 7,
			accountId: 77,
			emailId: 11
		});
	});
});

// ── T-11.3 附件可见集：真 scoped repo + 真 D1，不 mock getById ───────────────

const USER_ID = 911201;
const ACCOUNT_A = 911242;
const ACCOUNT_B = 911243;
const ACCOUNT_OTHER = 911244;
const BINDING_A = 8301;
const BINDING_B = 8302;
const WINDOW_A = 911210;
const WINDOW_B = 911230;

const A = { first: 911211, second: 911212, arrived: 911213 };
const B = { first: 911231 };
const POISON = { belowWindowA: 911205, otherShare: 911221 };

const ALL_SEEDED_IDS = [...Object.values(A), ...Object.values(B), ...Object.values(POISON)];

const c = { env };
const attIds = {};

function bindingA(windowStartEmailId = WINDOW_A) {
	return { bindingId: BINDING_A, accountId: ACCOUNT_A, windowStartEmailId };
}

function bindingB(windowStartEmailId = WINDOW_B) {
	return { bindingId: BINDING_B, accountId: ACCOUNT_B, windowStartEmailId };
}

async function ensureAccount(accountId, email) {
	await env.db.prepare('DELETE FROM account WHERE account_id = ? OR email = ?').bind(accountId, email).run();
	await env.db.prepare(`
		INSERT INTO account (account_id, email, name, user_id, is_del)
		VALUES (?, ?, ?, ?, ?)
	`).bind(accountId, email, 't11a', USER_ID, isDel.NORMAL).run();
}

async function insertVisible(emailId, accountId, subject) {
	await env.db.prepare(`
		INSERT INTO email (email_id, account_id, user_id, subject, is_del, status, type, send_email)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		emailId,
		accountId,
		USER_ID,
		subject,
		isDel.NORMAL,
		emailConst.status.RECEIVE,
		emailConst.type.RECEIVE,
		't11a-sender@example.com'
	).run();
}

async function insertAttachment(emailId, accountId, name) {
	const key = `attachments/t11a-${name}.txt`;
	const row = await env.db.prepare(`
		INSERT INTO attachments (user_id, email_id, account_id, key, filename, mime_type, size, type)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING att_id
	`).bind(USER_ID, emailId, accountId, key, `t11a-${name}.txt`, 'text/plain', 11, attConst.type.ATT).first();
	return { attId: row.att_id, key };
}

async function deleteSeeded() {
	const placeholders = ALL_SEEDED_IDS.map(() => '?').join(', ');
	await env.db.prepare("DELETE FROM attachments WHERE key LIKE 'attachments/t11a-%'").run();
	await env.db.prepare(
		`DELETE FROM email WHERE email_id IN (${placeholders}) OR subject LIKE 't11a-%'`
	).bind(...ALL_SEEDED_IDS).run();
	await env.db.prepare('DELETE FROM account WHERE account_id IN (?, ?, ?)')
		.bind(ACCOUNT_A, ACCOUNT_B, ACCOUNT_OTHER).run();
}

describe('shareAttachmentService.download visible set (real scoped repository + D1)', () => {
	beforeAll(async () => {
		await deleteSeeded();
		await ensureAccount(ACCOUNT_A, 'alpha-t11a@example.com');
		await ensureAccount(ACCOUNT_B, 'beta-t11a@example.com');
		await ensureAccount(ACCOUNT_OTHER, 'outsider-t11a@example.com');
		await insertVisible(A.first, ACCOUNT_A, 't11a-a-1');
		await insertVisible(A.second, ACCOUNT_A, 't11a-a-2');
		await insertVisible(B.first, ACCOUNT_B, 't11a-b-1');
		await insertVisible(POISON.belowWindowA, ACCOUNT_A, 't11a-below-window-a');
		await insertVisible(POISON.otherShare, ACCOUNT_OTHER, 't11a-other-share');
		attIds.aFirst = await insertAttachment(A.first, ACCOUNT_A, 'a-first');
		attIds.aSecond = await insertAttachment(A.second, ACCOUNT_A, 'a-second');
		attIds.bFirst = await insertAttachment(B.first, ACCOUNT_B, 'b-first');
		attIds.belowWindow = await insertAttachment(POISON.belowWindowA, ACCOUNT_A, 'below-window');
		attIds.otherShare = await insertAttachment(POISON.otherShare, ACCOUNT_OTHER, 'other-share');
	});

	afterAll(async () => {
		await deleteSeeded();
	});

	function download(ctx, mailId, attachmentId, deps = {}) {
		return shareAttachmentService.download(c, { shareContext: ctx, mailId, attachmentId }, {
			getObj: async () => storageResponse('t11a-bytes', { contentType: 'text/plain' }),
			...deps
		});
	}

	it('serves an attachment that hangs off the second binding, not only bindings[0]', async () => {
		const ctx = activeContext({ bindings: [bindingA(), bindingB()] });

		const fromA = await download(ctx, A.second, attIds.aSecond.attId);
		expect(await fromA.text()).toBe('t11a-bytes');

		const fromB = await download(ctx, B.first, attIds.bFirst.attId);
		expect(fromB).toBeInstanceOf(Response);
		expect(fromB.headers.get('Cache-Control')).toBe('no-store');
		expect(await fromB.text()).toBe('t11a-bytes');
	});

	it('never hands out an /oss/ direct link (AC-SEC-05)', async () => {
		const ctx = activeContext({ bindings: [bindingA(), bindingB()] });
		const res = await download(ctx, B.first, attIds.bFirst.attId);
		const headerBlob = JSON.stringify([...res.headers.entries()]);
		expect(headerBlob).not.toContain('/oss/');
		expect(headerBlob).not.toContain('attachments/t11a-');
		expect(res.headers.get('Location')).toBeNull();
		expect(await res.text()).not.toContain('/oss/');
	});

	it('refuses a mail and attachment below the binding window without probing the attachment', async () => {
		const findAttachment = vi.fn(async () => ({
			attId: attIds.belowWindow.attId,
			accountId: ACCOUNT_A,
			emailId: POISON.belowWindowA,
			key: attIds.belowWindow.key
		}));
		const ctx = activeContext({ bindings: [bindingA(), bindingB()] });

		await expectUnavailable(download(ctx, POISON.belowWindowA, attIds.belowWindow.attId, { findAttachment }));
		expect(findAttachment).not.toHaveBeenCalled();
	});

	it('refuses an attachment whose mail rolled out of messageLimit=1 (AC-MAIL-04, AC-EDGE-06)', async () => {
		const ctx = activeContext({ bindings: [bindingA()], messageLimit: 1 });

		expect(await (await download(ctx, A.second, attIds.aSecond.attId)).text()).toBe('t11a-bytes');
		await expectUnavailable(download(ctx, A.first, attIds.aFirst.attId));

		await insertVisible(A.arrived, ACCOUNT_A, 't11a-a-3');

		await expectUnavailable(download(ctx, A.second, attIds.aSecond.attId));
	});

	it('refuses a tampered mailId, attachmentId or bindingId with no existence leak (AC-MAIL-06, AC-EDGE-08)', async () => {
		const ctx = activeContext({ bindings: [bindingA(), bindingB()] });

		// 他分享的邮件 + 他分享的附件
		await expectUnavailable(download(ctx, POISON.otherShare, attIds.otherShare.attId));
		// 自己可见的邮件 + 他分享的附件 id
		await expectUnavailable(download(ctx, A.second, attIds.otherShare.attId));
		// 他分享的邮件 id + 自己的附件 id
		await expectUnavailable(download(ctx, POISON.otherShare, attIds.aSecond.attId));
		// 自己可见的邮件 + 另一封自己邮件的附件（附件必须挂在该邮件上）
		await expectUnavailable(download(ctx, A.second, attIds.aFirst.attId));
		// bindingId 指向他分享：范围只认 bindings 里的 account
		const tampered = activeContext({
			bindings: [{ bindingId: BINDING_A, accountId: ACCOUNT_OTHER, windowStartEmailId: 0 }]
		});
		await expectUnavailable(download(tampered, A.second, attIds.aSecond.attId));
		await expectUnavailable(download(tampered, B.first, attIds.bFirst.attId));
	});

	it('refuses when the context carries no usable binding at all', async () => {
		for (const ctx of [
			activeContext({ bindings: [] }),
			activeContext({ bindings: [{ bindingId: BINDING_A, accountId: 0, windowStartEmailId: 0 }] })
		]) {
			await expectUnavailable(download(ctx, A.second, attIds.aSecond.attId));
		}
	});
});
