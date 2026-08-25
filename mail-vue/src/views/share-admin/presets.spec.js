import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    DURATION_CUSTOM,
    DURATION_UNITS,
    MAX_DURATION_DAYS,
    MAX_DURATION_SECONDS,
    SHARE_DURATION_PRESETS,
    createErrorKey,
    customDurationSeconds,
    durationError
} from './presets.js'
import en from '@/i18n/en.js'
import zh from '@/i18n/zh.js'

describe('share duration (W-E1)', () => {
    it('keeps the four rungs both create entries used to hardcode separately', () => {
        expect(SHARE_DURATION_PRESETS.map((row) => row.value)).toEqual([3600, 21600, 86400, 604800])
        expect(SHARE_DURATION_PRESETS.map((row) => row.labelKey)).toEqual([
            'shareDuration1h',
            'shareDuration6h',
            'shareDuration1d',
            'shareDuration7d'
        ])
    })

    it('turns an amount plus a unit into seconds so 30 days needs no mental arithmetic', () => {
        expect(customDurationSeconds(30, 'days')).toBe(2592000)
        expect(customDurationSeconds(36, 'hours')).toBe(129600)
        expect(customDurationSeconds(90, 'days')).toBe(MAX_DURATION_SECONDS)
    })

    it('returns 0 seconds for an amount the owner has not filled in yet', () => {
        expect(customDurationSeconds(null, 'days')).toBe(0)
        expect(customDurationSeconds('', 'days')).toBe(0)
        expect(customDurationSeconds(30, 'centuries')).toBe(0)
    })

    it('refuses a duration past the ceiling instead of letting a ten-year share leave the browser', () => {
        expect(durationError(MAX_DURATION_SECONDS)).toBe('')
        expect(durationError(MAX_DURATION_SECONDS + 1)).toBe('shareDurationTooLong')
        expect(durationError(10 * 365 * 86400)).toBe('shareDurationTooLong')
    })

    it('refuses zero, negatives, fractions and non-numbers', () => {
        expect(durationError(0)).toBe('shareDurationRequired')
        expect(durationError(-3600)).toBe('shareDurationRequired')
        expect(durationError(1.5)).toBe('shareDurationRequired')
        expect(durationError(null)).toBe('shareDurationRequired')
        expect(durationError('soon')).toBe('shareDurationRequired')
    })

    it('accepts every preset rung it ships', () => {
        SHARE_DURATION_PRESETS.forEach((row) => {
            expect(durationError(row.value)).toBe('')
        })
    })

    it('states the ceiling once, with seconds and days that agree', () => {
        expect(MAX_DURATION_DAYS).toBe(90)
        expect(MAX_DURATION_SECONDS).toBe(MAX_DURATION_DAYS * 86400)
    })

    it('offers hours and days, and keeps the custom sentinel distinct from every rung', () => {
        expect(DURATION_UNITS.map((unit) => unit.id)).toEqual(['hours', 'days'])
        expect(SHARE_DURATION_PRESETS.some((row) => row.value === DURATION_CUSTOM)).toBe(false)
    })

    // P-03: the 7-day ceiling was a literal in two files, so raising it in one left the other
    // entry quietly capped. A private copy of the rungs is the shape of that bug, not a style
    // preference — assert against the source so the next edit cannot reintroduce it silently.
    it('leaves neither create entry holding a private copy of the rungs', async () => {
        const wizard = await readFile(
            path.join(process.cwd(), 'src/views/share-admin/ShareCreateWizard.vue'),
            'utf8'
        )
        const dialog = await readFile(
            path.join(process.cwd(), 'src/views/email/ShareDialog.vue'),
            'utf8'
        )
        expect(wizard).not.toMatch(/labelKey:\s*'shareDuration1h'/)
        expect(dialog).not.toMatch(/labelKey:\s*'shareDuration1h'/)
        expect(wizard).toMatch(/SHARE_DURATION_PRESETS/)
        expect(dialog).toMatch(/SHARE_DURATION_PRESETS/)
    })
})

describe('create failure reporting', () => {
    it('names the fence and the server ceiling apart, and falls back for anything else', () => {
        expect(createErrorKey({ message: 'SHARE_CAPABILITY_NOT_ENABLED' })).toBe('shareCapabilityNotEnabled')
        expect(createErrorKey({ message: 'SHARE_DURATION_EXCEEDED' })).toBe('shareDurationServerRejected')
        expect(createErrorKey({ message: 'SHARE_INVALID_CONFIG' })).toBe('shareConfigRejected')
        expect(createErrorKey({ message: 'SHARE_ACCOUNT_FORBIDDEN' })).toBe('shareCreateFailed')
        expect(createErrorKey(null)).toBe('shareCreateFailed')
        expect(createErrorKey({})).toBe('shareCreateFailed')
    })

    // The browser ceiling is a mirror of the backend default. Quoting it back at the owner when
    // the deployment enforced a different number would state a figure we cannot vouch for, so the
    // server-side rejection gets its own string that names no number.
    it('does not answer a server-side rejection with the browser mirror string', () => {
        expect(createErrorKey({ message: 'SHARE_DURATION_EXCEEDED' })).not.toBe('shareDurationTooLong')
        expect(zh.shareDurationServerRejected).not.toMatch(/90/)
        expect(en.shareDurationServerRejected).not.toMatch(/90/)
    })

    it('has every key it can return translated in both locales', () => {
        const codes = [
            'SHARE_CAPABILITY_NOT_ENABLED',
            'SHARE_DURATION_EXCEEDED',
            'SHARE_INVALID_CONFIG',
            'SHARE_ACCOUNT_FORBIDDEN'
        ]
        codes.forEach((code) => {
            const key = createErrorKey({ message: code })
            expect(zh[key], `zh is missing ${key}`).toBeTruthy()
            expect(en[key], `en is missing ${key}`).toBeTruthy()
        })
    })

    // Both entries used to drop business failures into console.error, which reads as a dead
    // button. Custom durations made that reachable in normal use, so assert against the source:
    // an entry that stops reporting is the bug, not a refactor.
    it('leaves neither create entry swallowing a business rejection', async () => {
        const wizard = await readFile(
            path.join(process.cwd(), 'src/views/share-admin/ShareCreateWizard.vue'),
            'utf8'
        )
        const dialog = await readFile(
            path.join(process.cwd(), 'src/views/email/ShareDialog.vue'),
            'utf8'
        )
        expect(wizard).toMatch(/createErrorKey\(err\)/)
        expect(dialog).toMatch(/createErrorKey\(err\)/)
    })
})
