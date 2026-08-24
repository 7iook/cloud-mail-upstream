import { dropFirstResponse, expect, openShare, test, waitShareState } from '../fixtures/share.js'

// AC-SESS-10. The lost response has to be injected inside the browser: anything a worker
// can answer with — 500, an empty body, a business envelope — still reaches axios as
// err.response, and index.vue:625-632 reads that as "the server did answer" and refuses to
// replay. Only a transport failure after the request was already committed looks lost.
test('a session response lost in transit replays under the same Idempotency-Key and spends one slot (AC-SESS-10)', async ({ page, world }) => {
	await world.api.setCapabilityV2(true)
	const share = await world.api.createShare(world.seed, { maxSessions: 1 })
	const dropped = await dropFirstResponse(page)

	await openShare(page, share)
	await waitShareState(page, 'ready')

	expect(dropped.requests.length).toBe(2)
	const firstKey = await dropped.requests[0].headerValue('idempotency-key')
	const secondKey = await dropped.requests[1].headerValue('idempotency-key')
	expect(firstKey).toBeTruthy()
	expect(secondKey).toBe(firstKey)

	// The token the visitor ended up with is the one the dropped response carried, so the
	// second POST was answered from the replay cache rather than minting a new session.
	const stored = await page.evaluate((lid) => sessionStorage.getItem(`share:session:${lid}`), share.lid)
	expect(stored).toBe(dropped.firstBody.data.sessionToken)

	const detail = await world.api.getShare(world.seed, share.shareId)
	expect(detail.usedSessions).toBe(1)
})
