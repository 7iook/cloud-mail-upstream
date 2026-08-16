import axios from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    ShareRateLimitedError,
    createShareSession,
    getShareAttachment,
    getShareMail,
    isShareRateLimited,
    isShareUnavailable,
    listShareMails,
    shareHttp
} from './share.js'

const USER_TOKEN = 'logged-in-user-jwt'
const SHARE_TOKEN = 'share-session-token'

function readAuth(config) {
    const headers = config.headers
    if (!headers) {
        return undefined
    }
    if (typeof headers.get === 'function') {
        return headers.get('Authorization') ?? headers.get('authorization')
    }
    return headers.Authorization ?? headers.authorization
}

function ok(config, data, headers = {}) {
    return {
        data,
        status: 200,
        statusText: 'OK',
        headers,
        config,
        request: {}
    }
}

function httpError(config, status, headers = {}, data = {}) {
    throw new axios.AxiosError(
        `Request failed with status code ${status}`,
        axios.AxiosError.ERR_BAD_RESPONSE,
        config,
        {},
        { status, statusText: 'Error', headers, data, config }
    )
}

describe('share request client', () => {
    let captured
    let reload
    let assign
    let replace

    beforeEach(() => {
        captured = []
        reload = vi.fn()
        assign = vi.fn()
        replace = vi.fn()
        vi.stubGlobal('location', {
            href: 'http://localhost:3001/s/lid-1',
            reload,
            assign,
            replace
        })
        localStorage.setItem('token', USER_TOKEN)
        shareHttp.defaults.adapter = async (config) => {
            captured.push(config)
            return ok(config, { code: 200, message: 'success', data: { list: [], nextCursor: null } })
        }
    })

    afterEach(() => {
        localStorage.clear()
        vi.unstubAllGlobals()
        delete shareHttp.defaults.adapter
    })

    it('does not send Authorization when no share session token is supplied', async () => {
        await listShareMails()
        await createShareSession('lid-1', 'sec-1')

        expect(captured).toHaveLength(2)
        expect(readAuth(captured[0])).toBeFalsy()
        expect(readAuth(captured[1])).toBeFalsy()
        expect(JSON.stringify(captured[0].headers || {})).not.toContain(USER_TOKEN)
        expect(JSON.stringify(captured[1].headers || {})).not.toContain(USER_TOKEN)
    })

    it('sends Authorization Bearer only for the caller-supplied share session token', async () => {
        await listShareMails({ sessionToken: SHARE_TOKEN, cursor: '10', limit: 20 })

        expect(captured).toHaveLength(1)
        expect(captured[0].url).toBe('/share/mails')
        expect(captured[0].params).toEqual({ cursor: '10', limit: 20 })
        expect(readAuth(captured[0])).toBe(`Bearer ${SHARE_TOKEN}`)
        expect(readAuth(captured[0])).not.toContain(USER_TOKEN)
    })

    it('hands back HTTP 200 SHARE_UNAVAILABLE without redirect or reload', async () => {
        const body = { code: 501, message: 'SHARE_UNAVAILABLE' }
        shareHttp.defaults.adapter = async (config) => {
            captured.push(config)
            return ok(config, body)
        }

        let caught
        try {
            await getShareMail({ sessionToken: SHARE_TOKEN, mailId: '9' })
        } catch (err) {
            caught = err
        }

        expect(caught).toEqual(body)
        expect(isShareUnavailable(caught)).toBe(true)
        expect(isShareRateLimited(caught)).toBe(false)
        expect(reload).not.toHaveBeenCalled()
        expect(assign).not.toHaveBeenCalled()
        expect(replace).not.toHaveBeenCalled()
        expect(localStorage.getItem('token')).toBe(USER_TOKEN)
    })

    it('hands back a business 401 without clearing the user token or navigating', async () => {
        const body = { code: 401, message: 'unauthorized' }
        shareHttp.defaults.adapter = async (config) => {
            captured.push(config)
            return ok(config, body)
        }

        let caught
        try {
            await listShareMails({ sessionToken: SHARE_TOKEN })
        } catch (err) {
            caught = err
        }

        expect(caught).toEqual(body)
        expect(isShareUnavailable(caught)).toBe(false)
        expect(reload).not.toHaveBeenCalled()
        expect(assign).not.toHaveBeenCalled()
        expect(replace).not.toHaveBeenCalled()
        expect(localStorage.getItem('token')).toBe(USER_TOKEN)
    })

    it('surfaces HTTP 429 as a recoverable rate limit with Retry-After, not a dead link', async () => {
        shareHttp.defaults.adapter = async (config) => {
            captured.push(config)
            httpError(config, 429, { 'retry-after': '12' }, { message: 'rate limited' })
        }

        let caught
        try {
            await listShareMails({ sessionToken: SHARE_TOKEN })
        } catch (err) {
            caught = err
        }

        expect(caught).toBeInstanceOf(ShareRateLimitedError)
        expect(caught.status).toBe(429)
        expect(caught.retryAfter).toBe(12)
        expect(caught.retryAfterRaw).toBe('12')
        expect(isShareRateLimited(caught)).toBe(true)
        expect(isShareUnavailable(caught)).toBe(false)
        expect(reload).not.toHaveBeenCalled()
        expect(assign).not.toHaveBeenCalled()
        expect(replace).not.toHaveBeenCalled()
    })

    it('does not reload on HTTP 403', async () => {
        shareHttp.defaults.adapter = async (config) => {
            captured.push(config)
            httpError(config, 403, {}, { message: 'forbidden' })
        }

        await expect(getShareAttachment({
            sessionToken: SHARE_TOKEN,
            mailId: '1',
            attachmentId: '2'
        })).rejects.toMatchObject({ response: { status: 403 } })

        expect(reload).not.toHaveBeenCalled()
        expect(assign).not.toHaveBeenCalled()
        expect(captured[0].url).toBe('/share/attachment')
        expect(captured[0].params).toEqual({ mailId: '1', attachmentId: '2' })
        expect(readAuth(captured[0])).toBe(`Bearer ${SHARE_TOKEN}`)
    })

    it('hands back SHARE_UNAVAILABLE when an attachment response is a JSON blob envelope', async () => {
        const body = { code: 501, message: 'SHARE_UNAVAILABLE' }
        shareHttp.defaults.adapter = async (config) => {
            captured.push(config)
            return ok(
                config,
                new Blob([JSON.stringify(body)], { type: 'application/json' }),
                { 'content-type': 'application/json' }
            )
        }

        let caught
        try {
            await getShareAttachment({
                sessionToken: SHARE_TOKEN,
                mailId: '1',
                attachmentId: '2'
            })
        } catch (err) {
            caught = err
        }

        expect(caught).toEqual(body)
        expect(isShareUnavailable(caught)).toBe(true)
        expect(isShareRateLimited(caught)).toBe(false)
        expect(reload).not.toHaveBeenCalled()
    })
})
