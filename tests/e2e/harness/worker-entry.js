import worker from '../../../mail-worker/src/index.js'
import { email } from '../../../mail-worker/src/email/email.js'
import KvConst from '../../../mail-worker/src/const/kv-const.js'
import settingService from '../../../mail-worker/src/service/setting-service.js'
import jwtUtils from '../../../mail-worker/src/utils/jwt-utils.js'
import { buildInboundMime } from './mime.js'
import {
	ATTACHMENT_BODY,
	ATTACHMENT_NAME,
	E2E_CONTROL_HEADER,
	MAILBOX,
	OTP_CODE,
	OWNER_EMAIL,
	SENDER_EMAIL,
	SENDER_NAME
} from './constants.js'

const CONTROL_PREFIX = '/__e2e__/'
let schemaReady = false
let sessionTtlOverride = null

function envWithSessionTtl(env) {
	if (sessionTtlOverride == null) {
		return env
	}
	return new Proxy(env, {
		get(target, prop, receiver) {
			if (prop === 'SHARE_SESSION_TTL') {
				return sessionTtlOverride
			}
			const value = Reflect.get(target, prop, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		}
	})
}

function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
	})
}

function authorized(req, env) {
	const expected = env.E2E_CONTROL_SECRET
	if (!expected) {
		return false
	}
	return req.headers.get(E2E_CONTROL_HEADER) === expected
}

function makeContext(env) {
	const bag = new Map()
	return {
		env,
		set(key, value) {
			bag.set(key, value)
		},
		get(key) {
			return bag.get(key)
		}
	}
}

function makeEmailMessage({ from, to, raw }) {
	const bytes = new TextEncoder().encode(raw)
	return {
		from,
		to,
		headers: new Headers({ from, to }),
		raw: new ReadableStream({
			start(controller) {
				controller.enqueue(bytes)
				controller.close()
			}
		}),
		rejected: null,
		setReject(reason) {
			this.rejected = reason
		},
		async forward() {
			return undefined
		}
	}
}

function envWithStubAi(env, code) {
	const stubAi = {
		async run() {
			return JSON.stringify({ code })
		}
	}
	return new Proxy(env, {
		get(target, prop, receiver) {
			if (prop === 'ai') {
				return stubAi
			}
			const value = Reflect.get(target, prop, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		}
	})
}

async function ensureSchema(env, ctx) {
	if (schemaReady) {
		return
	}
	const init = await worker.fetch(new Request(`http://e2e.local/api/init/${encodeURIComponent(env.jwt_secret)}`), env, ctx)
	const body = await init.text()
	if (body !== 'success') {
		throw new Error(`schema init failed: status=${init.status} body=${body}`)
	}
	schemaReady = true
}

async function enableCodeExtraction(env) {
	await env.db.prepare('UPDATE setting SET ai_code = 0').run()
	await settingService.refresh(makeContext(env))
}

async function seedOwner(env) {
	const existing = await env.db.prepare('SELECT user_id FROM user WHERE email = ?').bind(OWNER_EMAIL).first()
	let userId = existing && existing.user_id
	if (!userId) {
		await env.db.prepare(
			'INSERT INTO user (email, type, password, salt, status, is_del) VALUES (?, 1, ?, ?, 0, 0)'
		).bind(OWNER_EMAIL, 'e2e', 'e2e').run()
		const row = await env.db.prepare('SELECT user_id FROM user WHERE email = ?').bind(OWNER_EMAIL).first()
		userId = row.user_id
	}

	let account = await env.db.prepare('SELECT account_id FROM account WHERE email = ?').bind(MAILBOX).first()
	if (!account) {
		account = await env.db.prepare(
			'INSERT INTO account (email, name, user_id, is_del) VALUES (?, ?, ?, 0) RETURNING account_id'
		).bind(MAILBOX, 'e2e-box', userId).first()
	}

	const sessionToken = crypto.randomUUID()
	const jwt = await jwtUtils.generateToken({ env }, { userId, token: sessionToken })
	await env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify({
		tokens: [sessionToken],
		user: { userId, email: OWNER_EMAIL, type: 1 },
		refreshTime: new Date().toISOString()
	}))
	await enableCodeExtraction(env)
	return { userId, accountId: account.account_id, ownerJwt: jwt, mailbox: MAILBOX, ownerEmail: OWNER_EMAIL }
}

async function handleControl(req, env, ctx, url) {
	const route = url.pathname.slice(CONTROL_PREFIX.length - 1)
	if (req.method === 'GET' && (route === '/health' || url.pathname === '/__e2e__/health')) {
		await ensureSchema(env, ctx)
		return new Response('ok', { status: 200, headers: { 'cache-control': 'no-store' } })
	}

	if (!authorized(req, env)) {
		return new Response('not found', { status: 404 })
	}

	await ensureSchema(env, ctx)

	if (req.method === 'POST' && route === '/seed') {
		sessionTtlOverride = null
		const seeded = await seedOwner(env)
		return json({ ok: true, ...seeded })
	}

	if (req.method === 'POST' && route === '/session-ttl') {
		const body = await req.json()
		const seconds = Number(body && body.seconds)
		if (!Number.isFinite(seconds) || seconds <= 0) {
			sessionTtlOverride = null
			return json({ ok: true, seconds: null })
		}
		sessionTtlOverride = String(Math.floor(seconds))
		return json({ ok: true, seconds: Number(sessionTtlOverride) })
	}

	if (req.method === 'POST' && route === '/email') {
		const body = await req.json()
		const to = body.to || MAILBOX
		const code = body.code || OTP_CODE
		const raw = buildInboundMime({
			to,
			from: body.from || SENDER_EMAIL,
			fromName: body.fromName || SENDER_NAME,
			subject: body.subject,
			text: body.text,
			html: body.html,
			code,
			withAttachment: body.withAttachment !== false,
			filename: body.filename || ATTACHMENT_NAME,
			fileBody: body.fileBody || ATTACHMENT_BODY
		})
		await enableCodeExtraction(env)
		const message = makeEmailMessage({
			from: body.from || SENDER_EMAIL,
			to,
			raw
		})
		try {
			await email(message, envWithStubAi(env, code), ctx)
		} catch (err) {
			const detail = err && err.message ? err.message : String(err)
			console.error('e2e email() handler failed', detail)
			return json({ ok: false, error: detail, rejected: message.rejected }, 500)
		}
		if (message.rejected) {
			return json({ ok: false, rejected: message.rejected }, 400)
		}
		const row = await env.db.prepare(`
			SELECT email_id, status, is_del, code, subject, account_id
			FROM email
			WHERE to_email = ?
			ORDER BY email_id DESC
			LIMIT 1
		`).bind(to).first()
		if (!row) {
			return json({ ok: false, error: 'email() completed but no email row was found' }, 500)
		}
		if (row.code !== code) {
			return json({
				ok: false,
				error: 'email() did not persist the extracted code',
				emailId: row.email_id,
				code: row.code,
				status: row.status
			}, 500)
		}
		return json({
			ok: true,
			emailId: row.email_id,
			status: row.status,
			isDel: row.is_del,
			code: row.code,
			subject: row.subject,
			accountId: row.account_id
		})
	}

	if (req.method === 'POST' && route === '/expire') {
		const body = await req.json()
		if (!body.lid) {
			return json({ ok: false, error: 'lid required' }, 400)
		}
		const result = await env.db.prepare(
			"UPDATE mail_share SET expires_at = '2000-01-01 00:00:00' WHERE lid = ?"
		).bind(String(body.lid)).run()
		return json({ ok: true, changes: result.meta && result.meta.changes })
	}

	return new Response('not found', { status: 404 })
}

export default {
	async fetch(req, env, ctx) {
		const url = new URL(req.url)
		if (url.pathname.startsWith(CONTROL_PREFIX)) {
			try {
				return await handleControl(req, env, ctx, url)
			} catch (err) {
				const detail = err && err.message ? err.message : String(err)
				console.error('e2e control failed', detail)
				return json({ ok: false, error: detail }, 500)
			}
		}
		return worker.fetch(req, envWithSessionTtl(env), ctx)
	},
	email: worker.email,
	scheduled: worker.scheduled
}
