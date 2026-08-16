import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { dbInit } from '../src/init/init.js';

async function tableNames(names) {
	const list = names.map((n) => `'${n}'`).join(', ');
	const rows = await env.db.prepare(
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${list}) ORDER BY name`
	).all();
	return (rows.results || []).map((r) => r.name);
}

async function indexExists(name) {
	const row = await env.db.prepare(
		`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`
	).bind(name).first();
	return Boolean(row);
}

describe('v3_1DB mail share migration', () => {
	it('creates mail_share, share_idempotency, and the email polling index', async () => {
		expect(await tableNames(['mail_share', 'share_idempotency'])).toEqual([
			'mail_share',
			'share_idempotency',
		]);
		expect(await indexExists('idx_mail_share_lid')).toBe(true);
		expect(await indexExists('idx_mail_share_user_id_status')).toBe(true);
		expect(await indexExists('idx_mail_share_account_id_status')).toBe(true);
		expect(await indexExists('idx_mail_share_delete_at')).toBe(true);
		expect(await indexExists('idx_share_idempotency_user_key_op')).toBe(true);
		expect(await indexExists('idx_email_account_id_email_id')).toBe(true);

		await env.db.prepare("DELETE FROM mail_share WHERE lid = 'lid-ac-share-01'").run();
		await env.db.prepare(`
			INSERT INTO mail_share (
				lid, sec_hmac, pepper_kid, user_id, account_id, expires_at, delete_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
		`).bind('lid-ac-share-01', 'hmac', 'kid-1', 1, 1, '2099-01-01 00:00:00', '2099-01-02 00:00:00').run();
		const row = await env.db.prepare(
			'SELECT lid, status, access_count FROM mail_share WHERE lid = ?'
		).bind('lid-ac-share-01').first();
		expect(row.lid).toBe('lid-ac-share-01');
		expect(row.status).toBe('ACTIVE');
		expect(row.access_count).toBe(0);
	});

	it('seeds share:manage and binds role 1 on an already-seeded deployment', async () => {
		const { permTotal } = await env.db.prepare('SELECT COUNT(*) as permTotal FROM perm').first();
		const { rolePermCount } = await env.db.prepare('SELECT COUNT(*) as rolePermCount FROM role_perm').first();
		expect(permTotal).toBeGreaterThan(0);
		expect(rolePermCount).toBeGreaterThan(0);

		await env.db.prepare("DELETE FROM role_perm WHERE perm_id = 37 OR perm_id IN (SELECT perm_id FROM perm WHERE perm_key = 'share:manage')").run();
		await env.db.prepare("DELETE FROM perm WHERE perm_id = 37 OR perm_key = 'share:manage'").run();

		const gone = await env.db.prepare("SELECT perm_id FROM perm WHERE perm_key = 'share:manage'").first();
		expect(gone).toBeFalsy();
		await dbInit.v3_1DB({ env });

		const perm = await env.db.prepare(
			"SELECT perm_id, perm_key, type FROM perm WHERE perm_key = 'share:manage'"
		).first();
		expect(perm).toBeTruthy();
		expect(perm.perm_id).toBe(37);
		expect(perm.type).toBe(2);

		const bind = await env.db.prepare(
			'SELECT role_id, perm_id FROM role_perm WHERE role_id = 1 AND perm_id = 37'
		).first();
		expect(bind).toBeTruthy();

		await dbInit.v3_1DB({ env });
		const { permCount } = await env.db.prepare(
			"SELECT COUNT(*) as permCount FROM perm WHERE perm_key = 'share:manage'"
		).first();
		const { bindCount } = await env.db.prepare(
			'SELECT COUNT(*) as bindCount FROM role_perm WHERE role_id = 1 AND perm_id = 37'
		).first();
		expect(permCount).toBe(1);
		expect(bindCount).toBe(1);
	});

	it('binds role 1 to share:manage by key when catalog id 37 is already taken', async () => {
		await env.db.prepare("DELETE FROM role_perm WHERE perm_id = 37 OR perm_id IN (SELECT perm_id FROM perm WHERE perm_key = 'share:manage')").run();
		await env.db.prepare("DELETE FROM perm WHERE perm_id = 37 OR perm_key = 'share:manage'").run();
		await env.db.prepare(`
			INSERT INTO perm (perm_id, name, perm_key, pid, type, sort)
			VALUES (37, 'custom-manage', 'custom:manage', 0, 2, 0)
		`).run();

		const gone = await env.db.prepare("SELECT perm_id FROM perm WHERE perm_key = 'share:manage'").first();
		expect(gone).toBeFalsy();

		await dbInit.v3_1DB({ env });

		const share = await env.db.prepare(
			"SELECT perm_id, perm_key, type FROM perm WHERE perm_key = 'share:manage'"
		).first();
		expect(share).toBeTruthy();
		expect(share.type).toBe(2);
		expect(share.perm_id).not.toBe(37);

		const occupant = await env.db.prepare(
			'SELECT perm_id, perm_key FROM perm WHERE perm_id = 37'
		).first();
		expect(occupant.perm_key).toBe('custom:manage');

		const shareBind = await env.db.prepare(
			'SELECT role_id, perm_id FROM role_perm WHERE role_id = 1 AND perm_id = ?'
		).bind(share.perm_id).first();
		expect(shareBind).toBeTruthy();

		const leaked = await env.db.prepare(
			'SELECT role_id, perm_id FROM role_perm WHERE role_id = 1 AND perm_id = 37'
		).first();
		expect(leaked).toBeFalsy();
	});
});
