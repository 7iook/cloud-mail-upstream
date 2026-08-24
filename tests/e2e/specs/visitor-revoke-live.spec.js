import { expect, openShare, sessionKeys, test, waitShareState } from '../fixtures/share.js'
import { POLL_INTERVAL_MS } from '../harness/constants.js'

// AC-EDGE-03. SHARE_CAPABILITY_V2 stays at its default (off) here: revocation is not one of
// the gated capabilities, and leaving the flag alone keeps that visible.
test('revoking mid-visit stops the polling, drops the credentials and shows the same dead shell (AC-EDGE-03)', async ({ page, world }) => {
	const share = await world.api.createShare(world.seed)
	await openShare(page, share)
	await waitShareState(page, 'ready')
	// One status frame has landed, so share:status:<lid> exists and the later assertion
	// that it survived is about survival rather than about it never having been written.
	await page.waitForFunction(
		(lid) => sessionStorage.getItem(`share:status:${lid}`) !== null,
		share.lid
	)

	const shareRequests = []
	page.on('request', (req) => {
		if (req.url().includes('/api/share/')) {
			shareRequests.push({ at: Date.now(), url: req.url() })
		}
	})

	await world.api.revokeShare(world.seed, share.shareId)
	await waitShareState(page, 'unavailable')

	// Counted only from here. Reaching unavailable costs one extra POST /share/session —
	// recoverFromUnavailable retries once while pageSecret is still in memory. That is
	// frozen T-26 behaviour, not something this spec is allowed to "fix".
	const deadAt = Date.now()
	await page.waitForTimeout(POLL_INTERVAL_MS + 1500)
	expect(shareRequests.filter((item) => item.at > deadAt)).toEqual([])

	const keys = await sessionKeys(page)
	expect(keys).not.toContain(`share:session:${share.lid}`)
	expect(keys).not.toContain(`share:est-key:${share.lid}`)
	// Read progress is not a credential and deliberately stays.
	expect(keys).toContain(`share:status:${share.lid}`)

	// Shell against shell, never against a literal: a revoked link must be
	// indistinguishable from a lid that never existed, and T-29 may still change the copy.
	// The countdown is read separately rather than folded into the message: showDeadShare
	// clears the mailbox view but not expiresAt, so a share revoked mid-visit keeps
	// rendering [data-share-expires] while a random lid never had one. That residue is a
	// mail-vue defect, and mail-vue is outside this task's file whitelist — it is recorded
	// in exec-t27-note.md rather than pinned here, so the fix will not turn this red.
	const deadShell = async () => ({
		message: await page.locator('[data-share-shell] header p').innerText(),
		body: await page.locator('[data-share-body]').innerText(),
		liveParts: await page.locator('[data-share-mail-list], [data-share-code], [data-share-auth], [data-share-empty], [data-share-exit], [data-share-refresh], [data-share-tabs]').count()
	})
	const revoked = await deadShell()
	await page.goto('/s/not-a-real-lid#not-a-real-sec', { waitUntil: 'domcontentloaded' })
	await waitShareState(page, 'unavailable')
	expect(revoked).toEqual(await deadShell())
})
