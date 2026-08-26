import { describe, expect, it } from 'vitest'
import { expiresAtUtcMs, liveEffectiveStatus } from './status.js'

describe('liveEffectiveStatus (owner stale-expiry overlay)', () => {
    const past = '2026-08-26 05:00:00'
    const future = '2026-08-26 07:00:00'
    const now = Date.parse('2026-08-26T06:00:00Z')

    it('parses the worker UTC bare string as UTC, not local time', () => {
        expect(expiresAtUtcMs('2026-08-26 06:00:00')).toBe(Date.parse('2026-08-26T06:00:00Z'))
    })

    it('keeps REVOKED even when expiresAt is in the future', () => {
        expect(liveEffectiveStatus({
            status: 'REVOKED',
            effectiveStatus: 'ACTIVE',
            expiresAt: future
        }, now)).toBe('REVOKED')
        expect(liveEffectiveStatus({
            effectiveStatus: 'REVOKED',
            expiresAt: future
        }, now)).toBe('REVOKED')
    })

    it('overlays EXPIRED when the API still says ACTIVE but expiresAt has passed', () => {
        expect(liveEffectiveStatus({
            status: 'ACTIVE',
            effectiveStatus: 'ACTIVE',
            expiresAt: past
        }, now)).toBe('EXPIRED')
    })

    it('preserves ACCESS_LIMIT_REACHED until the row actually expires', () => {
        expect(liveEffectiveStatus({
            effectiveStatus: 'ACCESS_LIMIT_REACHED',
            expiresAt: future
        }, now)).toBe('ACCESS_LIMIT_REACHED')
        expect(liveEffectiveStatus({
            effectiveStatus: 'ACCESS_LIMIT_REACHED',
            expiresAt: past
        }, now)).toBe('EXPIRED')
    })

    it('trusts the API when expiresAt is missing or unparseable', () => {
        expect(liveEffectiveStatus({ effectiveStatus: 'ACTIVE' }, now)).toBe('ACTIVE')
        expect(liveEffectiveStatus({ effectiveStatus: 'ACTIVE', expiresAt: 'not-a-time' }, now)).toBe('ACTIVE')
    })
})
