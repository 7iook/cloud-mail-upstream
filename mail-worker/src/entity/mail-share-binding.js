import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const mailShareBinding = sqliteTable('mail_share_binding', {
	bindingId: integer('binding_id').primaryKey({ autoIncrement: true }),
	shareId: integer('share_id').notNull(),
	accountId: integer('account_id').notNull(),
	windowStartEmailId: integer('window_start_email_id').default(0).notNull(),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`).notNull()
});
