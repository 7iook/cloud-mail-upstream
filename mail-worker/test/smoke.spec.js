import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('mail-worker entry', () => {
	it('routes /api/* into Hono and rejects a wrong init secret', async () => {
		const response = await SELF.fetch('http://example.com/api/init/not-the-secret');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('\u274c JWT secret mismatch');
	});

	it('has isolated local D1 with email and account tables', async () => {
		const tables = await env.db.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('email', 'account') ORDER BY name"
		).all();
		const names = (tables.results || []).map((row) => row.name);
		expect(names).toEqual(['account', 'email']);

		await env.db.prepare(
			'INSERT INTO account (email, user_id) VALUES (?, ?)'
		).bind('vitest-local@example.com', 1).run();
		const row = await env.db.prepare(
			'SELECT email FROM account WHERE email = ?'
		).bind('vitest-local@example.com').first();
		expect(row.email).toBe('vitest-local@example.com');
	});
});
