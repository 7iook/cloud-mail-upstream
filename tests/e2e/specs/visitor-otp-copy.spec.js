import { expect, openShare, test, waitShareState } from '../fixtures/share.js'
import { OTP_CODE } from '../harness/constants.js'

test('copying the verification code lands it on the clipboard (AC-OTP-08)', async ({ page, world }) => {
	const share = await world.api.createShare(world.seed)
	await world.api.injectEmail({ code: OTP_CODE, subject: 'Copy me' })
	await openShare(page, share)
	await waitShareState(page, 'ready')
	await expect(page.locator('[data-share-code]')).toContainText(OTP_CODE)

	await page.locator('[data-share-copy]').click()
	await expect(page.locator('[data-share-copy-result]')).toHaveAttribute('data-share-copy-result', 'copied')
	const clipboard = await page.evaluate(() => navigator.clipboard.readText())
	expect(clipboard).toBe(OTP_CODE)
})
