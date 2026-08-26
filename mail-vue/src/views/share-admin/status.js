// Single source of truth for the four effective share states. T-21 and T-22 reuse this map
// instead of re-deriving it; a second switch statement is how the fourth state goes missing.
const STATUS_META = {
    ACTIVE: { labelKey: 'shareStatusActive', tone: 'success' },
    EXPIRED: { labelKey: 'shareStatusExpired', tone: 'info' },
    ACCESS_LIMIT_REACHED: { labelKey: 'shareStatusLimitReached', tone: 'warning' },
    REVOKED: { labelKey: 'shareStatusRevoked', tone: 'danger' }
}

export const SHARE_STATUSES = Object.keys(STATUS_META)

export function statusMeta(status) {
    return STATUS_META[status] || { labelKey: '', tone: 'info' }
}

// update / bindings / resetAuthKey all sit behind the backend's loadMutableShare predicate
// (status ACTIVE and not yet expired), so reading is always open and writing only in these
// two states. ACCESS_LIMIT_REACHED belongs here: it is still an ACTIVE row that merely ran
// out of session quota, which is exactly when the owner comes in to raise the quota.
export function isMutableStatus(effectiveStatus) {
    return effectiveStatus === 'ACTIVE' || effectiveStatus === 'ACCESS_LIMIT_REACHED'
}

// Worker writes expires_at as a UTC bare 'YYYY-MM-DD HH:mm:ss'. The browser Date parser
// would treat that as local time and hand a UTC+8 owner eight extra hours of "ACTIVE".
export function expiresAtUtcMs(expiresAt) {
    const raw = String(expiresAt || '').trim()
    if (!raw) {
        return NaN
    }
    return Date.parse(`${raw.replace(' ', 'T')}Z`)
}

// Owner-side display SSOT. Persistence is still ACTIVE/REVOKED; this only overlays a stale
// API snapshot so keep-alive / a tab left open can flip to EXPIRED without a re-login.
export function liveEffectiveStatus(row, nowMs = Date.now()) {
    if (!row) {
        return ''
    }
    if (row.status === 'REVOKED' || row.effectiveStatus === 'REVOKED') {
        return 'REVOKED'
    }
    const expires = expiresAtUtcMs(row.expiresAt)
    if (Number.isFinite(expires) && expires <= nowMs) {
        return 'EXPIRED'
    }
    return row.effectiveStatus || 'ACTIVE'
}

export function shareTypeLabelKey(shareType) {
    return shareType === 'multi' ? 'shareTypeMulti' : 'shareTypeSingle'
}

export function usedSessions(row) {
    if (!row) {
        return 0
    }
    const used = row.usedSessions == null ? row.accessCount : row.usedSessions
    return Number(used) || 0
}

export function quotaText(row, unlimitedLabel) {
    const max = row ? row.maxSessions : null
    return `${usedSessions(row)} / ${max == null ? unlimitedLabel : max}`
}

export function bindingLabels(row) {
    const bindings = row && Array.isArray(row.bindings) ? row.bindings : []
    const labels = bindings
        .map((binding) => {
            const mailbox = binding && typeof binding.mailbox === 'string' ? binding.mailbox.trim() : ''
            if (mailbox) {
                return mailbox
            }
            // A hard-deleted account leaves the binding with an empty mailbox; show the id
            // rather than an empty comma-separated slot.
            return binding && binding.accountId != null ? `#${binding.accountId}` : ''
        })
        .filter(Boolean)
    if (labels.length > 0) {
        return labels
    }
    const mailbox = row && typeof row.mailbox === 'string' ? row.mailbox.trim() : ''
    return mailbox ? [mailbox] : []
}

export function bindingSummary(row, limit = 2) {
    const labels = bindingLabels(row)
    if (labels.length === 0) {
        return '-'
    }
    if (labels.length <= limit) {
        return labels.join(', ')
    }
    return `${labels.slice(0, limit).join(', ')} +${labels.length - limit}`
}
