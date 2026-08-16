import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import orm from '../src/entity/orm.js';

const PROBE = 'd1_tx_probe';
const PROBE_EMAIL = 'd1_tx_probe_email';

function db() {
	return orm({ env });
}

async function countMarker(marker) {
	const row = await env.db.prepare(
		`SELECT COUNT(*) AS n FROM ${PROBE} WHERE marker = ?`
	).bind(marker).first();
	return row.n;
}

async function probeRow(marker) {
	return env.db.prepare(
		`SELECT id, marker, owner_id, window_start, status FROM ${PROBE} WHERE marker = ?`
	).bind(marker).first();
}

beforeAll(async () => {
	await env.db.prepare(`
		CREATE TABLE IF NOT EXISTS ${PROBE} (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			marker TEXT NOT NULL,
			owner_id INTEGER NOT NULL DEFAULT 0,
			window_start INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'ACTIVE'
		)
	`).run();
	await env.db.prepare(`
		CREATE TABLE IF NOT EXISTS ${PROBE_EMAIL} (
			email_id INTEGER PRIMARY KEY AUTOINCREMENT,
			account_id INTEGER NOT NULL
		)
	`).run();
});

const BEGIN_TX_RE = /BEGIN TRANSACTION|SAVEPOINT|state\.storage\.transaction/i;

describe('D1 drizzle .transaction() is unusable (T-02 / AC-SHARE-15)', () => {
	it('rejects SQL BEGIN before the callback runs', async () => {
		let sawCallback = false;
		let thrown;
		try {
			await db().transaction(async () => {
				sawCallback = true;
			});
		} catch (err) {
			thrown = err;
		}

		expect(sawCallback).toBe(false);
		expect(thrown).toBeTruthy();
		expect(String(thrown.message || thrown)).toMatch(BEGIN_TX_RE);
	});

	it('leaves no orphan row after insert then a later failure (batch rollback)', async () => {
		const marker = 't02-orphan-rollback';
		await env.db.prepare(`DELETE FROM ${PROBE} WHERE marker = ?`).bind(marker).run();

		let thrown;
		try {
			await env.db.batch([
				env.db.prepare(`INSERT INTO ${PROBE} (marker) VALUES (?)`).bind(marker),
				env.db.prepare('SELECT * FROM d1_tx_probe_does_not_exist'),
			]);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeTruthy();
		expect(String(thrown.message || thrown)).toMatch(/no such table|D1_ERROR/i);
		expect(await countMarker(marker)).toBe(0);
	});
});

describe('conditional UPDATE applied vs not-applied (AC-SHARE-12 shape)', () => {
	it('RETURNING and meta.changes distinguish applied from not applied', async () => {
		const marker = 't02-cond-update';
		await env.db.prepare(`DELETE FROM ${PROBE} WHERE marker = ?`).bind(marker).run();
		await env.db.prepare(
			`INSERT INTO ${PROBE} (marker, status) VALUES (?, 'ACTIVE')`
		).bind(marker).run();

		const applied = await env.db.prepare(
			`UPDATE ${PROBE} SET status = 'REVOKED' WHERE marker = ? AND status = 'ACTIVE' RETURNING id, status`
		).bind(marker).all();
		expect(applied.success).toBe(true);
		expect(applied.meta.changes).toBe(1);
		expect(applied.results).toHaveLength(1);
		expect(applied.results[0].status).toBe('REVOKED');

		const skipped = await env.db.prepare(
			`UPDATE ${PROBE} SET status = 'REVOKED' WHERE marker = ? AND status = 'ACTIVE' RETURNING id, status`
		).bind(marker).all();
		expect(skipped.success).toBe(true);
		expect(skipped.meta.changes).toBe(0);
		expect(skipped.results).toHaveLength(0);
	});
});

describe('window snapshot MAX + INSERT (AC-SHARE-06)', () => {
	it('single-statement INSERT...SELECT MAX is atomic and returns the snapshot', async () => {
		const accountId = 90206;
		const marker = 't02-window-single';
		await env.db.prepare(`DELETE FROM ${PROBE_EMAIL} WHERE account_id = ?`).bind(accountId).run();
		await env.db.prepare(`DELETE FROM ${PROBE} WHERE marker = ?`).bind(marker).run();
		await env.db.prepare(
			`INSERT INTO ${PROBE_EMAIL} (account_id) VALUES (?), (?), (?)`
		).bind(accountId, accountId, accountId).run();

		const maxRow = await env.db.prepare(
			`SELECT MAX(email_id) AS m FROM ${PROBE_EMAIL} WHERE account_id = ?`
		).bind(accountId).first();

		const inserted = await env.db.prepare(`
			INSERT INTO ${PROBE} (marker, owner_id, window_start)
			SELECT ?, ?, COALESCE(MAX(email_id), 0)
			FROM ${PROBE_EMAIL}
			WHERE account_id = ?
			RETURNING id, window_start
		`).bind(marker, accountId, accountId).first();

		expect(inserted.window_start).toBe(maxRow.m);
		expect((await probeRow(marker)).window_start).toBe(maxRow.m);
	});

	it('cannot host SELECT MAX then INSERT: drizzle.transaction() dies on BEGIN', async () => {
		let sawCallback = false;
		let thrown;
		try {
			await db().transaction(async () => {
				sawCallback = true;
			});
		} catch (err) {
			thrown = err;
		}

		expect(sawCallback).toBe(false);
		expect(String(thrown.message || thrown)).toMatch(BEGIN_TX_RE);
	});
});

describe('atomic active-share limit (AC-SHARE-12)', () => {
	it('conditional INSERT...SELECT COUNT distinguishes applied from limit-hit', async () => {
		const ownerId = 91212;
		await env.db.prepare(`DELETE FROM ${PROBE} WHERE owner_id = ?`).bind(ownerId).run();
		const limit = 2;

		async function tryCreate(marker) {
			return env.db.prepare(`
				INSERT INTO ${PROBE} (marker, owner_id, status)
				SELECT ?, ?, 'ACTIVE'
				WHERE (
					SELECT COUNT(*) FROM ${PROBE}
					WHERE owner_id = ? AND status = 'ACTIVE'
				) < ?
				RETURNING id, marker
			`).bind(marker, ownerId, ownerId, limit).all();
		}

		const first = await tryCreate('t02-limit-1');
		const second = await tryCreate('t02-limit-2');
		const third = await tryCreate('t02-limit-3');

		expect(first.meta.changes).toBe(1);
		expect(first.results).toHaveLength(1);
		expect(second.meta.changes).toBe(1);
		expect(third.meta.changes).toBe(0);
		expect(third.results).toHaveLength(0);

		const { n } = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM ${PROBE} WHERE owner_id = ? AND status = 'ACTIVE'`
		).bind(ownerId).first();
		expect(n).toBe(2);
	});
});

describe('D1 batch() fallback (AC-SHARE-15 without interactive tx)', () => {
	it('rolls back earlier statements when a later statement fails', async () => {
		const marker = 't02-batch-orphan';
		await env.db.prepare(`DELETE FROM ${PROBE} WHERE marker = ?`).bind(marker).run();

		let thrown;
		try {
			await env.db.batch([
				env.db.prepare(`INSERT INTO ${PROBE} (marker) VALUES (?)`).bind(marker),
				env.db.prepare('SELECT * FROM d1_tx_probe_does_not_exist'),
			]);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeTruthy();
		expect(String(thrown.message || thrown)).toMatch(/no such table|D1_ERROR/i);
		expect(await countMarker(marker)).toBe(0);
	});

	it('cannot bind a later statement to an earlier statement result', async () => {
		const accountId = 90216;
		const marker = 't02-batch-no-result-ref';
		await env.db.prepare(`DELETE FROM ${PROBE_EMAIL} WHERE account_id = ?`).bind(accountId).run();
		await env.db.prepare(`DELETE FROM ${PROBE} WHERE marker = ?`).bind(marker).run();
		await env.db.prepare(
			`INSERT INTO ${PROBE_EMAIL} (account_id) VALUES (?), (?)`
		).bind(accountId, accountId).run();

		const maxRow = await env.db.prepare(
			`SELECT MAX(email_id) AS m FROM ${PROBE_EMAIL} WHERE account_id = ?`
		).bind(accountId).first();

		const batchResult = await env.db.batch([
			env.db.prepare(
				`SELECT MAX(email_id) AS m FROM ${PROBE_EMAIL} WHERE account_id = ?`
			).bind(accountId),
			env.db.prepare(
				`INSERT INTO ${PROBE} (marker, window_start) VALUES (?, ?) RETURNING window_start`
			).bind(marker, 0),
		]);

		expect(batchResult[0].results[0].m).toBe(maxRow.m);
		expect(batchResult[1].results[0].window_start).toBe(0);
		expect(batchResult[1].results[0].window_start).not.toBe(maxRow.m);
	});
});

describe('surprises worth writing down', () => {
	it('nested SAVEPOINT is unreachable because outer BEGIN is rejected', async () => {
		let sawCallback = false;
		let thrown;
		try {
			await db().transaction(async (tx) => {
				sawCallback = true;
				await tx.transaction(async () => {});
			});
		} catch (err) {
			thrown = err;
		}

		expect(sawCallback).toBe(false);
		expect(String(thrown.message || thrown)).toMatch(BEGIN_TX_RE);
	});

	it('raw BEGIN is rejected on this Miniflare D1 with the same D1_ERROR', async () => {
		let thrown;
		try {
			await env.db.prepare('BEGIN').run();
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeTruthy();
		expect(String(thrown.message || thrown)).toMatch(BEGIN_TX_RE);
	});
});
