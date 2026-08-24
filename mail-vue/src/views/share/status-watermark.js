export const SHARE_STATUS_KEY_PREFIX = 'share:status:'

/**
 * The visitor page's per-Binding read progress: `share:status:<lid>` holds
 * `{"<bindingId>": <largest mailId this visitor has actually been shown>}`.
 *
 * Two rules make the whole file: keys are strings because JSON object keys are, and
 * `bindingId: 0` is a real Binding (the pre-Binding single-mailbox shape), so emptiness
 * is always `== null` and never falsy. Progress is not a credential — it lives apart
 * from `share:session:<lid>` and is not cleared on exit.
 */
export function shareStatusKey(lid) {
    return `${SHARE_STATUS_KEY_PREFIX}${String(lid || '')}`
}

function hasLid(lid) {
    return lid !== undefined && lid !== null && String(lid) !== ''
}

function toKey(bindingId) {
    const id = Number(bindingId)
    return bindingId != null && bindingId !== '' && Number.isSafeInteger(id) && id >= 0
        ? String(id)
        : null
}

function toMailId(value) {
    const id = Number(value)
    return value != null && value !== '' && Number.isFinite(id) ? id : null
}

export function readWatermarks(lid) {
    if (!hasLid(lid)) {
        return {}
    }
    let parsed = null
    try {
        parsed = JSON.parse(sessionStorage.getItem(shareStatusKey(lid)))
    } catch {
        return {}
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {}
    }
    const map = {}
    for (const [key, value] of Object.entries(parsed)) {
        const bindingKey = toKey(key)
        const mailId = toMailId(value)
        if (bindingKey != null && mailId != null) {
            map[bindingKey] = mailId
        }
    }
    return map
}

export function writeWatermarks(lid, map) {
    if (!hasLid(lid)) {
        return
    }
    sessionStorage.setItem(shareStatusKey(lid), JSON.stringify(map || {}))
}

/**
 * Aligns the stored map with the Bindings the status response actually lists: a Binding
 * seen for the first time gets its current head as a baseline (so the visitor is not
 * badged for mail that arrived before they opened the page), and a Binding that is gone
 * loses its watermark. Returns the seeded keys so a caller can tell a baseline apart
 * from real progress.
 */
export function reconcile(map, statusList) {
    const next = {}
    const seeded = []
    for (const item of Array.isArray(statusList) ? statusList : []) {
        const key = toKey(item && item.bindingId)
        if (key == null) {
            continue
        }
        if (map && Object.prototype.hasOwnProperty.call(map, key)) {
            next[key] = map[key]
            continue
        }
        next[key] = toMailId(item && item.latestEmailId) ?? 0
        seeded.push(key)
    }
    return { map: next, seeded }
}

// An unknown key reads as Infinity rather than 0: a Binding with no baseline yet must
// stay quiet for that frame instead of badging its whole backlog.
export function hasNew(map, bindingId, latestEmailId) {
    const key = toKey(bindingId)
    const latest = toMailId(latestEmailId)
    if (key == null || latest == null) {
        return false
    }
    const stored = map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : Infinity
    return latest > stored
}

export function advance(map, bindingId, mailId) {
    const key = toKey(bindingId)
    const next = toMailId(mailId)
    if (key == null || next == null) {
        return { ...map }
    }
    const prev = map && Object.prototype.hasOwnProperty.call(map, key) ? Number(map[key]) : -Infinity
    return { ...map, [key]: Math.max(prev, next) }
}
