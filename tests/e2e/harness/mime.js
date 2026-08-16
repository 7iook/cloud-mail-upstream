import { ATTACHMENT_BODY, ATTACHMENT_NAME, OTP_CODE, SENDER_EMAIL, SENDER_NAME } from './constants.js'

function encodePart(text) {
	return String(text).replace(/\r?\n/g, '\r\n')
}

export function buildInboundMime(options = {}) {
	const to = options.to
	const from = options.from || SENDER_EMAIL
	const fromName = options.fromName || SENDER_NAME
	const subject = options.subject || 'Your verification code'
	const code = options.code || OTP_CODE
	const text = options.text || `Your login verification code is ${code}. It expires in 10 minutes.`
	const html = options.html || `<p>Your login verification code is <b>${code}</b>.</p>`
	const withAttachment = options.withAttachment !== false
	const filename = options.filename || ATTACHMENT_NAME
	const fileBody = options.fileBody || ATTACHMENT_BODY
	const boundary = 'e2e-mail-share-boundary'

	const lines = [
		`From: ${fromName} <${from}>`,
		`To: ${to}`,
		`Subject: ${subject}`,
		'MIME-Version: 1.0',
		`Content-Type: multipart/mixed; boundary="${boundary}"`,
		'',
		`--${boundary}`,
		'Content-Type: text/plain; charset=utf-8',
		'',
		encodePart(text),
		`--${boundary}`,
		'Content-Type: text/html; charset=utf-8',
		'',
		encodePart(html)
	]

	if (withAttachment) {
		lines.push(
			`--${boundary}`,
			`Content-Type: text/plain; charset=utf-8; name="${filename}"`,
			`Content-Disposition: attachment; filename="${filename}"`,
			'',
			encodePart(fileBody)
		)
	}

	lines.push(`--${boundary}--`, '')
	return lines.join('\r\n')
}
