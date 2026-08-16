import { expect, openShare, test, waitShareState } from '../fixtures/share.js'
import { OTP_CODE } from '../harness/constants.js'

test('share page still renders when websiteConfig fails (AC-VISIT-01)', async ({ page, world }) => {
	await page.route('**/setting/websiteConfig', (route) => {
		return route.abort('failed')
	})

	const share = await world.api.createShare(world.seed)
	await world.api.injectEmail({ code: OTP_CODE, subject: 'Config down' })
	await openShare(page, share)

	const app = page.locator('#app')
	await expect(app).not.toBeEmpty()
	await waitShareState(page, 'ready')
	await expect(page.locator('[data-share-mail-list]')).toBeVisible()
	await expect(page.locator('[data-share-code]')).toContainText(OTP_CODE)
	await expect(page).toHaveURL(new RegExp(`/s/${share.lid}$`))
})
