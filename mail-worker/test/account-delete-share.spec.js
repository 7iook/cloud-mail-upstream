import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { emailConst, isDel } from '../src/const/entity-const';
import { t } from '../src/i18n/i18n';
import shareResult from '../src/model/share-result';
import accountService from '../src/service/account-service';
import mailShareService from '../src/service/mail-share-service';
import shareAuthService from '../src/service/share-auth-service';
import shareMailService from '../src/service/share-mail-service';

const PEPPER = 't13-pepper-v1-fixed-test-value';
const SIGN = 't13-session-sign-v1-fixed-test-value';
const USER_A = 913001;
const USER_B = 913002;
const PRIMARY_A = 913101;
const BOX_A = 913102;
const BOX_B = 913103;
const MAIL_PRIMARY = 't13-owner@example.com';
const MAIL_BOX = 't13-box@example.com';
const MAIL_OTHER = 't13-other@example.com';
const UNAVAILABLE = JSON.stringify(shareResult.fail('SHARE_UNAVAILABLE', 501));

function shareEnv(overrides = {}) {
	return {
		...env,
		SHARE_SEC_PEPPER: PEPPER,
		SHARE_SEC_PEPPER_KID: 'v1',
		SHARE_SESSION_SIGNING_KEY: SIGN,
		SHARE_SESSION_SIGNING_KID: 'v1',
		SHARE_SESSION_TTL: '900',
		SHARE_ENABLED: '1',
		SHARE_ACTIVE_LIMIT: '20',
		SHARE_MAX_DURATION_SECONDS: '86400',
		SHARE_RETENTION_SECONDS: '604800',
		SHARE_PUBLIC_ORIGIN: 'https://mail.example.com',
		...overrides
	};
}

function ctx(overrides = {}) {
	return { env: shareEnv(overrides) };
}

async function catchFail(promise) {
	try {
		await promise;
	} catch (err) {
		return JSON.stringify(shareResult.fail(err.message, err.code));
	}
	throw new Error('expected SHARE_UNAVAILABLE');
}

async function catchBiz(promise) {
	try {
		await promise;
	} catch (err) {
		if (err && err.name === 'BizError') {
			return err.message;
		}
		throw err;
	}
	throw new Error('expected BizError');
}

async function ensureUser(userId, email) {
	await env.db.prepare('DELETE FROM user WHERE user_id = ? OR email = ?').bind(userId, email).run();
	await env.db.prepare(`
		INSERT INTO user (user_id, email, type, password, salt, status, is_del)
		VALUES (?, ?, 1, 'x', 'x', 0, 0)
	`).bind(userId, email).run();
}

async function ensureAccount(accountId, email, userId) {
	await env.db.prepare('DELETE FROM account WHERE account_id = ? OR email = ?').bind(accountId, email).run();
	await env.db.prepare(`
		INSERT INTO account (account_id, email, name, user_id, is_del)
		VALUES (?, ?, ?, ?, ?)
	`).bind(accountId, email, 't13', userId, isDel.NORMAL).run();
}

async function insertEmail(accountId, userId, subject) {
	const row = await env.db.prepare(`
		INSERT INTO email (account_id, user_id, subject, is_del, status, type, send_email)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		RETURNING email_id
	`).bind(
		accountId,
		userId,
		subject,
		isDel.NORMAL,
		emailConst.status.RECEIVE,
		emailConst.type.RECEIVE,
		't13-sender@example.com'
	).first();
	return row.email_id;
}

async function seedMailbox() {
	await ensureUser(USER_A, MAIL_PRIMARY);
	await ensureUser(USER_B, MAIL_OTHER);
	await ensureAccount(PRIMARY_A, MAIL_PRIMARY, USER_A);
	await ensureAccount(BOX_A, MAIL_BOX, USER_A);
	await ensureAccount(BOX_B, MAIL_OTHER, USER_B);
}

async function cleanup() {
	await env.db.prepare('DELETE FROM share_idempotency WHERE user_id IN (?, ?)').bind(USER_A, USER_B).run();
	await env.db.prepare('DELETE FROM mail_share WHERE user_id IN (?, ?)').bind(USER_A, USER_B).run();
	await env.db.prepare('DELETE FROM email WHERE user_id IN (?, ?) OR subject LIKE ?').bind(USER_A, USER_B, 't13-%').run();
	await env.db.prepare('DELETE FROM account WHERE account_id IN (?, ?, ?) OR email LIKE ?')
		.bind(PRIMARY_A, BOX_A, BOX_B, 't13-%@example.com').run();
	await env.db.prepare('DELETE FROM user WHERE user_id IN (?, ?) OR email LIKE ?')
		.bind(USER_A, USER_B, 't13-%@example.com').run();
}

afterEach(async () => {
	await cleanup();
});

async function openShare(accountId, userId, name) {
	const c = ctx();
	const created = await mailShareService.create(c, {
		accountId,
		durationSeconds: 3600,
		name,
		remark: 't13'
	}, userId);
	const session = await shareAuthService.establishSession(c, created.lid, created.sec);
	const shareCtx = await shareAuthService.resolveSession(c, session.sessionToken);
	return { c, created, session, shareCtx };
}

async function readShareRow(shareId) {
	return env.db.prepare(
		'SELECT status, revoked_at, account_id FROM mail_share WHERE share_id = ?'
	).bind(shareId).first();
}

describe('account delete revokes mailbox shares (AC-LIFE-09, AC-LIFE-12 delete path)', () => {
	it('soft-deletes a mailbox, then the visitor cannot read and the share row is revoked', async () => {
		await seedMailbox();
		const live = await openShare(BOX_A, USER_A, 'soft-box');
		const other = await openShare(BOX_B, USER_B, 'other-box');
		const mailId = await insertEmail(BOX_A, USER_A, 't13-otp-soft');
		const mails = await shareMailService.list(live.c, live.shareCtx, null, 20);
		expect(mails.map((row) => row.mailId)).toContain(mailId);

		await accountService.delete(live.c, { accountId: BOX_A }, USER_A);

		const after = await catchFail(shareAuthService.resolveSession(live.c, live.session.sessionToken));
		const neverExisted = await catchFail(shareAuthService.establishSession(live.c, 'missing-lid', 'missing-sec'));
		expect(after).toBe(UNAVAILABLE);
		expect(after).toBe(neverExisted);

		const row = await readShareRow(live.created.shareId);
		expect(row.status).toBe('REVOKED');
		expect(row.revoked_at).toEqual(expect.any(String));

		const otherRow = await readShareRow(other.created.shareId);
		expect(otherRow.status).toBe('ACTIVE');
		expect(otherRow.revoked_at).toBeNull();
		const otherStill = await shareAuthService.resolveSession(other.c, other.session.sessionToken);
		expect(otherStill.accountId).toBe(BOX_B);

		const accountRow = await env.db.prepare(
			'SELECT is_del FROM account WHERE account_id = ?'
		).bind(BOX_A).first();
		expect(accountRow.is_del).toBe(isDel.DELETE);
		const { n } = await env.db.prepare(
			'SELECT COUNT(*) AS n FROM email WHERE email_id = ?'
		).bind(mailId).first();
		expect(n).toBe(1);
	});

	it('keeps the share revoked after the mailbox is restored (AC-LIFE-09)', async () => {
		await seedMailbox();
		const live = await openShare(BOX_A, USER_A, 'restore-box');
		await accountService.delete(live.c, { accountId: BOX_A }, USER_A);
		await accountService.restoreByEmail(live.c, MAIL_BOX);

		const restored = await env.db.prepare(
			'SELECT is_del FROM account WHERE account_id = ?'
		).bind(BOX_A).first();
		expect(restored.is_del).toBe(isDel.NORMAL);

		const after = await catchFail(shareAuthService.resolveSession(live.c, live.session.sessionToken));
		expect(after).toBe(UNAVAILABLE);
		const row = await readShareRow(live.created.shareId);
		expect(row.status).toBe('REVOKED');
		expect(row.revoked_at).toEqual(expect.any(String));
	});

	it('hard-deletes a mailbox, then the visitor cannot read and the share row is revoked', async () => {
		await seedMailbox();
		const live = await openShare(BOX_A, USER_A, 'hard-box');
		const other = await openShare(BOX_B, USER_B, 'other-hard');
		const mailId = await insertEmail(BOX_A, USER_A, 't13-otp-hard');
		const mails = await shareMailService.list(live.c, live.shareCtx, null, 20);
		expect(mails.map((row) => row.mailId)).toContain(mailId);

		await accountService.physicsDelete(live.c, { accountId: BOX_A });

		const after = await catchFail(shareAuthService.resolveSession(live.c, live.session.sessionToken));
		const neverExisted = await catchFail(shareAuthService.establishSession(live.c, 'missing-lid', 'missing-sec'));
		expect(after).toBe(UNAVAILABLE);
		expect(after).toBe(neverExisted);

		const row = await readShareRow(live.created.shareId);
		expect(row.status).toBe('REVOKED');
		expect(row.revoked_at).toEqual(expect.any(String));

		const gone = await env.db.prepare(
			'SELECT account_id FROM account WHERE account_id = ?'
		).bind(BOX_A).first();
		expect(gone).toBeNull();
		const { n } = await env.db.prepare(
			'SELECT COUNT(*) AS n FROM email WHERE email_id = ?'
		).bind(mailId).first();
		expect(n).toBe(0);

		const otherRow = await readShareRow(other.created.shareId);
		expect(otherRow.status).toBe('ACTIVE');
		const otherStill = await shareAuthService.resolveSession(other.c, other.session.sessionToken);
		expect(otherStill.accountId).toBe(BOX_B);
	});

	it('revokes every active share of accounts removed with the user (AC-LIFE-09)', async () => {
		await seedMailbox();
		const primaryShare = await openShare(PRIMARY_A, USER_A, 'primary');
		const boxShare = await openShare(BOX_A, USER_A, 'box');
		const other = await openShare(BOX_B, USER_B, 'keep');

		await accountService.physicsDeleteByUserIds(primaryShare.c, [USER_A]);

		expect(await catchFail(shareAuthService.resolveSession(primaryShare.c, primaryShare.session.sessionToken))).toBe(UNAVAILABLE);
		expect(await catchFail(shareAuthService.resolveSession(boxShare.c, boxShare.session.sessionToken))).toBe(UNAVAILABLE);
		expect((await readShareRow(primaryShare.created.shareId)).status).toBe('REVOKED');
		expect((await readShareRow(boxShare.created.shareId)).status).toBe('REVOKED');
		expect((await readShareRow(other.created.shareId)).status).toBe('ACTIVE');
	});

	it('does not change other account-delete rules', async () => {
		await seedMailbox();
		const primaryShare = await openShare(PRIMARY_A, USER_A, 'keep-primary');
		const otherShare = await openShare(BOX_B, USER_B, 'keep-other');
		const orphanMailId = await insertEmail(BOX_A, USER_A, 't13-orphan');

		expect(await catchBiz(accountService.delete(ctx(), { accountId: PRIMARY_A }, USER_A))).toBe(t('delMyAccount'));
		expect(await catchBiz(accountService.delete(ctx(), { accountId: BOX_B }, USER_A))).toBe(t('noUserAccount'));

		expect((await readShareRow(primaryShare.created.shareId)).status).toBe('ACTIVE');
		expect((await readShareRow(otherShare.created.shareId)).status).toBe('ACTIVE');

		await accountService.physicsDelete(ctx(), { accountId: BOX_A });
		expect(await env.db.prepare(
			'SELECT account_id FROM account WHERE account_id = ?'
		).bind(BOX_A).first()).toBeNull();
		expect((await env.db.prepare(
			'SELECT COUNT(*) AS n FROM email WHERE email_id = ?'
		).bind(orphanMailId).first()).n).toBe(0);
		expect((await env.db.prepare(
			'SELECT is_del FROM account WHERE account_id = ?'
		).bind(PRIMARY_A).first()).is_del).toBe(isDel.NORMAL);
	});
});
