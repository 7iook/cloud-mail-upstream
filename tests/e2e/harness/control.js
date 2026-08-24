import {
	ATTACHMENT_BODY,
	E2E_CONTROL_HEADER,
	E2E_CONTROL_SECRET,
	OTP_CODE
} from './constants.js'

export function control(request, baseURL) {
	const root = String(baseURL || '').replace(/\/$/, '')

	async function call(path, init = {}) {
		const headers = {
			[E2E_CONTROL_HEADER]: E2E_CONTROL_SECRET,
			...(init.headers || {})
		}
		if (init.body && !headers['content-type']) {
			headers['content-type'] = 'application/json'
		}
		const response = await request.fetch(`${root}${path}`, {
			method: init.method || 'GET',
			headers,
			data: init.body
		})
		const text = await response.text()
		let json = null
		try {
			json = JSON.parse(text)
		} catch {
			json = null
		}
		return { status: response.status, headers: response.headers(), text, json }
	}

	async function api(method, path, { token, bearer, body, headers } = {}) {
		const next = { ...(headers || {}) }
		if (body !== undefined) {
			next['content-type'] = 'application/json'
		}
		if (token) {
			next.Authorization = token
		}
		if (bearer) {
			next.Authorization = `Bearer ${bearer}`
		}
		const response = await request.fetch(`${root}/api${path}`, {
			method,
			headers: next,
			data: body
		})
		const text = await response.text()
		let json = null
		try {
			json = JSON.parse(text)
		} catch {
			json = null
		}
		return { status: response.status, headers: response.headers(), text, json }
	}

	return {
		// Exported raw so a spec can assert a refusal envelope. Every named method below
		// throws on a non-200 envelope, which is right for arranging a fixture and useless
		// for a test whose subject is the refusal itself.
		api,
		async ready() {
			const response = await request.get(`${root}/__e2e__/health`)
			if (response.status() !== 200) {
				throw new Error(`e2e worker is not ready: ${response.status()}`)
			}
		},
		async seed() {
			const out = await call('/__e2e__/seed', { method: 'POST', body: {} })
			if (!out.json || !out.json.ok) {
				throw new Error(`e2e seed failed: ${out.text}`)
			}
			return out.json
		},
		async injectEmail(body = {}) {
			const out = await call('/__e2e__/email', {
				method: 'POST',
				body: { code: OTP_CODE, withAttachment: true, ...body }
			})
			if (!out.json || !out.json.ok) {
				throw new Error(`e2e email() inject failed: ${out.text}`)
			}
			return out.json
		},
		async setSessionTtl(seconds) {
			const out = await call('/__e2e__/session-ttl', {
				method: 'POST',
				body: { seconds }
			})
			if (!out.json || !out.json.ok) {
				throw new Error(`e2e session ttl failed: ${out.text}`)
			}
			return out.json
		},
		// Process-global inside the worker, and /seed resets it, so every test starts with
		// SHARE_CAPABILITY_V2 unset — the production default.
		async setCapabilityV2(on) {
			const out = await call('/__e2e__/capability-v2', {
				method: 'POST',
				body: { on: Boolean(on) }
			})
			if (!out.json || !out.json.ok) {
				throw new Error(`e2e capability v2 failed: ${out.text}`)
			}
			return out.json
		},
		async expireShare(lid) {
			const out = await call('/__e2e__/expire', { method: 'POST', body: { lid } })
			if (!out.json || !out.json.ok) {
				throw new Error(`e2e expire failed: ${out.text}`)
			}
			return out.json
		},
		async createShare(seed, body = {}) {
			const out = await api('POST', '/mailShare/create', {
				token: seed.ownerJwt,
				headers: { 'Idempotency-Key': crypto.randomUUID() },
				body: {
					accountId: seed.accountId,
					durationSeconds: 3600,
					name: 'e2e-share',
					remark: 'e2e',
					...body
				}
			})
			if (!out.json || out.json.code !== 200) {
				throw new Error(`create share failed: ${out.text}`)
			}
			return out.json.data
		},
		// usedSessions is the Owner-facing DTO alias of access_count, and the detail query
		// has no ACTIVE predicate, so a share that hit its cap is still readable here.
		async getShare(seed, shareId) {
			const out = await api('GET', `/mailShare/get?shareId=${shareId}`, {
				token: seed.ownerJwt
			})
			if (!out.json || out.json.code !== 200) {
				throw new Error(`get share failed: ${out.text}`)
			}
			return out.json.data
		},
		async revokeShare(seed, shareId) {
			const out = await api('DELETE', `/mailShare/revoke?shareId=${shareId}`, {
				token: seed.ownerJwt
			})
			if (!out.json || out.json.code !== 200) {
				throw new Error(`revoke share failed: ${out.text}`)
			}
			return out.json.data
		},
		async openSession(share) {
			const out = await api('POST', '/share/session', {
				body: { lid: share.lid, sec: share.sec }
			})
			if (!out.json || out.json.code !== 200) {
				throw new Error(`open session failed: ${out.text}`)
			}
			return out.json.data
		},
		async listMails(sessionToken) {
			const out = await api('GET', '/share/mails?limit=50', { bearer: sessionToken })
			if (!out.json || out.json.code !== 200) {
				throw new Error(`list mails failed: ${out.text}`)
			}
			return out.json.data
		},
		async downloadAttachment(sessionToken, mail) {
			const att = mail.attachments && mail.attachments[0]
			if (!att) {
				throw new Error('mail has no attachment')
			}
			const response = await request.fetch(`${root}/api${att.downloadUrl}`, {
				headers: { Authorization: `Bearer ${sessionToken}` }
			})
			if (response.status() !== 200) {
				return { status: response.status(), text: await response.text(), body: null }
			}
			return { status: 200, text: '', body: await response.text() }
		},
		attachmentBody: ATTACHMENT_BODY
	}
}
