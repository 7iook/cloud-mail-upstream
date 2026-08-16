import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
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

    it('emits open so the owner can manage shares from the mailbox', async () => {
        const wrapper = mountIndicator(11)
        await flushPromises()
        await wrapper.get('[data-test="share-indicator"]').trigger('click')
        expect(wrapper.emitted('open')).toHaveLength(1)
    })
})
