import { describe, expect, it } from 'vitest';
import shareMailService from '../src/service/share-mail-service';

const VISITOR_MAIL_KEYS = [
	'mailId',
	'senderName',
	'senderAddress',
	'subject',
	'text',
	'content',
	'receivedAt',
	'code',
	'attachments'
].sort();

const ATTACHMENT_KEYS = ['attachmentId', 'filename', 'size', 'downloadUrl'].sort();

function fatEmailRow(overrides = {}) {
	return {
		emailId: 11,
		sendEmail: 'otp@bank.example',
		name: 'Bank',
		accountId: 42,
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
		accountId: 42,
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

describe('shareMailService.project P-PROJ-01', () => {
	it('output key set is exactly the whitelist when the row carries extra internal columns', () => {
		const dto = shareMailService.project(fatEmailRow({ code: '847291' }), [fatAttRow()]);
		expect(Object.keys(dto).sort()).toEqual(VISITOR_MAIL_KEYS);
		expect(dto).not.toHaveProperty('userId');
		expect(dto).not.toHaveProperty('accountId');
		expect(dto).not.toHaveProperty('isDel');
		expect(dto).not.toHaveProperty('status');
		expect(dto).not.toHaveProperty('emailId');
		expect(dto).not.toHaveProperty('sendEmail');
		expect(dto.mailId).toBe(11);
		expect(dto.senderName).toBe('Bank');
		expect(dto.senderAddress).toBe('otp@bank.example');
		expect(dto.receivedAt).toBe('2026-08-17 01:00:00');
		expect(dto.code).toBe('847291');
	});

	it('keeps empty-string code intact and does not invent null (AC-OTP-14, AC-OTP-15)', () => {
		const dto = shareMailService.project(fatEmailRow({ code: '' }));
		expect(dto.code).toBe('');
		expect(Object.keys(dto).sort()).toEqual(VISITOR_MAIL_KEYS);
	});

	it('does not infer a code from subject or text when code is empty (AC-OTP-15)', () => {
		const dto = shareMailService.project(fatEmailRow({
			code: '',
			subject: 'Your verification code is 123456',
			text: 'code: 123456'
		}));
		expect(dto.code).toBe('');
	});

	it('represents missing text as null so the UI can apply AC-SEC-24', () => {
		const dto = shareMailService.project(fatEmailRow({ content: '<p>html</p>' }));
		expect(dto.text).toBeNull();
		expect(dto.content).toBe('<p>html</p>');
		expect(Object.keys(dto).sort()).toEqual(VISITOR_MAIL_KEYS);
	});

	it('attachment downloadUrl points at /share/attachment and never /oss/ (AC-SEC-20)', () => {
		const dto = shareMailService.project(fatEmailRow(), [fatAttRow()]);
		expect(dto.attachments).toHaveLength(1);
		expect(Object.keys(dto.attachments[0]).sort()).toEqual(ATTACHMENT_KEYS);
		expect(dto.attachments[0].downloadUrl).toBe('/share/attachment?mailId=11&attachmentId=7');
		expect(dto.attachments[0]).not.toHaveProperty('key');
		const blob = JSON.stringify(dto);
		expect(blob).not.toContain('/oss/');
		expect(blob).not.toContain('secret-hash');
	});
});

describe('shareMailService list/getById', () => {
	it('list maps repository rows through project and does not leak internal columns', async () => {
		const row = fatEmailRow({ code: '' });
		const dtos = await shareMailService.list({}, { accountId: 42, windowStartEmailId: 10 }, null, 20, {
			shareScopedEmailRepository: {
				list: async () => [row]
			},
			findAttachments: async () => [fatAttRow()]
		});
		expect(dtos).toHaveLength(1);
		expect(Object.keys(dtos[0]).sort()).toEqual(VISITOR_MAIL_KEYS);
		expect(dtos[0].code).toBe('');
		expect(JSON.stringify(dtos[0])).not.toContain('/oss/');
		expect(JSON.stringify(dtos[0])).not.toContain('userId');
	});

	it('getById returns null when the repository returns null', async () => {
		const dto = await shareMailService.getById({}, { accountId: 42, windowStartEmailId: 10 }, 99, {
			shareScopedEmailRepository: {
				getById: async () => null
			},
			findAttachments: async () => []
		});
		expect(dto).toBeNull();
	});
});
