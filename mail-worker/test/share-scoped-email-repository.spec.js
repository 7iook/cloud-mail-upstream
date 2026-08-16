import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emailConst, isDel } from '../src/const/entity-const';
import shareScopedEmailRepository from '../src/service/share-scoped-email-repository';

const ACCOUNT_ID = 900042;
const OTHER_ACCOUNT_ID = 900043;
const USER_ID = 900001;
const WINDOW_START = 900010;

const VISIBLE = {
	first: 900011,
	second: 900012,
	third: 900013
};

const POISON = {
	orphanAccountZero: 900020,
	belowWindow: 900005,
	otherAccount: 900021,
	savingDeleted: 900022,
	savingNormal: 900023,
	userDeleted: 900024
};

const ALL_SEEDED_IDS = [
	VISIBLE.first,
	VISIBLE.second,
	VISIBLE.third,
	POISON.orphanAccountZero,
	POISON.belowWindow,
	POISON.otherAccount,
	POISON.savingDeleted,
	POISON.savingNormal,
	POISON.userDeleted,
	900014
];

const c = { env };

function shareContext(overrides = {}) {
	return {
		shareId: 900009,
		accountId: ACCOUNT_ID,
		windowStartEmailId: WINDOW_START,
		expiresAt: '2099-01-01 00:00:00',
		effectiveStatus: 'ACTIVE',
		...overrides
	};
}

async function insertEmail({ emailId, accountId, isDelValue, status, subject }) {
	await env.db.prepare(`
		INSERT INTO email (email_id, account_id, user_id, subject, is_del, status, type, send_email)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		emailId,
		accountId,
		USER_ID,
		subject,
		isDelValue,
		status,
		emailConst.type.RECEIVE,
		't06-scope@example.com'
	).run();
}

async function deleteSeeded() {
	const placeholders = ALL_SEEDED_IDS.map(() => '?').join(', ');
	await env.db.prepare(
		`DELETE FROM email WHERE email_id IN (${placeholders}) OR subject LIKE 't06-scope-%'`
	).bind(...ALL_SEEDED_IDS).run();
}

describe('shareScopedEmailRepository', () => {
	beforeAll(async () => {
		await deleteSeeded();
		await insertEmail({
			emailId: VISIBLE.first,
			accountId: ACCOUNT_ID,
			isDelValue: isDel.NORMAL,
			status: emailConst.status.RECEIVE,
			subject: 't06-scope-visible-1'
		});
		await insertEmail({
			emailId: VISIBLE.second,
			accountId: ACCOUNT_ID,
			isDelValue: isDel.NORMAL,
			status: emailConst.status.RECEIVE,
			subject: 't06-scope-visible-2'
		});
		await insertEmail({
			emailId: VISIBLE.third,
			accountId: ACCOUNT_ID,
			isDelValue: isDel.NORMAL,
			status: emailConst.status.RECEIVE,
			subject: 't06-scope-visible-3'
		});
		await insertEmail({
			emailId: POISON.orphanAccountZero,
			accountId: 0,
			isDelValue: isDel.NORMAL,
			status: emailConst.status.RECEIVE,
			subject: 't06-scope-orphan-account-0'
		});
		await insertEmail({
			emailId: POISON.belowWindow,
			accountId: ACCOUNT_ID,
			isDelValue: isDel.NORMAL,
			status: emailConst.status.RECEIVE,
			subject: 't06-scope-below-window'
		});
		await insertEmail({
			emailId: POISON.otherAccount,
			accountId: OTHER_ACCOUNT_ID,
			isDelValue: isDel.NORMAL,
			status: emailConst.status.RECEIVE,
			subject: 't06-scope-other-account'
		});
		await insertEmail({
			emailId: POISON.savingDeleted,
			accountId: ACCOUNT_ID,
			isDelValue: isDel.DELETE,
			status: emailConst.status.SAVING,
			subject: 't06-scope-saving-deleted'
		});
		await insertEmail({
			emailId: POISON.savingNormal,
			accountId: ACCOUNT_ID,
			isDelValue: isDel.NORMAL,
			status: emailConst.status.SAVING,
			subject: 't06-scope-saving-normal'
		});
		await insertEmail({
			emailId: POISON.userDeleted,
			accountId: ACCOUNT_ID,
			isDelValue: isDel.DELETE,
			status: emailConst.status.RECEIVE,
			subject: 't06-scope-user-deleted'
		});
	});

	afterAll(async () => {
		await deleteSeeded();
	});

	it('list does not return orphan, mid-write, below-window, or other-account rows (P-SCOPE-01)', async () => {
		const ctx = shareContext();
		const rows = await shareScopedEmailRepository.list(c, ctx, null, 100);
		const ids = rows.map((row) => row.emailId);

		expect(ids).not.toContain(POISON.orphanAccountZero);
		expect(ids).not.toContain(POISON.belowWindow);
		expect(ids).not.toContain(POISON.otherAccount);
		expect(ids).not.toContain(POISON.savingDeleted);
		expect(ids).not.toContain(POISON.savingNormal);
		expect(ids).not.toContain(POISON.userDeleted);
		expect(ids).toEqual([VISIBLE.first, VISIBLE.second, VISIBLE.third]);
	});

	it('getById returns null for every out-of-scope id and the in-scope row otherwise (AC-VISIT-09)', async () => {
		const ctx = shareContext();

		expect(await shareScopedEmailRepository.getById(c, ctx, POISON.orphanAccountZero)).toBeNull();
		expect(await shareScopedEmailRepository.getById(c, ctx, POISON.belowWindow)).toBeNull();
		expect(await shareScopedEmailRepository.getById(c, ctx, POISON.otherAccount)).toBeNull();
		expect(await shareScopedEmailRepository.getById(c, ctx, POISON.savingDeleted)).toBeNull();
		expect(await shareScopedEmailRepository.getById(c, ctx, POISON.savingNormal)).toBeNull();
		expect(await shareScopedEmailRepository.getById(c, ctx, POISON.userDeleted)).toBeNull();
		expect(await shareScopedEmailRepository.getById(c, ctx, 999999)).toBeNull();

		const visible = await shareScopedEmailRepository.getById(c, ctx, VISIBLE.first);
		expect(visible).toMatchObject({
			emailId: VISIBLE.first,
			accountId: ACCOUNT_ID
		});
	});

	it('refuses to retrieve rows when ctx.accountId is 0', async () => {
		const ctx = shareContext({ accountId: 0 });
		const rows = await shareScopedEmailRepository.list(c, ctx, null, 100);
		expect(rows).toEqual([]);
		expect(await shareScopedEmailRepository.getById(c, ctx, POISON.orphanAccountZero)).toBeNull();
		expect(await shareScopedEmailRepository.getById(c, ctx, VISIBLE.first)).toBeNull();
	});

	it('same cursor re-read does not duplicate or skip, and may grow when new mail arrives (AC-RT-09)', async () => {
		const ctx = shareContext();
		const cursor = VISIBLE.first;

		const first = await shareScopedEmailRepository.list(c, ctx, cursor, 50);
		const firstIds = first.map((row) => row.emailId);
		expect(firstIds).toEqual([VISIBLE.second, VISIBLE.third]);

		const second = await shareScopedEmailRepository.list(c, ctx, cursor, 50);
		expect(second.map((row) => row.emailId)).toEqual(firstIds);

		await insertEmail({
			emailId: 900014,
			accountId: ACCOUNT_ID,
			isDelValue: isDel.NORMAL,
			status: emailConst.status.RECEIVE,
			subject: 't06-scope-visible-4'
		});
		const third = await shareScopedEmailRepository.list(c, ctx, cursor, 50);
		const thirdIds = third.map((row) => row.emailId);
		expect(thirdIds).toEqual([VISIBLE.second, VISIBLE.third, 900014]);
		expect(new Set(thirdIds).size).toBe(thirdIds.length);

		let walkCursor = WINDOW_START;
		const walked = [];
		for (let i = 0; i < 8; i++) {
			const page = await shareScopedEmailRepository.list(c, ctx, walkCursor, 1);
			if (page.length === 0) {
				break;
			}
			walked.push(page[0].emailId);
			walkCursor = page[0].emailId;
		}
		expect(walked).toEqual([VISIBLE.first, VISIBLE.second, VISIBLE.third, 900014]);
	});
});
