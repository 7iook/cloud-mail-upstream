import { expect, hideTab, openShare, showTab, test, waitShareState } from '../fixtures/share.js'
import { LIVE_DELIVERY_TIMEOUT_MS, OTP_CODE, POLL_INTERVAL_MS } from '../harness/constants.js'

test('backgrounding the tab pauses polling and resume shows new mail (AC-RT-05)', async ({ page, world }) => {
	const share = await world.api.createShare(world.seed)
	const pollUrls = []
	page.on('request', (req) => {
		if (req.url().includes('/share/mails')) {
			pollUrls.push({ at: Date.now(), hidden: null, url: req.url() })
		}
	})

	await openShare(page, share)
	await waitShareState(page, 'ready')
	await expect(page.locator('[data-share-empty]')).toBeVisible()

	const beforeHide = pollUrls.length
	await hideTab(page)
	const hiddenAt = Date.now()
	await page.waitForTimeout(POLL_INTERVAL_MS + 1500)
	const whileHidden = pollUrls.filter((item) => item.at > hiddenAt)
	expect(whileHidden.length).toBe(0)
	expect(pollUrls.length).toBe(beforeHide)

	await world.api.injectEmail({ code: OTP_CODE, subject: 'Arrived in background' })
	await page.waitForTimeout(POLL_INTERVAL_MS + 500)
	await expect(page.locator('[data-share-empty]')).toBeVisible()

	await showTab(page)
	await expect(page.locator('[data-share-mail-list]')).toBeVisible({ timeout: LIVE_DELIVERY_TIMEOUT_MS })
	await expect(page.locator('[data-share-code]')).toContainText(OTP_CODE)
})
