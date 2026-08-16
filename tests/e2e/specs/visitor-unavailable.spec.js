import { expect, openShare, test, waitShareState } from '../fixtures/share.js'
import { OTP_CODE } from '../harness/constants.js'

async function expectUnavailable(page) {
	await waitShareState(page, 'unavailable')
	await expect(page.locator('[data-share-mail-list]')).toHaveCount(0)
	await expect(page.locator('[data-share-code]')).toHaveCount(0)
	await expect(page.locator('[data-share-body]')).not.toContainText(OTP_CODE)
}

test('a random lid, an expired share, and a revoked share show the same unavailable state (AC-VISIT-04)', async ({ page, world }) => {
	await page.goto('/s/not-a-real-lid#not-a-real-sec', { waitUntil: 'domcontentloaded' })
	await expectUnavailable(page)
	const randomText = await page.locator('[data-share-shell]').innerText()

	const expired = await world.api.createShare(world.seed)
	await world.api.injectEmail({ code: OTP_CODE, subject: 'Should vanish after expiry' })
	await world.api.expireShare(expired.lid)
	await openShare(page, expired)
	await expectUnavailable(page)
	const expiredText = await page.locator('[data-share-shell]').innerText()

	const revoked = await world.api.createShare(world.seed)
	await world.api.revokeShare(world.seed, revoked.shareId)
	await openShare(page, revoked)
	await expectUnavailable(page)
	const revokedText = await page.locator('[data-share-shell]').innerText()

	expect(expiredText).toBe(randomText)
	expect(revokedText).toBe(randomText)
})
