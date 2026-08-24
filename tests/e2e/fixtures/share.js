import { test as base, expect } from '@playwright/test'
import { control } from '../harness/control.js'
import { OTP_CODE } from '../harness/constants.js'

export { expect }

export const test = base.extend({
	world: async ({ request, baseURL }, use) => {
		const api = control(request, baseURL)
		await api.ready()
		const seed = await api.seed()
		await use({ api, seed, baseURL })
	},
	context: async ({ browser }, use) => {
		const context = await browser.newContext({
			serviceWorkers: 'block',
			permissions: ['clipboard-read', 'clipboard-write']
		})
		await use(context)
		await context.close()
	},
	page: async ({ context }, use) => {
		const page = await context.newPage()
		await use(page)
		await page.close()
	}
})

export async function openShare(page, share) {
	await page.goto(`/s/${share.lid}#${share.sec}`, { waitUntil: 'domcontentloaded' })
}

export async function waitShareState(page, state) {
	await expect(page.locator('[data-share-state]')).toHaveAttribute('data-share-state', state)
}

export async function sessionKeys(page) {
	return page.evaluate(() => {
		const keys = []
		for (let i = 0; i < sessionStorage.length; i++) {
			keys.push(sessionStorage.key(i))
		}
		return keys
	})
}

// A second incognito window: its own storage, its own never-logged-in state. The caller
// closes it. Clipboard permissions are deliberately not granted — the fixture `page` is
// already a never-logged-in browser and is the one to use when a spec needs to copy.
export async function newVisitor(browser) {
	const context = await browser.newContext({ serviceWorkers: 'block' })
	const page = await context.newPage()
	return { context, page }
}

// AC-SESS-10: commit the first POST /share/session on the worker, then hide the answer from
// the browser. route.fetch() performs the request without fulfilling the route, so the
// route is still unhandled and abort() is legal afterwards; the visitor sees a transport
// failure, which is the only shape index.vue will replay. postSession is the single outlet
// for this URL, so one route covers every caller.
export async function dropFirstResponse(page) {
	const state = { firstBody: null, requests: [] }
	// Counted from the browser's own request events, not from inside the handler:
	// route.fetch() must not be allowed to inflate the number the assertion reads.
	page.on('request', (req) => {
		if (req.method() === 'POST' && req.url().includes('/api/share/session')) {
			state.requests.push(req)
		}
	})
	let handled = 0
	await page.route('**/api/share/session', async (route) => {
		handled += 1
		if (handled > 1) {
			await route.continue()
			return
		}
		const response = await route.fetch()
		state.firstBody = await response.json()
		await route.abort('failed')
	})
	return state
}

// AC-SEC-09 ledger. Request objects, not snapshots: allHeaders() is async and only the
// assertion knows which headers it cares about.
export function recordApiRequests(page) {
	const requests = []
	page.on('request', (req) => {
		if (req.url().includes('/api/')) {
			requests.push(req)
		}
	})
	return requests
}

export async function hideTab(page) {
	await page.evaluate(() => {
		Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
		Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
		document.dispatchEvent(new Event('visibilitychange'))
	})
}

export async function showTab(page) {
	await page.evaluate(() => {
		Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
		Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
		document.dispatchEvent(new Event('visibilitychange'))
	})
}

export { OTP_CODE }
