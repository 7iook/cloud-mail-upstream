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

export function listMailShares() {
    return http.get('/mailShare/list')
}

export function revokeMailShare(shareId) {
    return http.delete('/mailShare/revoke', {
        params: { shareId }
    })
}
