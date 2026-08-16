import { expect, openShare, sessionKeys, test, waitShareState } from '../fixtures/share.js'
import { OTP_CODE, POLL_INTERVAL_MS } from '../harness/constants.js'

const SHORT_TTL_SECONDS = 2

test('a page left polling past session TTL recovers silently and never claims the share is gone (AC-VISIT-11, AC-VISIT-12, AC-RT-14, AC-RT-16)', async ({ page, world }) => {
	await world.api.setSessionTtl(SHORT_TTL_SECONDS)
	const share = await world.api.createShare(world.seed)
	await world.api.injectEmail({ code: OTP_CODE, subject: 'Wait for code' })

	await openShare(page, share)
	await waitShareState(page, 'ready')
	await expect(page.locator('[data-share-code]')).toContainText(OTP_CODE)
	expect(page.url()).not.toContain('#')
	expect(page.url()).not.toContain(share.sec)

	await page.waitForTimeout((SHORT_TTL_SECONDS * 1000) + POLL_INTERVAL_MS + 2000)

	const state = await page.locator('[data-share-state]').getAttribute('data-share-state')
	expect(['ready', 'timedout']).toContain(state)
	await expect(page.locator('[data-share-shell]')).not.toContainText(/no longer available/i)
	if (state === 'ready') {
		await expect(page.locator('[data-share-code]')).toContainText(OTP_CODE)
	} else {
		await expect(page.locator('[data-share-shell]')).toContainText(/timed out/i)
		await expect(page.locator('[data-share-shell]')).toContainText(/original link/i)
	}
})

test('reload after session TTL shows timed-out, not a dead link (AC-VISIT-12, AC-VISIT-14)', async ({ page, world }) => {
	await world.api.setSessionTtl(SHORT_TTL_SECONDS)
	const share = await world.api.createShare(world.seed)
	await world.api.injectEmail({ code: OTP_CODE, subject: 'Reload after ttl' })

	await openShare(page, share)
	await waitShareState(page, 'ready')
	await expect(page.locator('[data-share-code]')).toContainText(OTP_CODE)

	await page.waitForTimeout((SHORT_TTL_SECONDS * 1000) + 500)
	await page.reload({ waitUntil: 'domcontentloaded' })

	await waitShareState(page, 'timedout')
	await expect(page.locator('[data-share-shell]')).toContainText(/timed out/i)
	await expect(page.locator('[data-share-shell]')).toContainText(/original link/i)
	await expect(page.locator('[data-share-shell]')).not.toContainText(/no longer available/i)
	await expect(page.locator('[data-share-mail-list]')).toHaveCount(0)
	await expect(page.locator('[data-share-code]')).toHaveCount(0)
	const keys = await sessionKeys(page)
	expect(keys).not.toContain(`share:session:${share.lid}`)
})
