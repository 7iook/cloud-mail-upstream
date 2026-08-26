export const SHARE_SESSION_KEY_PREFIX = 'share:session:'
export const SHARE_ESTABLISH_KEY_PREFIX = 'share:est-key:'
// P4:某个 lid 已被判 gone(HTTP 404)的记账。存在 = 已经为它 reload 过一次。
export const SHARE_GONE_KEY_PREFIX = 'share:gone:'

const pendingSecrets = new Map()

export function shareSessionKey(lid) {
    return `${SHARE_SESSION_KEY_PREFIX}${String(lid || '')}`
}

export function shareEstablishKey(lid) {
    return `${SHARE_ESTABLISH_KEY_PREFIX}${String(lid || '')}`
}

function hasLid(lid) {
    return lid !== undefined && lid !== null && String(lid) !== ''
}

export function readShareSession(lid) {
    if (!hasLid(lid)) {
        return ''
    }
    return sessionStorage.getItem(shareSessionKey(lid)) || ''
}

export function writeShareSession(lid, token) {
    if (!hasLid(lid) || typeof token !== 'string' || token === '') {
        return
    }
    sessionStorage.setItem(shareSessionKey(lid), token)
}

export function clearShareSession(lid) {
    if (!hasLid(lid)) {
        return
    }
    sessionStorage.removeItem(shareSessionKey(lid))
}

// Written before the request goes out, so a lost response replays under the same
// Idempotency-Key instead of burning a second session slot (AC-SESS-10). getRandomValues,
// not randomUUID: the latter is undefined outside a secure context, which a share link
// opened over plain http on a LAN address really is.
export function ensureEstablishKey(lid) {
    if (!hasLid(lid)) {
        return ''
    }
    const storageKey = shareEstablishKey(lid)
    const existing = sessionStorage.getItem(storageKey)
    if (existing) {
        return existing
    }
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    const key = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    sessionStorage.setItem(storageKey, key)
    return key
}

export function clearEstablishKey(lid) {
    if (!hasLid(lid)) {
        return
    }
    sessionStorage.removeItem(shareEstablishKey(lid))
}

export function clearOtherShareSessions(keepLid) {
    const keep = hasLid(keepLid) ? shareSessionKey(keepLid) : ''
    const remove = []
    for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i)
        if (key && key.startsWith(SHARE_SESSION_KEY_PREFIX) && key !== keep) {
            remove.push(key)
        }
    }
    for (const key of remove) {
        sessionStorage.removeItem(key)
    }
}

export function shareGoneKey(lid) {
    return `${SHARE_GONE_KEY_PREFIX}${String(lid || '')}`
}

/**
 * P4 已打开页的销毁恢复记账:第一眼 gone → 'reload'(生产 reload 落到 worker 的
 * 文档拦截 = 浏览器原生 404);之后每一眼 → 'blank'(reload 又回到了 SPA,说明当前
 * 环境不经 worker —— vite:3001 直出 —— 只能清空文档,绝不循环)。
 * sessionStorage 不可用时直接回 'blank':没有记账就没有安全的 reload。
 */
export function markShareGone(lid) {
    try {
        const key = shareGoneKey(lid)
        if (sessionStorage.getItem(key)) {
            return 'blank'
        }
        sessionStorage.setItem(key, '1')
        return 'reload'
    } catch {
        return 'blank'
    }
}

export function clearShareGone(lid) {
    try {
        sessionStorage.removeItem(shareGoneKey(lid))
    } catch {
        // sessionStorage 不可用时本来就不会留下 gone 标。
    }
}

// 独立可 mock 的导航动作:jsdom 的 location.reload 不可 spy,页面单测经由这两个
// 接缝断言「reload 一次 / 清空文档」而不真的导航。
export function reloadShareDocument() {
    window.location.reload()
}

export function blankShareDocument() {
    // 空文档 = 没有任何业务 HTML。销毁态唯一合法形态是浏览器原生 404,清空是
    // 不经 worker 的开发环境里最接近它的形状。
    document.documentElement.innerHTML = ''
}

export function clearShareFragment() {
    if (typeof window === 'undefined' || !window.location) {
        return
    }
    const { pathname, search, hash } = window.location
    if (!hash) {
        return
    }
    window.history.replaceState(window.history.state, '', `${pathname}${search}`)
}

export function readShareSecretFromFragment() {
    if (typeof window === 'undefined' || !window.location) {
        return ''
    }
    const raw = window.location.hash
    if (!raw || raw === '#') {
        return ''
    }
    const encoded = raw.charAt(0) === '#' ? raw.slice(1) : raw
    try {
        return decodeURIComponent(encoded)
    } catch (err) {
        console.error(err)
        return encoded
    }
}

export function captureShareSecret(lid) {
    const sec = readShareSecretFromFragment()
    if (hasLid(lid) && sec) {
        pendingSecrets.set(String(lid), sec)
    }
    clearShareFragment()
    return sec
}

export function takeShareSecret(lid) {
    if (!hasLid(lid)) {
        return ''
    }
    const key = String(lid)
    const sec = pendingSecrets.get(key) || ''
    pendingSecrets.delete(key)
    return sec
}

export function consumeShareSecret(lid) {
    const pending = takeShareSecret(lid)
    if (pending) {
        clearShareFragment()
        return pending
    }
    const fromHash = readShareSecretFromFragment()
    clearShareFragment()
    return fromHash
}
