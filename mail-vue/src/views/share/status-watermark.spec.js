import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    SHARE_STATUS_KEY_PREFIX,
    advance,
    hasNew,
    readWatermarks,
    reconcile,
    shareStatusKey,
    writeWatermarks
} from './status-watermark.js'

// T-25 · 水位 map:sessionStorage `share:status:<lid>` → {"<bindingId>": <已消费的最大 mailId>}。
// 五条推进语义(recon-t25-tabs.md §3.2):首帧建基准不报角标 / 仅消费者推进 /
// 新增建基准 / 删除丢弃 / 单调不回退。`bindingId: 0` 是合法键,一律 `== null` 判空。

const LID = 'lid-water'

describe('share status watermark storage', () => {
    beforeEach(() => {
        sessionStorage.clear()
    })

    afterEach(() => {
        sessionStorage.clear()
    })

    it('keys by lid under the share:status: prefix, apart from share:session:', () => {
        expect(SHARE_STATUS_KEY_PREFIX).toBe('share:status:')
        expect(shareStatusKey(LID)).toBe('share:status:lid-water')
        expect(shareStatusKey(LID)).not.toContain('share:session:')
    })

    it('round-trips a map and serializes bindingId 0 as the string key "0"', () => {
        writeWatermarks(LID, { 0: 12, 8002: 40 })

        expect(JSON.parse(sessionStorage.getItem(shareStatusKey(LID)))).toEqual({ 0: 12, 8002: 40 })
        expect(sessionStorage.getItem(shareStatusKey(LID))).toContain('"0"')
        expect(readWatermarks(LID)).toEqual({ 0: 12, 8002: 40 })
    })

    it('reads {} for a missing lid, dirty JSON, or a non-object payload', () => {
        expect(readWatermarks(LID)).toEqual({})
        expect(readWatermarks('')).toEqual({})

        for (const raw of ['not json', '[1,2]', 'null', '7', '"text"', '{']) {
            sessionStorage.setItem(shareStatusKey(LID), raw)
            expect(readWatermarks(LID)).toEqual({})
        }
    })

    it('drops non-numeric watermark values rather than trusting a hand-edited payload', () => {
        sessionStorage.setItem(shareStatusKey(LID), JSON.stringify({
            0: 4,
            8002: 'abc',
            8003: null,
            8004: Number.NaN,
            8005: 9
        }))

        expect(readWatermarks(LID)).toEqual({ 0: 4, 8005: 9 })
    })

    it('does not write under a blank lid', () => {
        writeWatermarks('', { 1: 2 })
        expect(sessionStorage.length).toBe(0)
    })
})

describe('share status watermark advance semantics', () => {
    it('seeds a baseline on the first frame and reports no badge for it (AC-OTP-09)', () => {
        const { map, seeded } = reconcile({}, [
            { bindingId: 0, latestEmailId: 40 },
            { bindingId: 8002, latestEmailId: null }
        ])

        expect(map).toEqual({ 0: 40, 8002: 0 })
        expect(seeded.sort()).toEqual(['0', '8002'])
        expect(hasNew(map, 0, 40)).toBe(false)
        expect(hasNew(map, 8002, null)).toBe(false)
    })

    it('seeds a binding added later without touching the ones already tracked', () => {
        const first = reconcile({}, [{ bindingId: 8001, latestEmailId: 10 }]).map
        const next = reconcile(first, [
            { bindingId: 8001, latestEmailId: 10 },
            { bindingId: 8002, latestEmailId: 99 }
        ])

        expect(next.map).toEqual({ 8001: 10, 8002: 99 })
        expect(next.seeded).toEqual(['8002'])
        expect(hasNew(next.map, 8002, 99)).toBe(false)
    })

    it('forgets a binding the status response no longer lists (AC-EDGE-04)', () => {
        const { map, seeded } = reconcile({ 8001: 10, 8002: 20 }, [{ bindingId: 8001, latestEmailId: 10 }])

        expect(map).toEqual({ 8001: 10 })
        expect(seeded).toEqual([])
        expect('8002' in map).toBe(false)
    })

    it('does not mutate the map it was handed', () => {
        const before = { 8001: 10, 8002: 20 }
        reconcile(before, [{ bindingId: 8001, latestEmailId: 77 }])
        advance(before, 8001, 99)

        expect(before).toEqual({ 8001: 10, 8002: 20 })
    })

    it('ignores status rows with no usable bindingId instead of writing a null key', () => {
        const { map } = reconcile({}, [
            { bindingId: null, latestEmailId: 5 },
            { latestEmailId: 6 },
            { bindingId: 'abc', latestEmailId: 7 },
            { bindingId: 8001, latestEmailId: 8 }
        ])

        expect(map).toEqual({ 8001: 8 })
    })

    it('badges only a binding whose latest mail is above its stored watermark', () => {
        const map = { 0: 40, 8002: 0 }

        expect(hasNew(map, 0, 41)).toBe(true)
        expect(hasNew(map, 0, 40)).toBe(false)
        expect(hasNew(map, 0, 39)).toBe(false)
        expect(hasNew(map, 8002, 1)).toBe(true)
        expect(hasNew(map, 8002, null)).toBe(false)
    })

    it('never badges a binding with no stored key, so an unreconciled frame stays quiet', () => {
        expect(hasNew({}, 8001, 500)).toBe(false)
        expect(hasNew({ 8001: 10 }, 8002, 500)).toBe(false)
    })

    it('advances only forward, so a deleted or rolled-out mail does not flash a badge', () => {
        const forward = advance({ 8001: 10 }, 8001, 42)
        expect(forward).toEqual({ 8001: 42 })

        expect(advance(forward, 8001, 7)).toEqual({ 8001: 42 })
        expect(advance(forward, 8001, null)).toEqual({ 8001: 42 })
        expect(advance(forward, 8001, undefined)).toEqual({ 8001: 42 })
        expect(advance(forward, 8001, 'abc')).toEqual({ 8001: 42 })
        expect(hasNew(advance(forward, 8001, 42), 8001, 42)).toBe(false)
    })

    it('advances a binding it has never seen and keeps bindingId 0 addressable', () => {
        expect(advance({}, 0, 5)).toEqual({ 0: 5 })
        expect(advance({ 0: 5 }, 0, 9)).toEqual({ 0: 9 })
        expect(advance({ 0: 9 }, null, 100)).toEqual({ 0: 9 })
    })

    it('leaves siblings alone when one binding is consumed', () => {
        const seeded = reconcile({}, [
            { bindingId: 8001, latestEmailId: 10 },
            { bindingId: 8002, latestEmailId: 20 }
        ]).map
        const arrived = reconcile(seeded, [
            { bindingId: 8001, latestEmailId: 11 },
            { bindingId: 8002, latestEmailId: 21 }
        ]).map

        expect(hasNew(arrived, 8001, 11)).toBe(true)
        expect(hasNew(arrived, 8002, 21)).toBe(true)

        const consumed = advance(arrived, 8001, 11)
        expect(hasNew(consumed, 8001, 11)).toBe(false)
        expect(hasNew(consumed, 8002, 21)).toBe(true)
    })
})
