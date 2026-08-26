import axios from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    ShareGoneError,
    ShareRateLimitedError,
    createShareSession,
    getShareAttachment,
    getShareMail,
    getShareMailboxesStatus,
    isShareAuthRequired,
    isShareGone,
    isShareRateLimited,
    isShareUnavailable,
    listShareMails,
    shareHttp
} from './share.js'

const USER_TOKEN = 'logged-in-user-jwt'
const SHARE_TOKEN = 'share-session-token'

function readHeaderValue(config, name) {
    const headers = config.headers
    if (!headers) {
        return undefined
    }
    if (typeof headers.get === 'function') {
        return headers.get(name)
    }
    return headers[name] ?? headers[name.toLowerCase()]
}

function readBody(config) {
    return typeof config.data === 'string' ? JSON.parse(config.data) : config.data
}

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

    it('sends bindingId only when the caller asks for one, and 0 is a real binding (T-25)', async () => {
        await listShareMails({ sessionToken: SHARE_TOKEN, bindingId: 7, limit: 50 })
        await listShareMails({ sessionToken: SHARE_TOKEN, bindingId: 0, limit: 50 })
        await listShareMails({ sessionToken: SHARE_TOKEN, bindingId: null, limit: 50 })
        await listShareMails({ sessionToken: SHARE_TOKEN, bindingId: '', limit: 50 })
        await listShareMails({ sessionToken: SHARE_TOKEN, limit: 50 })

        expect(captured.map((config) => config.params)).toEqual([
            { limit: 50, bindingId: 7 },
            { limit: 50, bindingId: 0 },
            { limit: 50 },
            { limit: 50 },
            { limit: 50 }
        ])
        expect(captured.every((config) => config.url === '/share/mails')).toBe(true)
    })

    it('reads the watermark protocol through the same share client and token (T-25)', async () => {
        const controller = new AbortController()

        const data = await getShareMailboxesStatus({
            sessionToken: SHARE_TOKEN,
            signal: controller.signal
        })

        expect(captured).toHaveLength(1)
        expect(captured[0].url).toBe('/share/mailboxes/status')
        expect(captured[0].method).toBe('get')
        expect(captured[0].signal).toBe(controller.signal)
        expect(readAuth(captured[0])).toBe(`Bearer ${SHARE_TOKEN}`)
        expect(JSON.stringify(captured[0].headers || {})).not.toContain(USER_TOKEN)
        expect(data).toEqual({ list: [], nextCursor: null })
    })

    it('surfaces a 429 from the status route as the same recoverable rate limit (T-25, AC-OTP-08)', async () => {
        shareHttp.defaults.adapter = async (config) => {
            captured.push(config)
            httpError(config, 429, { 'retry-after': '5' }, { message: 'rate limited' })
        }

        let caught
        try {
            await getShareMailboxesStatus({ sessionToken: SHARE_TOKEN })
        } catch (err) {
            caught = err
        }

        expect(caught).toBeInstanceOf(ShareRateLimitedError)
        expect(caught.retryAfter).toBe(5)
        expect(isShareRateLimited(caught)).toBe(true)
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

    // T-26 · AuthKey 走 body,Idempotency-Key 走 header。反过来就把一次性凭据写进了
    // 网关与代理默认会记的那一半请求(AC-SEC-09)。
    it('sends the AuthKey in the body and the idempotency key in the header', async () => {
        const authKey = 'kEy-Base64Url-22charsAA'

        await createShareSession('lid-1', 'sec-1', { authKey, idempotencyKey: 'idem-1' })

        expect(captured).toHaveLength(1)
        expect(captured[0].url).toBe('/share/session')
        expect(readBody(captured[0])).toEqual({ lid: 'lid-1', sec: 'sec-1', authKey })
        expect(readHeaderValue(captured[0], 'Idempotency-Key')).toBe('idem-1')
    })

    it('keeps the old request shape when no AuthKey and no idempotency key are supplied', async () => {
        await createShareSession('lid-1', 'sec-1')
        await createShareSession('lid-1', 'sec-1', { authKey: '   ', idempotencyKey: '' })

        for (const config of captured) {
            expect(readBody(config)).toEqual({ lid: 'lid-1', sec: 'sec-1' })
            expect(readHeaderValue(config, 'Idempotency-Key')).toBeFalsy()
        }
    })

    it('never puts the AuthKey in a header or the URL (AC-SEC-09)', async () => {
        const authKey = 'secret-access-key-9f3a'

        await createShareSession('lid-1', 'sec-1', { authKey, idempotencyKey: 'idem-1' })

        expect(JSON.stringify(captured[0].headers || {})).not.toContain(authKey)
        expect(String(captured[0].url)).not.toContain(authKey)
        expect(JSON.stringify(captured[0].params || {})).not.toContain(authKey)
        expect(readBody(captured[0]).authKey).toBe(authKey)
    })

    // T-22b3 · 续期把旧 token 放进 Authorization 头,复用其它分享接口既有的那条通道。
    // 放进 body 就等于把一次性凭据写进网关默认会记的那一半请求(AC-SEC-09)。
    it('renews with the previous session token on the Authorization header, never in the body', async () => {
        const previousSessionToken = 'sess-about-to-expire'

        await createShareSession('lid-1', 'sec-1', { previousSessionToken, idempotencyKey: 'idem-1' })

        expect(captured).toHaveLength(1)
        expect(captured[0].url).toBe('/share/session')
        expect(readAuth(captured[0])).toBe(`Bearer ${previousSessionToken}`)
        expect(readBody(captured[0])).toEqual({ lid: 'lid-1', sec: 'sec-1' })
        expect(JSON.stringify(readBody(captured[0]))).not.toContain(previousSessionToken)
        expect(String(captured[0].url)).not.toContain(previousSessionToken)
        expect(JSON.stringify(captured[0].params || {})).not.toContain(previousSessionToken)
        expect(readHeaderValue(captured[0], 'Idempotency-Key')).toBe('idem-1')
    })

    it('leaves the request shape untouched on a first open and on a blank previous token', async () => {
        await createShareSession('lid-1', 'sec-1')
        await createShareSession('lid-1', 'sec-1', { previousSessionToken: '' })
        await createShareSession('lid-1', 'sec-1', { previousSessionToken: null })
        await createShareSession('lid-1', 'sec-1', { previousSessionToken: '   ' })

        expect(captured).toHaveLength(4)
        for (const config of captured) {
            // 空值不得退化成 'Bearer ' 这种畸形头:后端会把尾随空格后的空串当成一个 token 去验。
            expect(readAuth(config)).toBeFalsy()
            expect(String(readAuth(config) ?? '')).not.toMatch(/^Bearer/i)
            expect(readBody(config)).toEqual({ lid: 'lid-1', sec: 'sec-1' })
        }
    })

    it('tells SHARE_AUTH_REQUIRED apart from a dead link and a rate limit', async () => {
        expect(isShareAuthRequired({ code: 501, message: 'SHARE_AUTH_REQUIRED' })).toBe(true)
        expect(isShareAuthRequired({ code: 'SHARE_AUTH_REQUIRED' })).toBe(true)
        expect(isShareAuthRequired({ code: 501, message: 'SHARE_UNAVAILABLE' })).toBe(false)
        expect(isShareAuthRequired(new ShareRateLimitedError(5, '5'))).toBe(false)
        expect(isShareAuthRequired(null)).toBe(false)
        expect(isShareAuthRequired(undefined)).toBe(false)
        // 反向:AUTH_REQUIRED 不得被读成死链,否则访客还没输 Key 页面就宣告链接失效。
        expect(isShareUnavailable({ code: 501, message: 'SHARE_AUTH_REQUIRED' })).toBe(false)
        expect(isShareRateLimited({ code: 501, message: 'SHARE_AUTH_REQUIRED' })).toBe(false)
    })

    // P4:销毁/不存在的分享在 HTTP 层是裸 404 空 body。请求层只负责翻译成
    // ShareGoneError;reload / 清空文档是页面的职责,请求层自己绝不导航。
    it('maps a bare HTTP 404 to ShareGoneError without navigating (P4)', async () => {
        shareHttp.defaults.adapter = async (config) => {
            captured.push(config)
            httpError(config, 404, { 'cache-control': 'no-store', 'x-cloudmail-share-gone': '1' }, '')
        }

        let caught
        try {
            await listShareMails({ sessionToken: SHARE_TOKEN })
        } catch (err) {
            caught = err
        }

        expect(caught).toBeInstanceOf(ShareGoneError)
        expect(caught.status).toBe(404)
        expect(isShareGone(caught)).toBe(true)
        expect(isShareUnavailable(caught)).toBe(false)
        expect(isShareRateLimited(caught)).toBe(false)
        expect(isShareAuthRequired(caught)).toBe(false)
        expect(reload).not.toHaveBeenCalled()
        expect(assign).not.toHaveBeenCalled()
        expect(replace).not.toHaveBeenCalled()
    })

    it('maps a 404 on POST /share/session to the same gone shape (P4)', async () => {
        shareHttp.defaults.adapter = async (config) => {
            captured.push(config)
            httpError(config, 404, { 'x-cloudmail-share-gone': '1' }, '')
        }

        await expect(createShareSession('lid-1', 'sec-1')).rejects.toBeInstanceOf(ShareGoneError)
    })

    it('leaves an unmarked HTTP 404 as a transport error (P4)', async () => {
        shareHttp.defaults.adapter = async (config) => {
            captured.push(config)
            httpError(config, 404, { 'cache-control': 'no-store' }, '')
        }

        await expect(listShareMails({ sessionToken: SHARE_TOKEN })).rejects.not.toBeInstanceOf(ShareGoneError)
        expect(isShareGone(
            await listShareMails({ sessionToken: SHARE_TOKEN }).catch((err) => err)
        )).toBe(false)
    })

    it('tells a gone link apart from every other failure family', () => {
        expect(isShareGone(new ShareGoneError())).toBe(true)
        expect(isShareGone({ name: 'ShareGoneError' })).toBe(true)
        expect(isShareGone({ code: 501, message: 'SHARE_UNAVAILABLE' })).toBe(false)
        expect(isShareGone({ code: 501, message: 'SHARE_AUTH_REQUIRED' })).toBe(false)
        expect(isShareGone(new ShareRateLimitedError(5, '5'))).toBe(false)
        expect(isShareGone(null)).toBe(false)
        expect(isShareGone(undefined)).toBe(false)
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
