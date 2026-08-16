import { expect, openShare, sessionKeys, test, waitShareState } from '../fixtures/share.js'
import { OTP_CODE } from '../harness/constants.js'

test('refresh keeps the session; leaving the route and opening a second share do not inherit it (AC-VISIT-12 to 15)', async ({ page, world }) => {
	const first = await world.api.createShare(world.seed)
	await world.api.injectEmail({ code: OTP_CODE, subject: 'First share mail' })
	const second = await world.api.createShare(world.seed)

	await openShare(page, first)
	await waitShareState(page, 'ready')
	await expect(page.locator('[data-share-code]')).toContainText(OTP_CODE)

	const afterOpen = await sessionKeys(page)
	expect(afterOpen).toContain(`share:session:${first.lid}`)
	expect(page.url()).not.toContain('#')

	await page.reload({ waitUntil: 'domcontentloaded' })
	await waitShareState(page, 'ready')
	await expect(page.locator('[data-share-code]')).toContainText(OTP_CODE)
	const afterReload = await sessionKeys(page)
	expect(afterReload).toContain(`share:session:${first.lid}`)

	await page.evaluate(() => {
		const app = document.querySelector('#app')
		const router = app && app.__vue_app__ && app.__vue_app__.config.globalProperties.$router
		if (!router) {
			throw new Error('vue router is not on #app')
		}
		return router.push({ name: 'login' })
	})
	await page.waitForURL(/\/login/)
	const afterLeave = await sessionKeys(page)
	expect(afterLeave).not.toContain(`share:session:${first.lid}`)

	await openShare(page, second)
	await waitShareState(page, 'ready')
	const afterSecond = await sessionKeys(page)
	expect(afterSecond).toContain(`share:session:${second.lid}`)
	expect(afterSecond).not.toContain(`share:session:${first.lid}`)
	await expect(page.locator('[data-share-code]')).toHaveCount(0)
})
