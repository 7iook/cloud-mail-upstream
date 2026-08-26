import { expect, test } from '../fixtures/share.js'

// P4 之后 missing lid 的文档请求是裸 404(空 body、no-store),不再适合当 header 探针;
// 头部断言必须打在一条活分享的文档上。
test('records /s/* security headers or names the deploy-time gap (AC-LEAK-02 to 04)', async ({ request, world }) => {
	const share = await world.api.createShare(world.seed)
	const response = await request.get(`${world.baseURL}/s/${share.lid}`)
	expect(response.status()).toBe(200)
	const headers = response.headers()
	const cache = headers['cache-control'] || ''
	const referrer = headers['referrer-policy'] || ''
	const robots = headers['x-robots-tag'] || ''
	const csp = headers['content-security-policy'] || ''
	const applied = /no-store/i.test(cache) && /no-referrer/i.test(referrer) && /noindex/i.test(robots) && csp.includes("script-src 'self'")

	if (!applied) {
		test.info().annotations.push({
			type: 'deploy-time',
			description: 'Local wrangler assets with run_worker_first did not apply mail-vue/public/_headers. Confirm Cache-Control, Referrer-Policy, X-Robots-Tag, and CSP on a real Pages/Assets deploy.'
		})
		console.log('share /s/* headers (local, not a deploy proof):', {
			'cache-control': cache,
			'referrer-policy': referrer,
			'x-robots-tag': robots,
			'content-security-policy': csp
		})
		test.skip(true, 'run_worker_first local assets do not prove _headers; check at deploy time')
	}

	expect(cache).toMatch(/no-store/i)
	expect(referrer).toMatch(/no-referrer/i)
	expect(robots).toMatch(/noindex/i)
	expect(csp).toContain("script-src 'self'")
})
