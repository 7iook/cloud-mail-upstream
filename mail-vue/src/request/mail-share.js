import http from '@/axios/index.js'

export function newIdempotencyKey() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID()
    }
    const bytes = new Uint8Array(16)
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
        globalThis.crypto.getRandomValues(bytes)
    } else {
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = Math.floor(Math.random() * 256)
        }
    }
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function createMailShare(body, idempotencyKey) {
    const key = idempotencyKey || newIdempotencyKey()
    return http.post('/mailShare/create', {
        accountId: Number(body && body.accountId),
        durationSeconds: Number(body && body.durationSeconds),
        name: body && body.name == null ? '' : String(body.name),
        remark: body && body.remark == null ? '' : String(body.remark)
    }, {
        headers: {
            'Idempotency-Key': key
        }
    })
}

function toListQuery(params) {
    if (!params) {
        return null
    }
    const query = {}
    for (const key of ['page', 'size', 'status']) {
        const value = params[key]
        if (value !== undefined && value !== null && value !== '') {
            query[key] = value
        }
    }
    return Object.keys(query).length > 0 ? query : null
}

// A no-arg call must stay a single argument: the backend reads that as the deprecated
// full-scan branch, and ShareDialog / ShareIndicator still rely on it.
export function listMailShares(params) {
    const query = toListQuery(params)
    return query ? http.get('/mailShare/list', { params: query }) : http.get('/mailShare/list')
}

export function getMailShare(shareId) {
    return http.get('/mailShare/get', {
        params: { shareId }
    })
}

export function updateMailShare(body) {
    return http.put('/mailShare/update', body)
}

export function updateMailShareBindings(body) {
    return http.put('/mailShare/bindings', body)
}

export function deleteMailShare(shareId) {
    return http.delete('/mailShare/delete', {
        params: { shareId }
    })
}

export function resetMailShareAuthKey(body) {
    return http.post('/mailShare/resetAuthKey', body)
}

export function revokeMailShare(shareId) {
    return http.delete('/mailShare/revoke', {
        params: { shareId }
    })
}

// SHARE_FORBIDDEN arrives as HTTP 200 with a body code, so it never reaches the axios
// 401 branch that clears the token and replaces to /login.
export function isShareForbidden(err) {
    if (!err) {
        return false
    }
    return err.code === 403 || err.message === 'SHARE_FORBIDDEN'
}
