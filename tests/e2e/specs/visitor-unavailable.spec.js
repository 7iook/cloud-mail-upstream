import { expect, test, waitShareState } from '../fixtures/share.js'
import { OTP_CODE } from '../harness/constants.js'

// P4 拆分 AC-VISIT-04(决策卡记入 shipped spec changelog 的有意收缩):
// gone(不存在 / 已销毁)= 浏览器原生 404,空 body,零业务 DOM;
// EXPIRED 仍是 SPA 的 unavailable 壳。两族从此可区分。

async function expectUnavailableShell(page) {
	await waitShareState(page, 'unavailable')
	await expect(page.locator('[data-share-mail-list]')).toHaveCount(0)
	await expect(page.locator('[data-share-code]')).toHaveCount(0)
	await expect(page.locator('[data-share-body]')).not.toContainText(OTP_CODE)
}

async function expectNativeGone(page, path) {
	const response = await page.goto(path, { waitUntil: 'domcontentloaded' })
	expect(response.status()).toBe(404)
	expect(await response.text()).toBe('')
	await expect(page.locator('[data-share-shell]')).toHaveCount(0)
	await expect(page.locator('[data-share-body]')).toHaveCount(0)
}

test('a lid that never existed answers a native 404: empty body, no business DOM (P4)', async ({ page, world }) => {
	void world
	await expectNativeGone(page, '/s/not-a-real-lid#not-a-real-sec')
})

test('a revoked share answers the same native 404 on direct navigation (P4)', async ({ page, world }) => {
	const revoked = await world.api.createShare(world.seed)
	await world.api.revokeShare(world.seed, revoked.shareId)
	await expectNativeGone(page, `/s/${revoked.lid}#${revoked.sec}`)
})

test('an expired share still lands on the SPA unavailable shell, never a 404 (AC-VISIT-04 expired arm)', async ({ page, world }) => {
	const expired = await world.api.createShare(world.seed)
	await world.api.injectEmail({ code: OTP_CODE, subject: 'Should vanish after expiry' })
	await world.api.expireShare(expired.lid)

	const response = await page.goto(`/s/${expired.lid}#${expired.sec}`, { waitUntil: 'domcontentloaded' })
	expect(response.status()).toBe(200)
	await expectUnavailableShell(page)
})
