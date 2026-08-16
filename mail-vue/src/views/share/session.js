export const SHARE_SESSION_KEY_PREFIX = 'share:session:'

const pendingSecrets = new Map()

export function shareSessionKey(lid) {
    return `${SHARE_SESSION_KEY_PREFIX}${String(lid || '')}`
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
