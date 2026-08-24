import axios from 'axios'

export const shareHttp = axios.create({
    baseURL: import.meta.env.VITE_BASE_URL
})

export class ShareRateLimitedError extends Error {
    constructor(retryAfter, retryAfterRaw) {
        super('RATE_LIMITED')
        this.name = 'ShareRateLimitedError'
        this.status = 429
        this.retryAfter = retryAfter
        this.retryAfterRaw = retryAfterRaw
    }
}

export function parseRetryAfter(value) {
    if (value == null || value === '') {
        return null
    }
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds
    }
    const at = Date.parse(String(value))
    if (Number.isNaN(at)) {
        return null
    }
    return Math.max(0, Math.ceil((at - Date.now()) / 1000))
}

export function isShareRateLimited(err) {
    return Boolean(
        err &&
        (err instanceof ShareRateLimitedError || err.name === 'ShareRateLimitedError' || err.status === 429)
    )
}

export function isShareUnavailable(err) {
    if (!err || isShareRateLimited(err)) {
        return false
    }
    return err.code === 'SHARE_UNAVAILABLE' || err.message === 'SHARE_UNAVAILABLE'
}

export function isShareAuthRequired(err) {
    return Boolean(err) && (err.code === 'SHARE_AUTH_REQUIRED' || err.message === 'SHARE_AUTH_REQUIRED')
}

function readHeader(headers, name) {
    if (!headers) {
        return undefined
    }
    if (typeof headers.get === 'function') {
        return headers.get(name)
    }
    return headers[name] ?? headers[name.toLowerCase()]
}

function setAuthorization(headers, value) {
    if (!headers) {
        return
    }
    if (value) {
        if (typeof headers.set === 'function') {
            headers.set('Authorization', value)
        } else {
            headers.Authorization = value
        }
        return
    }
    if (typeof headers.delete === 'function') {
        headers.delete('Authorization')
        headers.delete('authorization')
    }
    delete headers.Authorization
    delete headers.authorization
}

function shareSessionToken(config) {
    const token = config && config.shareSessionToken
    if (typeof token === 'string' && token.trim()) {
        return token.trim()
    }
    return ''
}

function asEnvelope(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return null
    }
    if (!Object.prototype.hasOwnProperty.call(data, 'code')) {
        return null
    }
    return data
}

async function readResponseData(res) {
    const data = res.data
    const contentType = String(readHeader(res.headers, 'content-type') || '')
    const isJson = contentType.includes('application/json')
    if (typeof Blob !== 'undefined' && data instanceof Blob && isJson) {
        const text = await data.text()
        try {
            return JSON.parse(text)
        } catch (err) {
            const parseError = new Error('SHARE_JSON_PARSE_FAILED')
            parseError.cause = err
            parseError.raw = text
            throw parseError
        }
    }
    return data
}

function listParams({ cursor, limit, bindingId } = {}) {
    const params = {}
    if (cursor !== undefined && cursor !== null && cursor !== '') {
        params.cursor = cursor
    }
    if (limit !== undefined && limit !== null) {
        params.limit = limit
    }
    // 0 is the pre-Binding single-mailbox key, so only null / undefined / '' mean
    // "no binding asked for" and fall back to the merged list.
    if (bindingId !== undefined && bindingId !== null && bindingId !== '') {
        params.bindingId = bindingId
    }
    return params
}

shareHttp.interceptors.request.use((config) => {
    const token = shareSessionToken(config)
    setAuthorization(config.headers, token ? `Bearer ${token}` : '')
    return config
})

shareHttp.interceptors.response.use(async (res) => {
    const data = await readResponseData(res)
    const envelope = asEnvelope(data)
    if (!envelope) {
        return data
    }
    if (envelope.code === 200) {
        return envelope.data
    }
    return Promise.reject(envelope)
}, (error) => {
    const status = (error.response && error.response.status) || error.status
    if (status === 429) {
        const raw = readHeader(error.response && error.response.headers, 'retry-after')
        const retryAfterRaw = raw == null ? null : String(raw)
        return Promise.reject(new ShareRateLimitedError(parseRetryAfter(raw), retryAfterRaw))
    }
    return Promise.reject(error)
})

// The AuthKey rides in the body and the replay tag rides in the header: a one-time
// credential in a header or a query string is the half of the request gateways log by
// default (AC-SEC-09). Both are omitted when blank so an unprotected share keeps the
// exact request shape it had before T-26.
export function createShareSession(lid, sec, { authKey, idempotencyKey } = {}) {
    const body = { lid, sec }
    if (typeof authKey === 'string' && authKey.trim()) {
        body.authKey = authKey
    }
    const config = {}
    if (typeof idempotencyKey === 'string' && idempotencyKey.trim()) {
        config.headers = { 'Idempotency-Key': idempotencyKey }
    }
    return shareHttp.post('/share/session', body, config)
}

export function listShareMails({ sessionToken, cursor, limit, bindingId, signal } = {}) {
    return shareHttp.get('/share/mails', {
        params: listParams({ cursor, limit, bindingId }),
        shareSessionToken: sessionToken,
        signal
    })
}

export function getShareMailboxesStatus({ sessionToken, signal } = {}) {
    return shareHttp.get('/share/mailboxes/status', {
        shareSessionToken: sessionToken,
        signal
    })
}

export function getShareMail({ sessionToken, mailId, signal } = {}) {
    return shareHttp.get('/share/mail', {
        params: { mailId },
        shareSessionToken: sessionToken,
        signal
    })
}

export function getShareAttachment({ sessionToken, mailId, attachmentId, signal } = {}) {
    return shareHttp.get('/share/attachment', {
        params: { mailId, attachmentId },
        shareSessionToken: sessionToken,
        responseType: 'blob',
        signal
    })
}
