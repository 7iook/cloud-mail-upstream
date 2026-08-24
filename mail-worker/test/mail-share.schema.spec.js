import { describe, it, expect } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { mailShare, shareIdempotency } from '../src/entity/mail-share.js';
import { mailShareBinding } from '../src/entity/mail-share-binding.js';

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
			createTime: 'create_time',
			maxSessions: 'max_sessions',
			messageLimit: 'message_limit',
			onlyMessagesAfterCreated: 'only_messages_after_created',
			otpExtractionEnabled: 'otp_extraction_enabled',
			autoRefresh: 'auto_refresh',
			refreshIntervalMs: 'refresh_interval_ms',
			showFullAddress: 'show_full_address',
			authKeyEnabled: 'auth_key_enabled',
			authKeyHash: 'auth_key_hash',
			authKeyKid: 'auth_key_kid',
			credentialsVersion: 'credentials_version'
		});
	});

	it('keeps the legacy columns and never persists share_type (R1-A1 / R1-A2)', () => {
		const cols = getTableColumns(mailShare);
		// access_count 物理列名保留，领域量 used_sessions 的载体
		expect(cols.accessCount.name).toBe('access_count');
		// account_id 保留为 Expand 阶段双写目标；window_start_email_id 保留为迁移遗留只读
		expect(cols.accountId.name).toBe('account_id');
		expect(cols.windowStartEmailId.name).toBe('window_start_email_id');
		// share_type 由 Binding 计数实时派生，落列即双真源
		expect(Object.values(cols).map((col) => col.name)).not.toContain('share_type');
		expect(cols.shareType).toBeUndefined();
	});

	it('defaults the new v3_2DB configuration columns to the design values', () => {
		const cols = getTableColumns(mailShare);
		expect(cols.maxSessions.default).toBeUndefined();
		expect(cols.messageLimit.default).toBeUndefined();
		expect(cols.onlyMessagesAfterCreated.default).toBe(1);
		expect(cols.otpExtractionEnabled.default).toBe(1);
		expect(cols.autoRefresh.default).toBe(1);
		expect(cols.refreshIntervalMs.default).toBe(3000);
		expect(cols.showFullAddress.default).toBe(0);
		expect(cols.authKeyEnabled.default).toBe(0);
		expect(cols.credentialsVersion.default).toBe(0);
	});

	it('marks nullable only the optional lifecycle, quota and auth-key columns', () => {
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
			createTime: true,
			maxSessions: false,
			messageLimit: false,
			onlyMessagesAfterCreated: true,
			otpExtractionEnabled: true,
			autoRefresh: true,
			refreshIntervalMs: true,
			showFullAddress: true,
			authKeyEnabled: true,
			authKeyHash: false,
			authKeyKid: false,
			credentialsVersion: true
		});
	});
});

describe('mail_share_binding drizzle schema (design.md Data Models)', () => {
	it('matches the v3_2DB binding table', () => {
		expect(getTableName(mailShareBinding)).toBe('mail_share_binding');
		expect(columnMap(mailShareBinding)).toEqual({
			bindingId: 'binding_id',
			shareId: 'share_id',
			accountId: 'account_id',
			windowStartEmailId: 'window_start_email_id',
			createTime: 'create_time'
		});
		expect(notNullMap(mailShareBinding)).toEqual({
			bindingId: true,
			shareId: true,
			accountId: true,
			windowStartEmailId: true,
			createTime: true
		});
		const cols = getTableColumns(mailShareBinding);
		expect(cols.bindingId.primary).toBe(true);
		expect(cols.windowStartEmailId.default).toBe(0);
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
