import { describe, it, expect, vi } from 'vitest';
import shareAttachmentService, {
	normalizeObjectResponse,
	readObjectNormalized
} from '../src/service/share-attachment-service';
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

function activeContext(overrides = {}) {
	return {
		shareId: 9,
		accountId: 42,
		windowStartEmailId: 10,
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

	it('rejects when the attachment account_id does not match the share context', async () => {
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
});
