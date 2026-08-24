import {ref} from "vue"

// normalizeCreateBody's whitelist, verbatim. AC-CAP-12 turns it into a ceiling for the
// wizard: a preset id would be silently dropped by the backend, so nothing would break at
// runtime and nothing would tell us the request had started describing the UI instead of the
// share. The spec diffs the request keys against this list for exactly that reason.
export const CREATE_BODY_KEYS = Object.freeze([
    'accountIds',
    'durationSeconds',
    'name',
    'remark',
    'maxSessions',
    'messageLimit',
    'onlyMessagesAfterCreated',
    'otpExtractionEnabled',
    'autoRefresh',
    'refreshIntervalMs',
    'showFullAddress',
    'authKeyEnabled'
])

// SHARE_CAPABILITY_V2 lives in the Worker's env and reaches no response body, so the browser
// cannot know it before submitting. Two states, not three: 'unknown' keeps the gated controls
// usable and 'inactive' is only ever reached by a real rejection. Pre-greying on 'unknown'
// would hide multi-mailbox from every deployment that has the capability switched on, which
// is worse than one rejected submit.
//
// Module scope rather than storage: the env var flips with a deploy, and a persisted "greyed
// today" would read as "greyed forever" long after the platform enabled it.
export const capabilityV2 = ref('unknown')

export function markCapabilityInactive() {
    capabilityV2.value = 'inactive'
}

export function recheckCapabilityV2() {
    capabilityV2.value = 'unknown'
}

// The four writes assertCreateBody puts behind the capability. messageLimit belongs here even
// though the task brief lists only three: without it the owner sets a message cap on a
// V2=false platform, gets SHARE_INVALID_CONFIG, and reads a screen that says the other three
// are the restricted ones.
export function hasFenceIntent(body) {
    if (!body) {
        return false
    }
    return (Array.isArray(body.accountIds) && body.accountIds.length > 1)
        || Boolean(body.authKeyEnabled)
        || body.maxSessions != null
        || body.messageLimit != null
}

// Prefill only. Every value here is a form default the owner can still change, and the
// single-mailbox row is deliberately identical to the DDL defaults so its normalized body
// still matches legacyCompatibleBody and keeps the rolling-deploy fingerprint.
export const SHARE_PRESETS = Object.freeze([
    {
        id: 'singleOtp',
        labelKey: 'sharePresetSingleOtp',
        hintKey: 'sharePresetSingleOtpHint',
        multi: false,
        advancedOpen: false,
        form: {
            durationSeconds: 3600,
            onlyMessagesAfterCreated: true,
            otpExtractionEnabled: true,
            autoRefresh: true,
            refreshIntervalMs: 3000,
            showFullAddress: false,
            maxSessions: null,
            messageLimit: null,
            authKeyEnabled: false
        }
    },
    {
        id: 'tempMailbox',
        labelKey: 'sharePresetTempMailbox',
        hintKey: 'sharePresetTempMailboxHint',
        multi: false,
        advancedOpen: false,
        form: {
            durationSeconds: 86400,
            onlyMessagesAfterCreated: true,
            otpExtractionEnabled: true,
            autoRefresh: true,
            refreshIntervalMs: 3000,
            // The visitor has to read this address to sign up somewhere else, so masking it
            // would remove the point of the preset. Masking is a display preference, not a
            // boundary, so this default costs nothing beyond legibility.
            showFullAddress: true,
            maxSessions: null,
            messageLimit: null,
            authKeyEnabled: false
        }
    },
    {
        id: 'multiOtp',
        labelKey: 'sharePresetMultiOtp',
        hintKey: 'sharePresetMultiOtpHint',
        // The only preset that lands on the capability fence by default.
        multi: true,
        advancedOpen: false,
        form: {
            durationSeconds: 21600,
            onlyMessagesAfterCreated: true,
            otpExtractionEnabled: true,
            autoRefresh: true,
            refreshIntervalMs: 3000,
            showFullAddress: false,
            maxSessions: null,
            messageLimit: null,
            authKeyEnabled: false
        }
    },
    {
        id: 'custom',
        labelKey: 'sharePresetCustom',
        hintKey: 'sharePresetCustomHint',
        multi: true,
        advancedOpen: true,
        form: {
            durationSeconds: 3600,
            onlyMessagesAfterCreated: true,
            otpExtractionEnabled: true,
            autoRefresh: true,
            refreshIntervalMs: 3000,
            showFullAddress: false,
            maxSessions: null,
            messageLimit: null,
            authKeyEnabled: false
        }
    }
])

export function findPreset(presetId) {
    return SHARE_PRESETS.find((preset) => preset.id === presetId) || SHARE_PRESETS[0]
}

export function presetFormValues(presetId) {
    return {...findPreset(presetId).form}
}
