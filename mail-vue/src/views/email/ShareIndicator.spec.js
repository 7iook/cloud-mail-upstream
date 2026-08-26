import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { KeepAlive, defineComponent, h, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { useUserStore } from '@/store/user.js'
import en from '@/i18n/en.js'

const { listMailShares } = vi.hoisted(() => ({
    listMailShares: vi.fn()
}))

vi.mock('@/request/mail-share.js', () => ({
    listMailShares
}))

import ShareIndicator from './ShareIndicator.vue'

function mountIndicator(accountId = 11) {
    const pinia = createPinia()
    setActivePinia(pinia)
    useUserStore().user = { permKeys: ['share:manage'] }
    const i18n = createI18n({
        legacy: false,
        locale: 'en',
        messages: { en }
    })
    return mount(ShareIndicator, {
        props: { accountId },
        global: {
            plugins: [pinia, i18n]
        }
    })
}

describe('ShareIndicator (AC-MGMT-04)', () => {
    beforeEach(() => {
        listMailShares.mockReset()
        listMailShares.mockResolvedValue({
            list: [
                { shareId: 1, accountId: 11, effectiveStatus: 'ACTIVE' },
                { shareId: 2, accountId: 11, effectiveStatus: 'ACTIVE' },
                { shareId: 3, accountId: 11, effectiveStatus: 'EXPIRED' },
                { shareId: 4, accountId: 22, effectiveStatus: 'ACTIVE' }
            ],
            total: 4
        })
    })

    it('shows the ACTIVE share count for the current mailbox only', async () => {
        const wrapper = mountIndicator(11)
        await flushPromises()
        expect(wrapper.get('[data-test="share-active-count"]').text()).toBe('2')
    })

    it('drops a share whose expiresAt has passed even if the API still says ACTIVE', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-08-26T06:00:00Z'))
        listMailShares.mockResolvedValue({
            list: [
                {
                    shareId: 1,
                    accountId: 11,
                    effectiveStatus: 'ACTIVE',
                    expiresAt: '2026-08-26 05:59:59'
                },
                {
                    shareId: 2,
                    accountId: 11,
                    effectiveStatus: 'ACTIVE',
                    expiresAt: '2026-08-26 06:00:01'
                }
            ],
            total: 2
        })
        try {
            const wrapper = mountIndicator(11)
            await flushPromises()
            expect(wrapper.get('[data-test="share-active-count"]').text()).toBe('1')
        } finally {
            vi.useRealTimers()
        }
    })

    it('emits open so the owner can manage shares from the mailbox', async () => {
        const wrapper = mountIndicator(11)
        await flushPromises()
        await wrapper.get('[data-test="share-indicator"]').trigger('click')
        expect(wrapper.emitted('open')).toHaveLength(1)
    })

    // P1: the email page sits in the layout keep-alive, so coming back to the inbox does not
    // remount this component. onActivated is the only hook that runs then, and it must re-pull
    // the list or the badge keeps the pre-navigation snapshot until a re-login.
    it('pulls the list again when the keep-alive inbox is re-activated (P1)', async () => {
        const pinia = createPinia()
        setActivePinia(pinia)
        useUserStore().user = { permKeys: ['share:manage'] }
        const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
        const show = ref(true)
        const ShareIndicatorDefault = ShareIndicator
        const Host = defineComponent({
            setup() {
                return () => h(KeepAlive, null, [show.value ? h(ShareIndicatorDefault, { accountId: 11 }) : null])
            }
        })
        mount(Host, { global: { plugins: [pinia, i18n] } })
        await flushPromises()
        const callsAfterMount = listMailShares.mock.calls.length

        show.value = false
        await nextTick()
        show.value = true
        await nextTick()
        await flushPromises()

        expect(listMailShares.mock.calls.length).toBe(callsAfterMount + 1)
    })

    // P1: a tab parked on the inbox across the expiry instant must flip the badge without any
    // network call — the clock tick alone re-evaluates liveEffectiveStatus.
    it('flips the badge when the clock crosses expiresAt while the owner stays put (P1)', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-08-26T06:00:00Z'))
        listMailShares.mockResolvedValue({
            list: [{
                shareId: 1,
                accountId: 11,
                effectiveStatus: 'ACTIVE',
                expiresAt: '2026-08-26 06:00:02'
            }],
            total: 1
        })
        try {
            const wrapper = mountIndicator(11)
            await flushPromises()
            expect(wrapper.get('[data-test="share-active-count"]').text()).toBe('1')

            vi.advanceTimersByTime(3000)
            await nextTick()

            expect(wrapper.get('[data-test="share-active-count"]').text()).toBe('0')
        } finally {
            vi.useRealTimers()
        }
    })
})
