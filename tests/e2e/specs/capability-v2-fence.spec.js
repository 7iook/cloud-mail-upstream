import { expect, test } from '../fixtures/share.js'

// AC-LIFE-11 over real HTTP and real D1, plus as much of AC-LIFE-10 path ④ as e2e can
// honestly carry. That path claims a universal negative on the write side — "while the flag
// is off, no policy an old Worker cannot execute is ever written" — which is already pinned
// by mail-worker/test/share-integration.spec.js:1148 and mail-share-service.spec.js:3096.
// This repository has a single worker entry point, so no second binary is built to route
// between. The fifth gated intent, message_limit, is outside the four tasked paths and is
// covered by mail-worker/test/mail-share-service.spec.js:1290.
test('the flag refuses all four restricted writes and lets the same four through once it is on (AC-LIFE-11, AC-LIFE-10)', async ({ world }) => {
	const { seed } = world
	const call = world.api.api
	const token = seed.ownerJwt
	const listTotal = async () => {
		const out = await call('GET', '/mailShare/list?page=1&size=1', { token })
		return out.json.data.total
	}
	const createBody = (extra) => ({
		accountId: seed.accountId,
		durationSeconds: 3600,
		name: 'fence',
		...extra
	})

	// Already the state every test starts in; saying it out loud is the point of the spec.
	await world.api.setCapabilityV2(false)
	const before = await listTotal()

	// ① multi create ③ AuthKey at create ④ finite maxSessions at create
	const multi = await call('POST', '/mailShare/create', { token, body: createBody({ accountIds: [seed.accountId, seed.accountId2] }) })
	const keyed = await call('POST', '/mailShare/create', { token, body: createBody({ authKeyEnabled: true }) })
	const capped = await call('POST', '/mailShare/create', { token, body: createBody({ maxSessions: 1 }) })
	expect(multi.json.message).toBe('SHARE_INVALID_CONFIG')
	expect(keyed.json.message).toBe('SHARE_INVALID_CONFIG')
	expect(capped.json.message).toBe('SHARE_INVALID_CONFIG')
	// Refused means nothing landed, not that it landed and was hidden.
	expect(await listTotal()).toBe(before)

	// A plain single-mailbox share is still allowed with the flag off, and it is the subject
	// the remaining three refusals are attempted against.
	const plain = await world.api.createShare(seed, { name: 'fence-plain' })
	expect(await listTotal()).toBe(before + 1)

	// ② bindings 1 → N
	const expand = await call('PUT', '/mailShare/bindings', { token, body: { shareId: plain.shareId, add: [seed.accountId2] } })
	expect(expand.json.message).toBe('SHARE_INVALID_CONFIG')
	expect((await world.api.getShare(seed, plain.shareId)).bindings.length).toBe(1)

	// ③ AuthKey through its only write entry point
	const enable = await call('POST', '/mailShare/resetAuthKey', { token, body: { shareId: plain.shareId, action: 'enable' } })
	expect(enable.json.message).toBe('SHARE_INVALID_CONFIG')
	expect((await world.api.getShare(seed, plain.shareId)).authKeyEnabled).toBe(false)

	// ④ finite maxSessions through update
	const cap = await call('PUT', '/mailShare/update', { token, body: { shareId: plain.shareId, maxSessions: 1 } })
	expect(cap.json.message).toBe('SHARE_INVALID_CONFIG')
	expect((await world.api.getShare(seed, plain.shareId)).maxSessions).toBe(null)

	// WHEN the flag is on, the same four are allowed.
	await world.api.setCapabilityV2(true)
	const multiOn = await call('POST', '/mailShare/create', { token, body: createBody({ accountIds: [seed.accountId, seed.accountId2] }) })
	const expandOn = await call('PUT', '/mailShare/bindings', { token, body: { shareId: plain.shareId, add: [seed.accountId2] } })
	const enableOn = await call('POST', '/mailShare/resetAuthKey', { token, body: { shareId: plain.shareId, action: 'enable' } })
	const capOn = await call('PUT', '/mailShare/update', { token, body: { shareId: plain.shareId, maxSessions: 1 } })
	expect(multiOn.json.code).toBe(200)
	expect(expandOn.json.code).toBe(200)
	expect(enableOn.json.code).toBe(200)
	expect(capOn.json.code).toBe(200)
})
