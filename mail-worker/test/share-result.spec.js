import { describe, it, expect } from 'vitest';
import result from '../src/model/result.js';
import shareResult from '../src/model/share-result.js';

describe('shareResult.ok does not swallow falsy data (Decision 7)', () => {
	it('keeps 0, false, and empty string; only undefined becomes null', () => {
		expect(shareResult.ok(0)).toEqual({ code: 200, message: 'success', data: 0 });
		expect(shareResult.ok(false)).toEqual({ code: 200, message: 'success', data: false });
		expect(shareResult.ok('')).toEqual({ code: 200, message: 'success', data: '' });
		expect(shareResult.ok(null)).toEqual({ code: 200, message: 'success', data: null });
		expect(shareResult.ok(undefined)).toEqual({ code: 200, message: 'success', data: null });
		expect(shareResult.ok()).toEqual({ code: 200, message: 'success', data: null });

		const payload = { accessCount: 0, code: '', idempotentReplay: false };
		expect(shareResult.ok(payload)).toEqual({
			code: 200,
			message: 'success',
			data: payload
		});
	});

	it('keeps the frontend envelope shape { code, message, data }', () => {
		const wrapped = shareResult.ok({ lid: 'x' });
		expect(Object.keys(wrapped)).toEqual(['code', 'message', 'data']);
		expect(wrapped.code).toBe(200);
		expect(wrapped.message).toBe('success');
	});

	it('documents why shareResult exists: result.ok swallows 0 / false / empty string', () => {
		expect(result.ok(0).data).toBeNull();
		expect(result.ok(false).data).toBeNull();
		expect(result.ok('').data).toBeNull();
	});

	it('fail matches result.fail envelope and accepts string business codes', () => {
		expect(shareResult.fail('gone', 'SHARE_UNAVAILABLE')).toEqual({
			code: 'SHARE_UNAVAILABLE',
			message: 'gone'
		});
	});
});
