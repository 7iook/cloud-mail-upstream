import { expect, test } from '../fixtures/share.js'

// share-fullchain P1/P2/P3 的 Owner 侧浏览器验收(决策卡必做):
// P1 过期 live 展示、P2 完整邮箱建分享(V2=false 批量分流)、P3 关结果区无二次确认。
// D1 状态跨 run 持久(--persist-to),所以行断言一律用唯一名字过滤。

async function bootAsOwner(page, world) {
	await page.addInitScript((jwt) => {
		localStorage.setItem('token', jwt)
	}, world.seed.ownerJwt)
	await page.goto('/', { waitUntil: 'domcontentloaded' })
}

async function gotoShareAdmin(page) {
	await page.getByRole('menuitem', { name: 'Share' }).click()
	await page.locator('[data-test="wizard-open"]').waitFor()
}

test('the wizard turns two pasted full addresses into two copyable single-share links, and closing needs no confirm (P2 batch split + P3)', async ({ page, world }) => {
	const runTag = `p2-${Date.now()}`
	await bootAsOwner(page, world)
	await gotoShareAdmin(page)

	await page.locator('[data-test="wizard-open"]').click()
	// el-input 把 data-test 透传到原生控件上,所以选择器直指 textarea/input。
	await page.locator('textarea[data-test="wizard-emails"]').fill(`${runTag}-alpha@example.com, ${runTag}-beta@example.com`)
	await page.locator('input[data-test="wizard-name"]').fill(runTag)
	await page.locator('[data-test="wizard-submit"]').click()

	// 批量分流:V2 默认 false,两枚未注册地址 → 两条单分享链接,而不是栅栏错误。
	await expect(page.locator('[data-test="share-url"]')).toHaveCount(2)
	const urls = await page.locator('[data-test="share-url"]').evaluateAll((els) => els.map((el) => el.value))
	for (const url of urls) {
		expect(url).toMatch(/\/s\/[A-Za-z0-9_-]+#/)
	}

	// P3:关闭结果区 = 直接关,不再弹「只显示一次」确认框(凭据可从详情取回)。
	await page.locator('.el-dialog__headerbtn:visible').click()
	await page.waitForTimeout(500)
	await expect(page.locator('.el-message-box')).toHaveCount(0)
	await expect(page.locator('[data-test="wizard-result"]')).toHaveCount(0)
	// 关窗后列表即时刷新出两条新行。
	await expect(page.locator('[data-test="share-row"]').filter({ hasText: runTag })).toHaveCount(2)
})

test('a short-TTL share flips to EXPIRED on-page without reload, survives refresh, and empties the inbox badge (P1)', async ({ page, world }) => {
	const runTag = `p1-live-${Date.now()}`
	// 挂在 Owner 本人账户上:收件箱徽章按 currentAccount 计数。
	await world.api.createShare(world.seed, {
		accountId: world.seed.ownerAccountId,
		durationSeconds: 20,
		name: runTag
	})
	await bootAsOwner(page, world)

	// 收件箱徽章先看到 1 条 ACTIVE。
	await expect(page.locator('[data-test="share-active-count"]')).toHaveText('1')
	await gotoShareAdmin(page)

	const row = page.locator('[data-test="share-row"]').filter({ hasText: runTag })
	await expect(row).toHaveAttribute('data-status', 'ACTIVE')

	// 停在页上不刷新:use-share-clock 的 tick 跨过 expiresAt 后 liveStatus 翻 EXPIRED。
	await expect(row).toHaveAttribute('data-status', 'EXPIRED', { timeout: 30000 })

	// 手动刷新(用户原话的痛点路径)仍是 EXPIRED,无需重新登录。
	await page.reload({ waitUntil: 'domcontentloaded' })
	await expect(page.locator('[data-test="share-row"]').filter({ hasText: runTag })).toHaveAttribute('data-status', 'EXPIRED')

	// 再进收件箱,徽章归零。
	await page.getByRole('menuitem', { name: 'Inbox' }).click()
	await expect(page.locator('[data-test="share-active-count"]')).toHaveText('0')
})
