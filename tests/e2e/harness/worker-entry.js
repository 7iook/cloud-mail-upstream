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
	MAILBOX_2,
	OTP_CODE,
	OWNER_EMAIL,
	SENDER_EMAIL,
	SENDER_NAME
} from './constants.js'

const CONTROL_PREFIX = '/__e2e__/'
let schemaReady = false
let sessionTtlOverride = null
// SHARE_CAPABILITY_V2 is absent from wrangler-e2e.toml on purpose, so the default state is
// the production default (off) and a spec that forgets to open the gate goes red instead of
// silently passing. One Proxy answers both overrides: a second layer would wrap this one and
// make it impossible to tell which of them shadowed a var.
let capabilityV2Override = null

function envWithOverrides(env) {
	if (sessionTtlOverride == null && capabilityV2Override == null) {
		return env
	}
	return new Proxy(env, {
		get(target, prop, receiver) {
			if (prop === 'SHARE_SESSION_TTL' && sessionTtlOverride != null) {
				return sessionTtlOverride
			}
			if (prop === 'SHARE_CAPABILITY_V2' && capabilityV2Override != null) {
				return capabilityV2Override
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

	// Same owner, second mailbox. Idempotent like the first one: `--persist-to .mf-state`
	// keeps D1 across runs, so a bare INSERT would hit UNIQUE on the second run.
	let account2 = await env.db.prepare('SELECT account_id FROM account WHERE email = ?').bind(MAILBOX_2).first()
	if (!account2) {
		account2 = await env.db.prepare(
			'INSERT INTO account (email, name, user_id, is_del) VALUES (?, ?, ?, 0) RETURNING account_id'
		).bind(MAILBOX_2, 'e2e-box-2', userId).first()
	}

	const sessionToken = crypto.randomUUID()
	const jwt = await jwtUtils.generateToken({ env }, { userId, token: sessionToken })
	await env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify({
		tokens: [sessionToken],
		user: { userId, email: OWNER_EMAIL, type: 1 },
		refreshTime: new Date().toISOString()
	}))
	await enableCodeExtraction(env)
	return {
		userId,
		accountId: account.account_id,
		accountId2: account2.account_id,
		ownerJwt: jwt,
		mailbox: MAILBOX,
		mailbox2: MAILBOX_2,
		ownerEmail: OWNER_EMAIL
	}
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
		capabilityV2Override = null
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

	// 'false' rather than null for off: null means "not overridden", and the two must stay
	// distinguishable now that /seed resets to null.
	if (req.method === 'POST' && route === '/capability-v2') {
		const body = await req.json()
		capabilityV2Override = body && body.on ? 'true' : 'false'
		return json({ ok: true, on: capabilityV2Override })
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
		// `code` 既是注入正文里那串数字,也是默认的期望值 —— 对「每封注入邮件都含一个码」
		// 的用例这两者本就相同。但提取扩成双字段之后,合法的注入体可以只有验证链接、甚至
		// 两者都没有,那时期望值是空串而不是 `code`。`expectCode` 让调用方显式声明,
		// 不传时行为与从前一致。
		const expectCode = body.expectCode === undefined ? code : body.expectCode
		if (row.code !== expectCode) {
			return json({
				ok: false,
				error: 'email() did not persist the extracted code',
				emailId: row.email_id,
				code: row.code,
				expected: expectCode,
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
		return worker.fetch(req, envWithOverrides(env), ctx)
	},
	email: worker.email,
	scheduled: worker.scheduled
}
