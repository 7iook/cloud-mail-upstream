import { test, expect } from '../fixtures/share.js'
import { ATTACHMENT_BODY, OTP_CODE } from '../harness/constants.js'

test('email() inject is visible on visitor HTTP without a D1 row insert', async ({ world }) => {
	const { api, seed } = world
	const share = await api.createShare(seed)
	const injected = await api.injectEmail({
		code: OTP_CODE,
		subject: 'Desk handoff code',
		withAttachment: true
	})

	expect(injected.emailId).toEqual(expect.any(Number))
	expect(injected.status).toBe(0)
	expect(injected.isDel).toBe(0)
	expect(injected.code).toBe(OTP_CODE)

	const session = await api.openSession(share)
	const mails = await api.listMails(session.sessionToken)
	const mail = mails.list.find((row) => row.mailId === injected.emailId)
	expect(mail).toBeTruthy()
	expect(mail.code).toBe(OTP_CODE)
	expect(mail.subject).toBe('Desk handoff code')
	expect(mail.attachments[0].downloadUrl).toMatch(/^\/share\/attachment\?/)
	expect(mail.attachments[0].downloadUrl).not.toContain('/oss/')

	const download = await api.downloadAttachment(session.sessionToken, mail)
	expect(download.status).toBe(200)
	expect(String(download.body).replace(/\s+$/g, '')).toBe(ATTACHMENT_BODY)
})
