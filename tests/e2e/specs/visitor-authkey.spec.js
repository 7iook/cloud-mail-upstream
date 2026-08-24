import { expect, openShare, recordApiRequests, sessionKeys, test, waitShareState } from '../fixtures/share.js'

// AC-AUTH-01 · AC-SEC-09. This is the only moment where all three credentials — sec, the
// AuthKey plaintext and a sessionToken — are in play at once, so the leak audit lives here.
test('a wrong access key is retryable and free, the right one opens the share, and no credential rides in a URL or Referer (AC-AUTH-01, AC-SEC-09)', async ({ page, world }) => {
	await world.api.setCapabilityV2(true)
	const share = await world.api.createShare(world.seed, { authKeyEnabled: true })
	expect(share.authKey).toBeTruthy()
	const requests = recordApiRequests(page)

	await openShare(page, share)
	await waitShareState(page, 'authRequired')
	// Written before the first POST went out, so every attempt replays under one key.
	expect(await sessionKeys(page)).toContain(`share:est-key:${share.lid}`)

	await page.locator('[data-share-auth-input]').fill('not-the-access-key')
	await page.locator('[data-share-auth-submit]').click()
	await expect(page.locator('[data-share-auth-error]')).toBeVisible()
	await waitShareState(page, 'authRequired')
	// The core half of AC-AUTH-01: a wrong key SHALL NOT spend a session slot.
	expect((await world.api.getShare(world.seed, share.shareId)).usedSessions).toBe(0)

	await page.locator('[data-share-auth-input]').fill(share.authKey)
	await page.locator('[data-share-auth-submit]').click()
	await waitShareState(page, 'ready')
	const keys = await sessionKeys(page)
	expect(keys).toContain(`share:session:${share.lid}`)
	expect(keys).not.toContain(`share:est-key:${share.lid}`)
	expect((await world.api.getShare(world.seed, share.shareId)).usedSessions).toBe(1)

	const sessionToken = await page.evaluate(
		(lid) => sessionStorage.getItem(`share:session:${lid}`),
		share.lid
	)
	expect(requests.length).toBeGreaterThan(0)
	for (const req of requests) {
		const headers = await req.allHeaders()
		for (const secret of [share.sec, share.authKey, sessionToken]) {
			expect(req.url()).not.toContain(secret)
			expect(headers.referer || '').not.toContain(secret)
		}
		for (const [name, value] of Object.entries(headers)) {
			// sec and the AuthKey travel in the request body and belong in no header at all.
			// The sessionToken is a bearer credential, so Authorization is exactly where it
			// is supposed to be; Idempotency-Key is a replay tag, not a credential.
			expect(value).not.toContain(share.sec)
			expect(value).not.toContain(share.authKey)
			if (name !== 'authorization') {
				expect(value).not.toContain(sessionToken)
			}
		}
	}
	// The server-log half of AC-SEC-09 is not observable from here: harness/start.mjs runs
	// wrangler with stdio 'inherit', so Playwright never sees its stdout. logShareEvent's
	// field allowlist is covered in mail-worker/test/mail-share-service.spec.js instead.
})
