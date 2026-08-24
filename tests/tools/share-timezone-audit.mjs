// One-shot audit for mail_share rows whose timestamps were written in the worker
// process local timezone instead of UTC (the pre-fix `dayjs().format(...)` write path).
//
// Fingerprint: mail_share.create_time is supplied by JS, while mail_share_binding.create_time
// falls back to SQLite CURRENT_TIMESTAMP (always UTC) and is inserted in the same db.batch().
// Their delta is therefore the writing process' UTC offset, ~0 for a correct row.
// The create_time/expires_at delta is NOT usable: both come from the same dayjs() call, so the
// offset cancels out and always equals durationSeconds regardless of timezone.
//
// Read-only by default. Pass --fix to shift the affected rows back to UTC.
//   node tests/tools/share-timezone-audit.mjs <db.sqlite> [--fix]

import { DatabaseSync } from 'node:sqlite';

// Below this the delta is clock jitter inside one batch, not a timezone offset.
const OFFSET_THRESHOLD_SECONDS = 600;
const SHIFTED_COLUMNS = ['create_time', 'expires_at', 'delete_at', 'last_access_at', 'revoked_at'];

function loadRows(db) {
	return db.prepare(`
		SELECT ms.share_id, ms.status, ms.create_time, ms.expires_at, ms.delete_at,
			ms.last_access_at, ms.revoked_at,
			MIN(b.create_time) AS binding_create_time,
			CAST(strftime('%s', ms.create_time) AS INTEGER)
				- CAST(strftime('%s', MIN(b.create_time)) AS INTEGER) AS offset_seconds,
			CASE WHEN ms.status = 'ACTIVE' AND ms.expires_at > strftime('%Y-%m-%d %H:%M:%S', 'now')
				THEN 1 ELSE 0 END AS live
		FROM mail_share ms
		JOIN mail_share_binding b ON b.share_id = ms.share_id
		GROUP BY ms.share_id
	`).all();
}

function correct(db, rows) {
	const stmt = db.prepare(`
		UPDATE mail_share SET ${SHIFTED_COLUMNS.map((col) => `${col} = datetime(${col}, ? || ' seconds')`).join(', ')}
		WHERE share_id = ?
	`);
	db.exec('BEGIN');
	try {
		for (const row of rows) {
			const shift = String(-row.offset_seconds);
			stmt.run(...SHIFTED_COLUMNS.map(() => shift), row.share_id);
		}
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
}

function reconcile(db, before, affected) {
	const after = loadRows(db);
	const problems = [];
	if (after.length !== before.length) {
		problems.push(`row count changed: ${before.length} -> ${after.length}`);
	}
	const byId = new Map(after.map((row) => [row.share_id, row]));
	for (const row of affected) {
		const now = byId.get(row.share_id);
		if (!now) {
			problems.push(`share_id ${row.share_id} disappeared`);
			continue;
		}
		if (now.create_time == null || now.expires_at == null || now.delete_at == null) {
			problems.push(`share_id ${row.share_id} has a NULL timestamp after correction`);
		}
		if (!(now.expires_at > now.create_time)) {
			problems.push(`share_id ${row.share_id}: expires_at ${now.expires_at} <= create_time ${now.create_time}`);
		}
		if (Math.abs(now.offset_seconds) > OFFSET_THRESHOLD_SECONDS) {
			problems.push(`share_id ${row.share_id} still offset by ${now.offset_seconds}s`);
		}
	}
	return problems;
}

function main() {
	const [path, ...flags] = process.argv.slice(2);
	if (!path) {
		console.error('usage: node tests/tools/share-timezone-audit.mjs <db.sqlite> [--fix]');
		process.exitCode = 2;
		return;
	}
	const fix = flags.includes('--fix');
	const db = new DatabaseSync(path, { readOnly: !fix });
	try {
		const rows = loadRows(db);
		const affected = rows.filter((row) => Math.abs(row.offset_seconds) > OFFSET_THRESHOLD_SECONDS);
		const live = affected.filter((row) => row.live === 1);
		console.log(`db: ${path}`);
		console.log(`mail_share rows with at least one binding: ${rows.length}`);
		console.log(`offset beyond +-${OFFSET_THRESHOLD_SECONDS}s (local-timezone write): ${affected.length}`);
		console.log(`  of which still live (status=ACTIVE and expires_at > utc now): ${live.length}`);
		for (const row of affected) {
			console.log(`  share_id=${row.share_id} status=${row.status} live=${row.live} offset=${row.offset_seconds}s`
				+ ` create_time=${row.create_time} binding_create_time=${row.binding_create_time} expires_at=${row.expires_at}`);
		}
		if (!fix) {
			console.log(affected.length ? 'read-only: rerun with --fix to correct' : 'read-only: nothing to correct');
			return;
		}
		if (!affected.length) {
			console.log('nothing to correct');
			return;
		}
		correct(db, affected);
		const problems = reconcile(db, rows, affected);
		if (problems.length) {
			console.error('reconciliation FAILED:');
			for (const line of problems) {
				console.error(`  ${line}`);
			}
			process.exitCode = 1;
			return;
		}
		console.log(`corrected ${affected.length} row(s); reconciliation passed`);
	} finally {
		db.close();
	}
}

main();
