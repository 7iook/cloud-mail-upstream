import { expect, openShare, test, waitShareState } from '../fixtures/share.js'
import { LIVE_DELIVERY_TIMEOUT_MS, OTP_CODE } from '../harness/constants.js'

test('mail delivered while the page is open appears without a reload (AC-RT-14)', async ({ page, world }) => {
	const share = await world.api.createShare(world.seed)
	await openShare(page, share)
	await waitShareState(page, 'ready')
	await expect(page.locator('[data-share-empty]')).toBeVisible()

	const urlBefore = page.url()
	await world.api.injectEmail({ code: OTP_CODE, subject: 'Arrived while open' })

	await expect(page.locator('[data-share-mail-list]')).toBeVisible({ timeout: LIVE_DELIVERY_TIMEOUT_MS })
	await expect(page.locator('[data-share-code]')).toContainText(OTP_CODE)
	expect(page.url()).toBe(urlBefore)
})
