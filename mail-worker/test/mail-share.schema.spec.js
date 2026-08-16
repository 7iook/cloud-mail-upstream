import { describe, it, expect } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { mailShare, shareIdempotency } from '../src/entity/mail-share.js';

function columnMap(table) {
	return Object.fromEntries(
		Object.entries(getTableColumns(table)).map(([prop, col]) => [prop, col.name])
	);
}

function notNullMap(table) {
	return Object.fromEntries(
		Object.entries(getTableColumns(table)).map(([prop, col]) => [prop, col.notNull])
	);
}

describe('mail_share drizzle schema (design.md Data Models)', () => {
	it('maps snake_case columns to camelCase properties', () => {
		expect(getTableName(mailShare)).toBe('mail_share');
		expect(columnMap(mailShare)).toEqual({
			shareId: 'share_id',
			lid: 'lid',
			secHmac: 'sec_hmac',
			pepperKid: 'pepper_kid',
			userId: 'user_id',
			accountId: 'account_id',
			name: 'name',
			remark: 'remark',
			status: 'status',
			windowStartEmailId: 'window_start_email_id',
			expiresAt: 'expires_at',
			deleteAt: 'delete_at',
			accessCount: 'access_count',
			lastAccessAt: 'last_access_at',
			revokedAt: 'revoked_at',
			createTime: 'create_time'
		});
	});

	it('marks nullable only last_access_at and revoked_at', () => {
		expect(notNullMap(mailShare)).toEqual({
			shareId: true,
			lid: true,
			secHmac: true,
			pepperKid: true,
			userId: true,
			accountId: true,
			name: true,
			remark: true,
			status: true,
			windowStartEmailId: true,
			expiresAt: true,
			deleteAt: true,
			accessCount: true,
			lastAccessAt: false,
			revokedAt: false,
			createTime: true
		});
	});
});

describe('share_idempotency drizzle schema (design.md Data Models)', () => {
	it('matches v3_1DB columns including surrogate id and nullable fingerprints', () => {
		expect(getTableName(shareIdempotency)).toBe('share_idempotency');
		expect(columnMap(shareIdempotency)).toEqual({
			id: 'id',
			userId: 'user_id',
			idempotencyKey: 'idempotency_key',
			operation: 'operation',
			requestFingerprint: 'request_fingerprint',
			shareId: 'share_id',
			responseFingerprint: 'response_fingerprint',
			createdAt: 'created_at'
		});
		const cols = getTableColumns(shareIdempotency);
		expect(cols.id.primary).toBe(true);
		expect(cols.userId.notNull).toBe(true);
		expect(cols.idempotencyKey.notNull).toBe(true);
		expect(cols.operation.notNull).toBe(true);
		expect(cols.requestFingerprint.notNull).toBe(true);
		expect(cols.shareId.notNull).toBe(false);
		expect(cols.responseFingerprint.notNull).toBe(false);
		expect(cols.createdAt.notNull).toBe(true);
	});
});
