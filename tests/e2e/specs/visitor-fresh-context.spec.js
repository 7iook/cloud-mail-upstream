import { expect, openShare, test, waitShareState } from '../fixtures/share.js'
import { OTP_CODE } from '../harness/constants.js'

test('a never-logged-in browser sees in-window mail from a valid link', async ({ page, world }) => {
	const share = await world.api.createShare(world.seed)
	await world.api.injectEmail({ code: OTP_CODE, subject: 'Fresh context code' })
	await openShare(page, share)
	await waitShareState(page, 'ready')

	const storage = await page.evaluate(async () => ({
		token: localStorage.getItem('token'),
		localKeys: Object.keys(localStorage),
		idb: indexedDB.databases ? await indexedDB.databases() : []
	}))
	expect(storage.token).toBeNull()
	expect(storage.localKeys).not.toContain('token')
	expect(storage.idb).toEqual([])

	await expect(page.locator('[data-share-mail-list]')).toBeVisible()
	await expect(page.locator('[data-share-code]')).toContainText(OTP_CODE)
	await expect(page.locator('[data-share-code-from]')).toContainText('E2E Sender')
	await expect(page).toHaveURL(new RegExp(`/s/${share.lid}$`))
	expect(page.url()).not.toContain('#')
	expect(page.url()).not.toContain(share.sec)
})
