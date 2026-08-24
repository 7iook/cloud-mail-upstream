import { expect, newVisitor, openShare, sessionKeys, test, waitShareState } from '../fixtures/share.js'

// AC-SESS-04 · AC-SESS-07.
test('a one-session share admits the first visitor and turns the second away for free (AC-SESS-04, AC-SESS-07)', async ({ browser, page, world }) => {
	await world.api.setCapabilityV2(true)
	const share = await world.api.createShare(world.seed, { maxSessions: 1 })

	await openShare(page, share)
	await waitShareState(page, 'ready')
	expect((await world.api.getShare(world.seed, share.shareId)).usedSessions).toBe(1)

	const second = await newVisitor(browser)
	try {
		await openShare(second.page, share)
		await waitShareState(second.page, 'unavailable')
		expect(await sessionKeys(second.page)).not.toContain(`share:session:${share.lid}`)
		// A refusal is free: the quota gate is one conditional UPDATE and it never runs for
		// a session that was denied.
		expect((await world.api.getShare(world.seed, share.shareId)).usedSessions).toBe(1)
	} finally {
		await second.context.close()
	}

	// An exhausted cap refuses new sessions; it does not kill the one holding the slot.
	await waitShareState(page, 'ready')
	expect(await sessionKeys(page)).toContain(`share:session:${share.lid}`)
})
