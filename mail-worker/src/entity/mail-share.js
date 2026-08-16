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
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`).notNull()
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
