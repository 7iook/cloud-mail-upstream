import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const mailShare = sqliteTable('mail_share', {
	shareId: integer('share_id').primaryKey({ autoIncrement: true }),
	lid: text('lid').notNull(),
	secHmac: text('sec_hmac').notNull(),
	pepperKid: text('pepper_kid').notNull(),
	userId: integer('user_id').notNull(),
	accountId: integer('account_id').notNull(),
	name: text('name').default('').notNull(),
	remark: text('remark').default('').notNull(),
	status: text('status').default('ACTIVE').notNull(),
	windowStartEmailId: integer('window_start_email_id').default(0).notNull(),
	expiresAt: text('expires_at').notNull(),
	deleteAt: text('delete_at').notNull(),
	accessCount: integer('access_count').default(0).notNull(),
	lastAccessAt: text('last_access_at'),
	revokedAt: text('revoked_at'),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`).notNull(),
	maxSessions: integer('max_sessions'),
	messageLimit: integer('message_limit'),
	onlyMessagesAfterCreated: integer('only_messages_after_created').default(1).notNull(),
	otpExtractionEnabled: integer('otp_extraction_enabled').default(1).notNull(),
	autoRefresh: integer('auto_refresh').default(1).notNull(),
	refreshIntervalMs: integer('refresh_interval_ms').default(3000).notNull(),
	showFullAddress: integer('show_full_address').default(0).notNull(),
	authKeyEnabled: integer('auth_key_enabled').default(0).notNull(),
	authKeyHash: text('auth_key_hash'),
	authKeyKid: text('auth_key_kid'),
	credentialsVersion: integer('credentials_version').default(0).notNull(),
	// 轨一(ADR-share-credential-recoverability):`sec` 的可逆信封与铸造它的 KEK kid。
	// 命名对齐 `sec_hmac` / `pepper_kid` 那一对 —— 同一个 `sec`,两种保存形态,各自带自己的
	// kid。两列可空:本次部署之前建出来的存量行没有密文,读取侧按 ABSENT 处置,那是正常态。
	// AuthKey 刻意没有对应物,`auth_key_hash` 保持不可恢复。
	secCipher: text('sec_cipher'),
	kekKid: text('kek_kid')
});

export const shareIdempotency = sqliteTable('share_idempotency', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id').notNull(),
	idempotencyKey: text('idempotency_key').notNull(),
	operation: text('operation').notNull(),
	requestFingerprint: text('request_fingerprint').notNull(),
	shareId: integer('share_id'),
	responseFingerprint: text('response_fingerprint'),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull()
});
