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
