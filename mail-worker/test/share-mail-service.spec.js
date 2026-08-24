import { env } from 'cloudflare:test';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emailConst, isDel } from '../src/const/entity-const';
import shareMailService from '../src/service/share-mail-service';

// ShareContext 由用例自造（T-09 冻结形状），不经 resolveSession。
// 权威形状：.agent-workspace/.archive/2026-08-24/mailbox-share-capability/share-context-freeze.md
// 垫片 accountId/windowStartEmailId 只为形状完整而带，投影/范围一律走 bindings。

const BASE_MAIL_KEYS = [
	'mailId',
	'bindingId',
	'mailboxAddress',
	'senderName',
	'senderAddress',
	'subject',
	'text',
	'content',
	'receivedAt',
	'attachments'
];
const OTP_ON_KEYS = [...BASE_MAIL_KEYS, 'code'].sort();
const OTP_OFF_KEYS = [...BASE_MAIL_KEYS].sort();

const ATTACHMENT_KEYS = ['attachmentId', 'filename', 'size', 'downloadUrl'].sort();

const UNIT_BINDING = 8001;
const UNIT_ACCOUNT = 42;
const UNIT_MAILBOX = 'inbox@example.com';

function shareContext({
	bindings = [{ bindingId: UNIT_BINDING, accountId: UNIT_ACCOUNT, windowStartEmailId: 0 }],
	messageLimit = null,
	otpExtractionEnabled = true,
	showFullAddress = false
} = {}) {
	const primary = bindings[0] || {};
	return {
		shareId: 911009,
		bindings,
		messageLimit,
		otpExtractionEnabled,
		showFullAddress,
		expiresAt: '2099-01-01 00:00:00',
		accountId: primary.accountId,
		windowStartEmailId: primary.windowStartEmailId,
		effectiveStatus: 'ACTIVE'
	};
}

function mailboxMap(entries = [[UNIT_ACCOUNT, UNIT_MAILBOX]]) {
	return new Map(entries);
}

function fatEmailRow(overrides = {}) {
	return {
		emailId: 11,
		sendEmail: 'otp@bank.example',
		name: 'Bank',
		accountId: UNIT_ACCOUNT,
		userId: 7,
		subject: 'Your code',
		code: '',
		content: '<p>hello</p>',
		cc: '[]',
		bcc: '[]',
		recipient: '[]',
		toEmail: 'user@example.com',
		toName: 'User',
		inReplyTo: '',
		relation: '',
		messageId: '<mid>',
		type: 0,
		status: 1,
		resendEmailId: null,
		message: null,
		unread: 0,
		createTime: '2026-08-17 01:00:00',
		isDel: 0,
		...overrides
	};
}

function fatAttRow(overrides = {}) {
	return {
		attId: 7,
		userId: 7,
		emailId: 11,
		accountId: UNIT_ACCOUNT,
		key: 'attachments/secret-hash.pdf',
		filename: 'invoice.pdf',
		mimeType: 'application/pdf',
		size: 1024,
		status: 0,
		type: 0,
		disposition: 'attachment',
		related: null,
		contentId: null,
		encoding: 'base64',
		createTime: '2026-08-17 01:00:00',
		...overrides
	};
}

function projectOne(row, atts, ctx = shareContext(), mailboxes = mailboxMap()) {
	return shareMailService.project(row, atts, ctx, mailboxes);
}

describe('shareMailService.maskAddress', () => {
	it('returns the address untouched when show_full_address is on (AC-MAIL-08)', () => {
		expect(shareMailService.maskAddress('alice@example.com', true)).toBe('alice@example.com');
		expect(shareMailService.maskAddress('a@example.com', true)).toBe('a@example.com');
	});

	it('keeps only the first local character when show_full_address is off (AC-MAIL-08)', () => {
		expect(shareMailService.maskAddress('alice@example.com', false)).toBe('a***@example.com');
		expect(shareMailService.maskAddress('a@example.com', false)).toBe('a***@example.com');
		expect(shareMailService.maskAddress('bob.smith@sub.example.co.uk', false))
			.toBe('b***@sub.example.co.uk');
	});

	it('returns *** for an illegal address instead of throwing', () => {
		for (const showFullAddress of [true, false]) {
			for (const bad of [
				'', '   ', 'no-at-sign', '@example.com', 'trailing@',
				'a@@example.com', 'alice@ex@ample.com',
				' alice@example.com', 'alice@example.com ', 'alice @example.com',
				null, undefined, 7, {}, []
			]) {
				expect(shareMailService.maskAddress(bad, showFullAddress)).toBe('***');
			}
		}
	});

	it('is idempotent under both show_full_address states', () => {
		for (const showFullAddress of [true, false]) {
			for (const address of ['alice@example.com', 'a***@example.com', '***', 'broken']) {
				const once = shareMailService.maskAddress(address, showFullAddress);
				expect(shareMailService.maskAddress(once, showFullAddress)).toBe(once);
			}
		}
	});
});

const LOCAL_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789._-';
const DOMAIN_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-';

function wordArb(chars, maxLength) {
	return fc.array(fc.constantFrom(...chars), { minLength: 1, maxLength })
		.map((parts) => parts.join(''));
}

const addressArb = fc.tuple(wordArb(LOCAL_CHARS, 12), wordArb(DOMAIN_CHARS, 10), fc.constantFrom('com', 'example', 'co.uk'))
	.map(([local, host, tld]) => ({ local, domain: `${host}.${tld}` }));

describe('P-MASK-01 identity masking is closed and idempotent', () => {
	it('masks only the system-generated mailbox identity, never sender/subject/body', () => {
		fc.assert(fc.property(addressArb, fc.boolean(), ({ local, domain }, showFullAddress) => {
			const address = `${local}@${domain}`;
			const ctx = shareContext({ showFullAddress });
			const masked = shareMailService.maskAddress(address, showFullAddress);

			expect(masked).toBe(showFullAddress ? address : `${local[0]}***@${domain}`);
			expect(shareMailService.maskAddress(masked, showFullAddress)).toBe(masked);

			const row = fatEmailRow({
				sendEmail: address,
				subject: `receipt for ${address}`,
				text: `hello ${address}, your code is inside`,
				content: `<p>${address}</p>`
			});
			const dto = projectOne(row, [], ctx, mailboxMap([[UNIT_ACCOUNT, address]]));

			expect(dto.mailboxAddress).toBe(masked);
			// 掩码契约只覆盖系统生成的身份字段：发件人不掩码，命中绑定地址的主题/正文原样。
			expect(dto.senderAddress).toBe(address);
			expect(dto.subject).toBe(row.subject);
			expect(dto.text).toBe(row.text);
			expect(dto.content).toBe(row.content);

			if (!showFullAddress) {
				const maskedLocal = masked.slice(0, masked.indexOf('@'));
				expect(maskedLocal).toBe(`${local[0]}***`);
				if (local.length > 1) {
					expect(maskedLocal).not.toContain(local);
				}
			}
		}), { numRuns: 60 });
	});

	it('masks a per-binding identity, so each row carries its own mailbox', () => {
		const bindings = [
			{ bindingId: 8001, accountId: 42, windowStartEmailId: 0 },
			{ bindingId: 8002, accountId: 43, windowStartEmailId: 0 }
		];
		const ctx = shareContext({ bindings });
		const mailboxes = mailboxMap([[42, 'first@example.com'], [43, 'second@example.com']]);

		const primary = projectOne(fatEmailRow({ accountId: 42 }), [], ctx, mailboxes);
		const secondary = projectOne(fatEmailRow({ emailId: 12, accountId: 43 }), [], ctx, mailboxes);

		expect(primary.bindingId).toBe(8001);
		expect(primary.mailboxAddress).toBe('f***@example.com');
		expect(secondary.bindingId).toBe(8002);
		expect(secondary.mailboxAddress).toBe('s***@example.com');
	});

	it('never emits the raw account id and degrades to *** for an unknown mailbox', () => {
		const dto = projectOne(fatEmailRow({ accountId: 999 }), [], shareContext(), mailboxMap());
		expect(dto.bindingId).toBeNull();
		expect(dto.mailboxAddress).toBe('***');
		expect(JSON.stringify(dto)).not.toContain('999');
	});
});

describe('P-OTP-04 code presence is exactly the otp switch', () => {
	it('exposes code IFF otpExtractionEnabled is true and forwards email.code verbatim', () => {
		fc.assert(fc.property(
			fc.constantFrom(true, false, undefined, null, 1, 0, 'true', ''),
			fc.constantFrom('', '847291', '0000', 'not-a-code'),
			(otpExtractionEnabled, code) => {
				// 显式覆盖而不是走工厂默认参数：`undefined` 会被默认值吃掉，
				// 那样这条 property 就测不到「非 true 一律剔除」。
				const ctx = { ...shareContext(), otpExtractionEnabled };
				const dto = projectOne(fatEmailRow({ code }), [], ctx);
				const on = otpExtractionEnabled === true;

				expect(Object.prototype.hasOwnProperty.call(dto, 'code')).toBe(on);
				expect(Object.keys(dto).sort()).toEqual(on ? OTP_ON_KEYS : OTP_OFF_KEYS);
				if (on) {
					expect(dto.code).toBe(code);
				}
			}
		), { numRuns: 40 });
	});

	it('does not invent null when otp extraction is off (AC-OTP-02)', () => {
		const dto = projectOne(fatEmailRow({ code: '847291' }), [], shareContext({ otpExtractionEnabled: false }));
		expect(dto.code).toBeUndefined();
		expect('code' in dto).toBe(false);
		expect(JSON.stringify(dto)).not.toContain('847291');
	});

	it('does not infer a code from subject or text when code is empty (AC-OTP-15)', () => {
		const dto = projectOne(fatEmailRow({
			code: '',
			subject: 'Your verification code is 123456',
			text: 'code: 123456'
		}));
		expect(dto.code).toBe('');
	});

	it('still projects subject and body when the code is empty (AC-OTP-03)', () => {
		const dto = projectOne(fatEmailRow({ code: '', subject: 'kept', text: 'kept body' }));
		expect(dto.subject).toBe('kept');
		expect(dto.text).toBe('kept body');
	});
});

describe('shareMailService.project P-PROJ-01', () => {
	it('output key set is exactly the whitelist when the row carries extra internal columns', () => {
		const dto = projectOne(fatEmailRow({ code: '847291' }), [fatAttRow()]);
		expect(Object.keys(dto).sort()).toEqual(OTP_ON_KEYS);
		expect(dto).not.toHaveProperty('userId');
		expect(dto).not.toHaveProperty('user_id');
		expect(dto).not.toHaveProperty('accountId');
		expect(dto).not.toHaveProperty('account_id');
		expect(dto).not.toHaveProperty('isDel');
		expect(dto).not.toHaveProperty('status');
		expect(dto).not.toHaveProperty('emailId');
		expect(dto).not.toHaveProperty('sendEmail');
		expect(dto.mailId).toBe(11);
		expect(dto.bindingId).toBe(UNIT_BINDING);
		expect(dto.mailboxAddress).toBe('i***@example.com');
		expect(dto.senderName).toBe('Bank');
		expect(dto.senderAddress).toBe('otp@bank.example');
		expect(dto.receivedAt).toBe('2026-08-17 01:00:00');
		expect(dto.code).toBe('847291');
	});

	it('keeps empty-string code intact and does not invent null (AC-OTP-14, AC-OTP-15)', () => {
		const dto = projectOne(fatEmailRow({ code: '' }));
		expect(dto.code).toBe('');
		expect(Object.keys(dto).sort()).toEqual(OTP_ON_KEYS);
	});

	it('represents missing text as null so the UI can apply AC-SEC-24', () => {
		const dto = projectOne(fatEmailRow({ content: '<p>html</p>' }));
		expect(dto.text).toBeNull();
		expect(dto.content).toBe('<p>html</p>');
		expect(Object.keys(dto).sort()).toEqual(OTP_ON_KEYS);
	});

	it('attachment downloadUrl points at /share/attachment and never /oss/ (AC-SEC-20)', () => {
		const dto = projectOne(fatEmailRow(), [fatAttRow()]);
		expect(dto.attachments).toHaveLength(1);
		expect(Object.keys(dto.attachments[0]).sort()).toEqual(ATTACHMENT_KEYS);
		expect(dto.attachments[0].downloadUrl).toBe('/share/attachment?mailId=11&attachmentId=7');
		expect(dto.attachments[0]).not.toHaveProperty('key');
		const blob = JSON.stringify(dto);
		expect(blob).not.toContain('/oss/');
		expect(blob).not.toContain('secret-hash');
	});
});

// ── T-11.3 详情可见集：真 scoped repo + 真 D1，不 mock getById ──────────────

const USER_ID = 911001;
const ACCOUNT_A = 911042;
const ACCOUNT_B = 911043;
const ACCOUNT_OTHER = 911044;
const MAILBOX_A = 'alpha-t11p@example.com';
const MAILBOX_B = 'beta-t11p@example.com';
const MAILBOX_OTHER = 'outsider-t11p@example.com';
const BINDING_A = 8101;
const BINDING_B = 8102;
const BINDING_OTHER = 8103;
const WINDOW_A = 911010;
const WINDOW_B = 911030;

const A = { first: 911011, second: 911012, third: 911013, arrived: 911014 };
const B = { first: 911031, second: 911032 };
const POISON = { belowWindowA: 911005, belowWindowB: 911029, otherShare: 911021 };

const ALL_SEEDED_IDS = [...Object.values(A), ...Object.values(B), ...Object.values(POISON)];

const c = { env };

function bindingA(windowStartEmailId = WINDOW_A) {
	return { bindingId: BINDING_A, accountId: ACCOUNT_A, windowStartEmailId };
}

function bindingB(windowStartEmailId = WINDOW_B) {
	return { bindingId: BINDING_B, accountId: ACCOUNT_B, windowStartEmailId };
}

async function ensureAccount(accountId, email) {
	await env.db.prepare('DELETE FROM account WHERE account_id = ? OR email = ?').bind(accountId, email).run();
	await env.db.prepare(`
		INSERT INTO account (account_id, email, name, user_id, is_del)
		VALUES (?, ?, ?, ?, ?)
	`).bind(accountId, email, 't11p', USER_ID, isDel.NORMAL).run();
}

async function insertVisible(emailId, accountId, subject, code = '') {
	await env.db.prepare(`
		INSERT INTO email (email_id, account_id, user_id, subject, is_del, status, type, send_email, name, text, content, code)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		emailId,
		accountId,
		USER_ID,
		subject,
		isDel.NORMAL,
		emailConst.status.RECEIVE,
		emailConst.type.RECEIVE,
		't11p-sender@example.com',
		'T11 Sender',
		'plain body',
		'<p>html</p>',
		code
	).run();
}

async function deleteSeeded() {
	const placeholders = ALL_SEEDED_IDS.map(() => '?').join(', ');
	await env.db.prepare(
		`DELETE FROM email WHERE email_id IN (${placeholders}) OR subject LIKE 't11p-%'`
	).bind(...ALL_SEEDED_IDS).run();
	await env.db.prepare(
		'DELETE FROM account WHERE account_id IN (?, ?, ?)'
	).bind(ACCOUNT_A, ACCOUNT_B, ACCOUNT_OTHER).run();
}

describe('shareMailService detail visible set (real scoped repository + D1)', () => {
	beforeAll(async () => {
		await deleteSeeded();
		await ensureAccount(ACCOUNT_A, MAILBOX_A);
		await ensureAccount(ACCOUNT_B, MAILBOX_B);
		await ensureAccount(ACCOUNT_OTHER, MAILBOX_OTHER);
		await insertVisible(A.first, ACCOUNT_A, 't11p-a-1', '111111');
		await insertVisible(A.second, ACCOUNT_A, 't11p-a-2', '222222');
		await insertVisible(A.third, ACCOUNT_A, 't11p-a-3', '333333');
		await insertVisible(B.first, ACCOUNT_B, 't11p-b-1');
		await insertVisible(B.second, ACCOUNT_B, 't11p-b-2');
		await insertVisible(POISON.belowWindowA, ACCOUNT_A, 't11p-below-window-a');
		await insertVisible(POISON.belowWindowB, ACCOUNT_B, 't11p-below-window-b');
		await insertVisible(POISON.otherShare, ACCOUNT_OTHER, 't11p-other-share');
	});

	afterAll(async () => {
		await deleteSeeded();
	});

	it('serves an in-window mail with its own binding identity and masked mailbox', async () => {
		const ctx = shareContext({ bindings: [bindingA(), bindingB()] });

		const fromA = await shareMailService.getById(c, ctx, A.third);
		expect(fromA.mailId).toBe(A.third);
		expect(fromA.bindingId).toBe(BINDING_A);
		expect(fromA.mailboxAddress).toBe('a***@example.com');
		expect(fromA.code).toBe('333333');
		expect(Object.keys(fromA).sort()).toEqual(OTP_ON_KEYS);

		const fromB = await shareMailService.getById(c, ctx, B.second);
		expect(fromB.bindingId).toBe(BINDING_B);
		expect(fromB.mailboxAddress).toBe('b***@example.com');

		const full = await shareMailService.getById(c, shareContext({
			bindings: [bindingA(), bindingB()],
			showFullAddress: true
		}), B.second);
		expect(full.mailboxAddress).toBe(MAILBOX_B);
	});

	it('refuses a mail below its own binding window (AC-MAIL-05)', async () => {
		const ctx = shareContext({ bindings: [bindingA(), bindingB()] });
		expect(await shareMailService.getById(c, ctx, POISON.belowWindowA)).toBeNull();
		expect(await shareMailService.getById(c, ctx, POISON.belowWindowB)).toBeNull();
	});

	it('refuses a mail that rolled out of messageLimit and re-checks after new mail (AC-MAIL-04)', async () => {
		const ctx = shareContext({ bindings: [bindingA()], messageLimit: 1 });

		expect((await shareMailService.getById(c, ctx, A.third)).mailId).toBe(A.third);
		expect(await shareMailService.getById(c, ctx, A.second)).toBeNull();
		expect(await shareMailService.getById(c, ctx, A.first)).toBeNull();
		expect((await shareMailService.list(c, ctx, null, 20)).map((row) => row.mailId)).toEqual([A.third]);

		await insertVisible(A.arrived, ACCOUNT_A, 't11p-a-4');

		expect((await shareMailService.list(c, ctx, null, 20)).map((row) => row.mailId)).toEqual([A.arrived]);
		expect(await shareMailService.getById(c, ctx, A.third)).toBeNull();
	});

	it('refuses a mailId that belongs to another share and leaks no existence (AC-MAIL-06, AC-EDGE-08)', async () => {
		const mine = shareContext({ bindings: [bindingA()] });
		const foreign = shareContext({
			bindings: [{ bindingId: BINDING_OTHER, accountId: ACCOUNT_OTHER, windowStartEmailId: 0 }]
		});

		expect(await shareMailService.getById(c, mine, POISON.otherShare)).toBeNull();
		expect(await shareMailService.getById(c, mine, B.first)).toBeNull();
		expect(await shareMailService.getById(c, foreign, A.third)).toBeNull();
		// 造一个不属于本分享的 bindingId：范围仍由 bindings 里的 account 决定，不因 id 好看而放行
		const tampered = shareContext({
			bindings: [{ bindingId: BINDING_B, accountId: ACCOUNT_OTHER, windowStartEmailId: 0 }]
		});
		expect(await shareMailService.getById(c, tampered, B.first)).toBeNull();
	});

	it('list projects every row through the whitelist and never leaks internals', async () => {
		const ctx = shareContext({ bindings: [bindingA(), bindingB()], otpExtractionEnabled: false });
		const rows = await shareMailService.list(c, ctx, null, 20);

		expect(rows.map((row) => row.mailId)).toEqual([B.second, B.first, A.third, A.second, A.first]);
		for (const row of rows) {
			expect(Object.keys(row).sort()).toEqual(OTP_OFF_KEYS);
			const fromB = row.mailId >= B.first;
			expect(row.bindingId).toBe(fromB ? BINDING_B : BINDING_A);
			expect(row.mailboxAddress).toBe(fromB ? 'b***@example.com' : 'a***@example.com');
		}
		const blob = JSON.stringify(rows);
		expect(blob).not.toContain('/oss/');
		expect(blob).not.toContain('user_id');
		expect(blob).not.toContain('account_id');
		expect(blob).not.toContain(String(ACCOUNT_A));
	});
});

describe('shareMailService list/getById with injected dependencies', () => {
	it('list maps repository rows through project and does not leak internal columns', async () => {
		const row = fatEmailRow({ code: '' });
		const dtos = await shareMailService.list({}, shareContext(), null, 20, {
			shareScopedEmailRepository: {
				list: async () => [row]
			},
			findAttachments: async () => [fatAttRow()],
			findAccountEmails: async () => [{ accountId: UNIT_ACCOUNT, email: UNIT_MAILBOX }]
		});
		expect(dtos).toHaveLength(1);
		expect(Object.keys(dtos[0]).sort()).toEqual(OTP_ON_KEYS);
		expect(dtos[0].code).toBe('');
		expect(dtos[0].bindingId).toBe(UNIT_BINDING);
		expect(dtos[0].mailboxAddress).toBe('i***@example.com');
		expect(JSON.stringify(dtos[0])).not.toContain('/oss/');
		expect(JSON.stringify(dtos[0])).not.toContain('userId');
	});

	it('getById returns null when the repository returns null', async () => {
		const dto = await shareMailService.getById({}, shareContext(), 99, {
			shareScopedEmailRepository: {
				getById: async () => null
			},
			findAttachments: async () => [],
			findAccountEmails: async () => []
		});
		expect(dto).toBeNull();
	});

	it('listForBinding narrows to one binding and projects it exactly like list', async () => {
		const bindings = [
			{ bindingId: UNIT_BINDING, accountId: UNIT_ACCOUNT, windowStartEmailId: 0 },
			{ bindingId: 8002, accountId: 43, windowStartEmailId: 0 }
		];
		const seen = [];
		const dtos = await shareMailService.listForBinding({}, shareContext({ bindings }), UNIT_BINDING, null, 20, {
			shareScopedEmailRepository: {
				listForBinding: async (_c, ctx, bindingId) => {
					seen.push({ bindingId, bindings: ctx.bindings.map((item) => item.bindingId) });
					return [fatEmailRow({ code: '' })];
				},
				list: async () => {
					throw new Error('merged list must not serve a real binding id');
				}
			},
			findAttachments: async () => [fatAttRow()],
			findAccountEmails: async () => [{ accountId: UNIT_ACCOUNT, email: UNIT_MAILBOX }]
		});

		expect(seen).toEqual([{ bindingId: UNIT_BINDING, bindings: [UNIT_BINDING] }]);
		expect(dtos).toHaveLength(1);
		expect(Object.keys(dtos[0]).sort()).toEqual(OTP_ON_KEYS);
		expect(dtos[0].bindingId).toBe(UNIT_BINDING);
		expect(dtos[0].mailboxAddress).toBe('i***@example.com');
	});

	it('listForBinding serves the legacy bindingId 0 instead of treating it as absent', async () => {
		const bindings = [{ bindingId: 0, accountId: UNIT_ACCOUNT, windowStartEmailId: 0 }];
		const dtos = await shareMailService.listForBinding({}, shareContext({ bindings }), 0, null, 20, {
			shareScopedEmailRepository: {
				list: async (_c, ctx) => {
					expect(ctx.bindings.map((item) => item.bindingId)).toEqual([0]);
					return [fatEmailRow({ code: '' })];
				},
				listForBinding: async () => {
					throw new Error('resolveRowId cannot express 0, so this path must not run');
				}
			},
			findAttachments: async () => [],
			findAccountEmails: async () => [{ accountId: UNIT_ACCOUNT, email: UNIT_MAILBOX }]
		});

		expect(dtos.map((row) => row.mailId)).toEqual([11]);
		expect(dtos[0].bindingId).toBe(0);
	});

	it('listForBinding answers an unknown or malformed bindingId with [] and never queries', async () => {
		let queries = 0;
		const repo = {
			list: async () => {
				queries += 1;
				return [fatEmailRow()];
			},
			listForBinding: async () => {
				queries += 1;
				return [fatEmailRow()];
			}
		};
		for (const bindingId of [9999, -1, null, undefined, '', 'abc', 1.5, {}]) {
			expect(await shareMailService.listForBinding({}, shareContext(), bindingId, null, 20, {
				shareScopedEmailRepository: repo,
				findAttachments: async () => [],
				findAccountEmails: async () => []
			})).toEqual([]);
		}
		expect(queries).toBe(0);
	});

	it('does not query mailbox addresses when there is nothing to project', async () => {
		let called = 0;
		const dtos = await shareMailService.list({}, shareContext(), null, 20, {
			shareScopedEmailRepository: { list: async () => [] },
			findAttachments: async () => [],
			findAccountEmails: async () => {
				called += 1;
				return [];
			}
		});
		expect(dtos).toEqual([]);
		expect(called).toBe(0);
	});
});
