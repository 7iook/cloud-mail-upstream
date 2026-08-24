import { beforeEach, describe, expect, it, vi } from 'vitest'

const { http } = vi.hoisted(() => ({
    http: {
        post: vi.fn(),
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn()
    }
}))

vi.mock('@/axios/index.js', () => ({
    default: http
}))

import {
    createMailShare,
    deleteMailShare,
    getMailShare,
    isShareForbidden,
    listMailShares,
    resetMailShareAuthKey,
    revokeMailShare,
    updateMailShare,
    updateMailShareBindings
} from './mail-share.js'

describe('owner mail-share request (logged-in axios)', () => {
    beforeEach(() => {
        http.post.mockReset()
        http.get.mockReset()
        http.put.mockReset()
        http.delete.mockReset()
        http.post.mockResolvedValue({ shareId: 1, lid: 'lid', sec: 'sec', shareUrl: 'https://x/s/lid#sec' })
        http.get.mockResolvedValue({ list: [], total: 0 })
        http.put.mockResolvedValue({ shareId: 1 })
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

    // The four-key toEqual above is the contract ShareDialog still ships; this case is the
    // other half of it, proving the wizard's extra keys ride the same function rather than a
    // second createMailShareV2 with its own header logic.
    it('forwards the wizard create fields verbatim and swaps accountId out for accountIds', async () => {
        await createMailShare({
            accountIds: [11, 12],
            durationSeconds: 21600,
            name: 'pool',
            remark: '',
            maxSessions: 5,
            messageLimit: 20,
            onlyMessagesAfterCreated: true,
            otpExtractionEnabled: true,
            autoRefresh: false,
            refreshIntervalMs: 3000,
            showFullAddress: true,
            authKeyEnabled: true
        }, 'owner-create-key-2')

        expect(http.post).toHaveBeenCalledTimes(1)
        const [url, body, config] = http.post.mock.calls[0]
        expect(url).toBe('/mailShare/create')
        expect(body).toEqual({
            accountIds: [11, 12],
            durationSeconds: 21600,
            name: 'pool',
            remark: '',
            maxSessions: 5,
            messageLimit: 20,
            onlyMessagesAfterCreated: true,
            otpExtractionEnabled: true,
            autoRefresh: false,
            refreshIntervalMs: 3000,
            showFullAddress: true,
            authKeyEnabled: true
        })
        // toAccountIdSet reads accountIds and ignores accountId, so shipping both would leave
        // a dead field in the body and fork the fingerprint away from ShareDialog's shape.
        expect(body).not.toHaveProperty('accountId')
        // No clamping and no false->0 here: normalizeCreateBody owns defaults and ranges.
        expect(config.headers['Idempotency-Key']).toBe('owner-create-key-2')

        // The same function must stay silent about fields the caller never mentioned, or the
        // single-mailbox preset would stop matching legacyCompatibleBody.
        await createMailShare({ accountIds: [11], durationSeconds: 3600 }, 'owner-create-key-3')
        expect(http.post.mock.calls[1][1]).toEqual({
            accountIds: [11],
            durationSeconds: 3600,
            name: '',
            remark: ''
        })
    })

    it('lists and revokes through the logged-in client, not the anonymous share client', async () => {
        await listMailShares()
        await revokeMailShare(9)
        expect(http.get).toHaveBeenCalledWith('/mailShare/list')
        expect(http.delete).toHaveBeenCalledWith('/mailShare/revoke', { params: { shareId: 9 } })
    })

    it('keeps the no-arg list call a single argument so the deprecated full-scan branch still fires', async () => {
        await listMailShares()
        await listMailShares({})
        await listMailShares({ status: '', page: null })

        expect(http.get).toHaveBeenCalledTimes(3)
        http.get.mock.calls.forEach((call) => {
            expect(call).toEqual(['/mailShare/list'])
        })
    })

    it('sends page, size and status only for the fields the caller actually set (R1-F2)', async () => {
        await listMailShares({ page: 2, size: 20, status: 'REVOKED' })
        expect(http.get).toHaveBeenLastCalledWith('/mailShare/list', {
            params: { page: 2, size: 20, status: 'REVOKED' }
        })

        await listMailShares({ page: 1, size: 20 })
        expect(http.get).toHaveBeenLastCalledWith('/mailShare/list', {
            params: { page: 1, size: 20 }
        })
    })

    it('covers the remaining five owner endpoints with the transport each one expects', async () => {
        await getMailShare(9)
        expect(http.get).toHaveBeenLastCalledWith('/mailShare/get', { params: { shareId: 9 } })

        await updateMailShare({ shareId: 9, name: 'desk' })
        expect(http.put).toHaveBeenLastCalledWith('/mailShare/update', { shareId: 9, name: 'desk' })

        await updateMailShareBindings({ shareId: 9, add: [11], remove: [12] })
        expect(http.put).toHaveBeenLastCalledWith('/mailShare/bindings', { shareId: 9, add: [11], remove: [12] })

        await deleteMailShare(9)
        expect(http.delete).toHaveBeenLastCalledWith('/mailShare/delete', { params: { shareId: 9 } })

        await resetMailShareAuthKey({ shareId: 9, action: 'reset' })
        expect(http.post).toHaveBeenLastCalledWith('/mailShare/resetAuthKey', { shareId: 9, action: 'reset' })
    })

    it('recognises the body-403 envelope so the admin page can separate it from a 401 bounce', () => {
        expect(isShareForbidden({ code: 403, message: 'SHARE_FORBIDDEN' })).toBe(true)
        expect(isShareForbidden(new Error('SHARE_FORBIDDEN'))).toBe(true)
        expect(isShareForbidden({ code: 401, message: 'NOT_LOGIN' })).toBe(false)
        expect(isShareForbidden({ code: 500, message: 'SHARE_DISABLED' })).toBe(false)
        expect(isShareForbidden(null)).toBe(false)
    })
})
