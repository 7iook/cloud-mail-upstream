import { beforeEach, describe, expect, it, vi } from 'vitest'

const { http } = vi.hoisted(() => ({
    http: {
        post: vi.fn(),
        get: vi.fn(),
        delete: vi.fn()
    }
}))

vi.mock('@/axios/index.js', () => ({
    default: http
}))

import { createMailShare, listMailShares, revokeMailShare } from './mail-share.js'

describe('owner mail-share request (logged-in axios)', () => {
    beforeEach(() => {
        http.post.mockReset()
        http.get.mockReset()
        http.delete.mockReset()
        http.post.mockResolvedValue({ shareId: 1, lid: 'lid', sec: 'sec', shareUrl: 'https://x/s/lid#sec' })
        http.get.mockResolvedValue({ list: [], total: 0 })
        http.delete.mockResolvedValue({ shareId: 1 })
    })

    it('sends Idempotency-Key on create so a retry cannot mint a second share (AC-SHARE-11)', async () => {
        await createMailShare({
            accountId: 11,
            durationSeconds: 3600,
            name: 'desk',
            remark: 'otp'
        }, 'owner-create-key-1')

        expect(http.post).toHaveBeenCalledTimes(1)
        const [url, body, config] = http.post.mock.calls[0]
        expect(url).toBe('/mailShare/create')
        expect(body).toEqual({
            accountId: 11,
            durationSeconds: 3600,
            name: 'desk',
            remark: 'otp'
        })
        expect(config.headers['Idempotency-Key']).toBe('owner-create-key-1')
    })

    it('lists and revokes through the logged-in client, not the anonymous share client', async () => {
        await listMailShares()
        await revokeMailShare(9)
        expect(http.get).toHaveBeenCalledWith('/mailShare/list')
        expect(http.delete).toHaveBeenCalledWith('/mailShare/revoke', { params: { shareId: 9 } })
    })
})
