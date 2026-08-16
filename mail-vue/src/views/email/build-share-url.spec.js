import { describe, expect, it } from 'vitest'
import { buildShareUrl } from './build-share-url.js'

describe('buildShareUrl (AC-LEAK-01)', () => {
    it('places sec only in the URL fragment, never in the path or query', () => {
        const url = buildShareUrl('https://mail.example', 'lid-abc', 'sec-secret')
        const parsed = new URL(url)
        expect(parsed.pathname).toBe('/s/lid-abc')
        expect(parsed.search).toBe('')
        expect(parsed.hash).toBe('#sec-secret')
        expect(url).not.toContain('?sec=')
        expect(url).not.toMatch(/\/sec-secret(?:\/|$|\?)/)
    })
})
