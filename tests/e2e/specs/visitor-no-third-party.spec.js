import { expect, openShare, test, waitShareState } from '../fixtures/share.js'
import { OTP_CODE } from '../harness/constants.js'

function isThirdPartyScript(url, origin) {
	if (url.startsWith('blob:') || url.startsWith('data:')) {
		return false
	}
	try {
		const parsed = new URL(url)
		if (parsed.origin === origin) {
			return false
		}
		return parsed.protocol === 'http:' || parsed.protocol === 'https:'
	} catch {
		return false
	}
}

test('the share page loads no third-party scripts (AC-VISIT-10)', async ({ page, world, baseURL }) => {
	const origin = new URL(baseURL).origin
	const scriptUrls = []
	page.on('request', (req) => {
		const type = req.resourceType()
		if (type === 'script') {
			scriptUrls.push(req.url())
		}
	})

	const share = await world.api.createShare(world.seed)
	await world.api.injectEmail({ code: OTP_CODE, subject: 'No third party' })
	await openShare(page, share)
	await waitShareState(page, 'ready')

	const thirdParty = scriptUrls.filter((url) => isThirdPartyScript(url, origin))
	expect(thirdParty, `third-party scripts: ${thirdParty.join(', ')}`).toEqual([])

	const pageScripts = await page.evaluate(() => {
		return [...document.querySelectorAll('script[src]')].map((node) => node.getAttribute('src') || '')
	})
	const remote = pageScripts.filter((src) => /^https?:\/\//i.test(src) && !src.startsWith(origin))
	expect(remote, `remote script tags: ${remote.join(', ')}`).toEqual([])
})
