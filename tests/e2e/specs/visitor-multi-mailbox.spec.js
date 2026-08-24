import { expect, openShare, test, waitShareState } from '../fixtures/share.js'
import { MAILBOX_2, OTP_CODE_2 } from '../harness/constants.js'

// AC-OTP-04 · AC-CAP-02 · AC-SEC-01. A never-logged-in browser opens a two-mailbox link,
// switches between native Tabs, is badged for mail that lands on the Tab it is not looking
// at, and copies that mailbox's code.
test('a two-mailbox link renders Tabs, badges the idle Tab and copies its code (AC-OTP-04, AC-CAP-02, AC-SEC-01)', async ({ page, world }) => {
	await world.api.setCapabilityV2(true)
	const share = await world.api.createShare(world.seed, {
		accountIds: [world.seed.accountId, world.seed.accountId2]
	})

	await openShare(page, share)
	await waitShareState(page, 'ready')

	const tabs = page.locator('[data-share-tab]')
	await expect(page.locator('[data-share-tabs]')).toHaveCount(1)
	await expect(tabs).toHaveCount(2)
	await expect(page.locator('[data-share-tab][aria-selected="true"]')).toHaveCount(1)
	await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')

	// Data-derived, not copy: the label is the masked projection, never the address itself.
	const labels = await tabs.allInnerTexts()
	for (const label of labels) {
		expect(label).not.toContain(world.seed.mailbox)
		expect(label).not.toContain(world.seed.mailbox2)
	}

	// Delivery must follow the first status frame, not merely `ready`: reconcile seeds every
	// Binding's watermark to its current head the first time it sees that Binding, so a mail
	// that lands before the seeding frame is inside the baseline and never badges.
	// share:status:<lid> appearing is that frame having happened.
	await page.waitForFunction(
		(lid) => sessionStorage.getItem(`share:status:${lid}`) !== null,
		share.lid
	)
	await world.api.injectEmail({ to: MAILBOX_2, code: OTP_CODE_2, subject: 'Second mailbox mail' })
	await expect(tabs.nth(1).locator('[data-share-tab-badge]')).toHaveCount(1)
	await expect(tabs.nth(0).locator('[data-share-tab-badge]')).toHaveCount(0)

	await tabs.nth(1).click()
	await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
	await expect(page.locator('[data-share-code]')).toContainText(OTP_CODE_2)

	await page.locator('[data-share-copy]').click()
	await expect(page.locator('[data-share-copy-result]')).toHaveAttribute('data-share-copy-result', 'copied')
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(OTP_CODE_2)

	// Going back proves the badge was consumed rather than merely hidden by selection.
	await tabs.nth(0).click()
	await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
	await expect(page.locator('[data-share-tab-badge]')).toHaveCount(0)

	// Equality, not a substring hunt: the path is exactly the lid, which is what makes
	// "no account id, no address, no sec in the URL" true rather than merely unobserved.
	// A `not.toContain(accountId)` check would be a lie anyway — "127.0.0.1" contains "2".
	const url = new URL(page.url())
	expect(url.pathname).toBe(`/s/${share.lid}`)
	expect(url.search).toBe('')
	expect(url.hash).toBe('')
	expect(page.url()).not.toContain(world.seed.mailbox)
	expect(page.url()).not.toContain(world.seed.mailbox2)
})
