import { expect, openShare, test, waitShareState } from '../fixtures/share.js'
import { POLL_INTERVAL_MS } from '../harness/constants.js'

// AC-EDGE-03 × P4:撤销后访客的下一次轮询撞上裸 404(SHARE_DESTROYED)。SPA 清掉
// 凭据、记账 share:gone:<lid> 并 reload 一次;reload 的文档请求被 index.js 在 assets
// 之前拦截,访客最终落在浏览器原生 404 上 —— 不再是 SPA 的 unavailable 壳。
// 凭据清理(share:session / share:est-key)在 index.spec.js 单测里钉死;原生 404 页
// 属 chrome-error 源,e2e 无法再 evaluate sessionStorage。
test('revoking mid-visit reloads the visitor onto a native 404, not the SPA shell (AC-EDGE-03 / P4)', async ({ page, world }) => {
	const share = await world.api.createShare(world.seed)
	await openShare(page, share)
	await waitShareState(page, 'ready')

	// The reload is page-initiated (location.reload), so the only observable handoff is
	// the next document request for /s/<lid> coming back 404.
	const goneDocument = page.waitForResponse((res) =>
		res.request().resourceType() === 'document'
		&& res.url().includes(`/s/${share.lid}`)
		&& res.status() === 404
	)
	await world.api.revokeShare(world.seed, share.shareId)
	const response = await goneDocument
	expect(await response.text()).toBe('')

	await page.waitForLoadState('domcontentloaded')
	// Native 404 = zero business DOM. A revoked link is now indistinguishable from a lid
	// that never existed at the document layer, not just in the shell copy.
	await expect(page.locator('[data-share-shell]')).toHaveCount(0)
	await expect(page.locator('[data-share-body]')).toHaveCount(0)

	// The page is dead: nothing polls from a native 404.
	const shareRequests = []
	page.on('request', (req) => {
		if (req.url().includes('/api/share/')) {
			shareRequests.push(req.url())
		}
	})
	await page.waitForTimeout(POLL_INTERVAL_MS + 1500)
	expect(shareRequests).toEqual([])
})
