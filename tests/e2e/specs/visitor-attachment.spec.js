import { expect, openShare, test, waitShareState } from '../fixtures/share.js'
import { ATTACHMENT_BODY, ATTACHMENT_NAME, OTP_CODE } from '../harness/constants.js'

test('an attachment downloads through the controlled endpoint and fails after revoke (P-ATT-01)', async ({ page, world }) => {
	const share = await world.api.createShare(world.seed)
	await world.api.injectEmail({ code: OTP_CODE, subject: 'Has attachment', withAttachment: true })
	await openShare(page, share)
	await waitShareState(page, 'ready')

	const downloadPromise = page.waitForEvent('download')
	await page.locator('[data-share-attachment]').click()
	const download = await downloadPromise
	expect(download.suggestedFilename()).toBe(ATTACHMENT_NAME)
	const file = await download.path()
	expect(file).toBeTruthy()
	const bytes = await download.createReadStream().then(async (stream) => {
		const chunks = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}
		return Buffer.concat(chunks).toString('utf8')
	})
	expect(String(bytes).replace(/\s+$/g, '')).toBe(ATTACHMENT_BODY)

	// P4:撤销后的下载请求撞上裸 404(SHARE_DESTROYED),SPA reload 一次并落在
	// worker 文档拦截给出的浏览器原生 404 上,不再回 unavailable 壳。
	await world.api.revokeShare(world.seed, share.shareId)
	const goneDocument = page.waitForResponse((res) =>
		res.request().resourceType() === 'document'
		&& res.url().includes(`/s/${share.lid}`)
		&& res.status() === 404
	)
	await page.locator('[data-share-attachment]').click()
	const gone = await goneDocument
	expect(await gone.text()).toBe('')
	await page.waitForLoadState('domcontentloaded')
	await expect(page.locator('[data-share-shell]')).toHaveCount(0)
	await expect(page.locator('[data-share-body]')).toHaveCount(0)
})
