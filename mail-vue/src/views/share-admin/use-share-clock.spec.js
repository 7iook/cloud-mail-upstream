import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { KeepAlive, defineComponent, h, nextTick, ref } from 'vue'
import { useShareClock } from './use-share-clock.js'

const Probe = defineComponent({
    setup() {
        const { nowMs, liveStatus } = useShareClock()
        return { nowMs, liveStatus }
    },
    template: '<span data-test="now">{{ nowMs }}</span>'
})

describe('useShareClock (P1 owner live expiry clock)', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-08-26T06:00:00Z'))
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('ticks about once a second so a parked page crosses expiresAt on its own', async () => {
        const wrapper = mount(Probe)
        const first = Number(wrapper.get('[data-test="now"]').text())

        vi.advanceTimersByTime(2000)
        await nextTick()

        expect(Number(wrapper.get('[data-test="now"]').text())).toBeGreaterThanOrEqual(first + 2000)
        wrapper.unmount()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('exposes liveStatus bound to the reactive clock, not to a captured Date.now', async () => {
        const wrapper = mount(Probe)
        const row = {
            status: 'ACTIVE',
            effectiveStatus: 'ACTIVE',
            expiresAt: '2026-08-26 06:00:01'
        }
        expect(wrapper.vm.liveStatus(row)).toBe('ACTIVE')

        vi.advanceTimersByTime(2000)
        await nextTick()

        expect(wrapper.vm.liveStatus(row)).toBe('EXPIRED')
        wrapper.unmount()
    })

    // The email page lives in the layout keep-alive: onUnmounted never fires when the owner
    // navigates away, so without the deactivated hook every visit would leak one interval.
    it('stops the interval while deactivated and resumes on re-activation', async () => {
        const show = ref(true)
        const Host = defineComponent({
            setup() {
                return () => h(KeepAlive, null, [show.value ? h(Probe) : null])
            }
        })
        const wrapper = mount(Host)
        expect(vi.getTimerCount()).toBe(1)

        show.value = false
        await nextTick()
        expect(vi.getTimerCount()).toBe(0)

        show.value = true
        await nextTick()
        expect(vi.getTimerCount()).toBe(1)

        wrapper.unmount()
        expect(vi.getTimerCount()).toBe(0)
    })
})
