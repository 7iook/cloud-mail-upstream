import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';
import worker from '../src/index.js';
import verifyRecordService from '../src/service/verify-record-service.js';
import userService from '../src/service/user-service.js';
import emailService from '../src/service/email-service.js';
import oauthService from '../src/service/oauth-service.js';

function stamp(offset, unit) {
	return dayjs().add(offset, unit).format('YYYY-MM-DD HH:mm:ss');
}

async function insertShare({ lid, expiresAt, deleteAt }) {
	await env.db.prepare(`
		INSERT INTO mail_share (
			lid, sec_hmac, pepper_kid, user_id, account_id, expires_at, delete_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`).bind(lid, 'hmac', 'kid-1', 1, 1, expiresAt, deleteAt).run();
	return env.db.prepare('SELECT share_id FROM mail_share WHERE lid = ?').bind(lid).first();
}

async function insertIdempotency({ key, createdAt, shareId }) {
	await env.db.prepare(`
		INSERT INTO share_idempotency (
			user_id, idempotency_key, operation, request_fingerprint, share_id, created_at
		) VALUES (?, ?, 'create', 'fp', ?, ?)
	`).bind(1, key, shareId, createdAt).run();
}

async function lids() {
	const rows = await env.db.prepare(
		"SELECT lid FROM mail_share WHERE lid LIKE 't12-%' ORDER BY lid"
	).all();
	return (rows.results || []).map((row) => row.lid);
}

async function idempotencyKeys() {
	const rows = await env.db.prepare(
		"SELECT idempotency_key FROM share_idempotency WHERE idempotency_key LIKE 't12-%' ORDER BY idempotency_key"
	).all();
	return (rows.results || []).map((row) => row.idempotency_key);
}

describe('AC-LIFE-07 scheduled share cleanup', () => {
	afterEach(async () => {
		await env.db.prepare("DELETE FROM mail_share WHERE lid LIKE 't12-%'").run();
		await env.db.prepare("DELETE FROM share_idempotency WHERE idempotency_key LIKE 't12-%'").run();
		vi.restoreAllMocks();
	});

	it('deletes only past delete_at shares and 24h-stale idempotency via the daily cron', async () => {
		const due = await insertShare({
			lid: 't12-due',
			expiresAt: stamp(-2, 'day'),
			deleteAt: stamp(-1, 'hour')
		});
		await insertShare({
			lid: 't12-keep-expired',
			expiresAt: stamp(-1, 'hour'),
			deleteAt: stamp(7, 'day')
		});

		await insertIdempotency({ key: 't12-old', createdAt: stamp(-25, 'hour'), shareId: 900001 });
		await insertIdempotency({ key: 't12-fresh', createdAt: stamp(-23, 'hour'), shareId: 900002 });
		await insertIdempotency({ key: 't12-related-due', createdAt: stamp(-1, 'hour'), shareId: due.share_id });

		const existingJobs = [
			vi.spyOn(verifyRecordService, 'clearRecord'),
			vi.spyOn(userService, 'resetDaySendCount'),
			vi.spyOn(emailService, 'completeReceiveAll'),
			vi.spyOn(oauthService, 'clearNoBindOathUser')
		];

		await worker.scheduled({ cron: '0 16 * * *' }, env, {});

		expect(await lids()).toEqual(['t12-keep-expired']);
		expect(await idempotencyKeys()).toEqual(['t12-fresh']);
		for (const spy of existingJobs) {
			expect(spy).toHaveBeenCalledTimes(1);
		}
	});
});
