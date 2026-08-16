import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { useUserStore } from '@/store/user.js'
import en from '@/i18n/en.js'

const { createMailShare, listMailShares, revokeMailShare, confirm } = vi.hoisted(() => ({
    createMailShare: vi.fn(),
    listMailShares: vi.fn(),
    revokeMailShare: vi.fn(),
    confirm: vi.fn()
}))

vi.mock('@/request/mail-share.js', async (importOriginal) => {
    const actual = await importOriginal()
    return {
        ...actual,
        createMailShare,
        listMailShares,
        revokeMailShare
    }
})

vi.mock('@/composables/useCopyWithFallback.js', () => ({
    useCopyWithFallback: () => ({
        copy: vi.fn(async (text) => ({ copied: true, path: 'clipboard', text })),
        selectableRef: { value: null },
        fallbackActive: { value: false },
        fallbackText: { value: '' }
    })
}))

vi.mock('element-plus', async (importOriginal) => {
    const actual = await importOriginal()
    return {
        ...actual,
        ElMessage: vi.fn(),
        ElMessageBox: { confirm }
    }
})

import ShareDialog from './ShareDialog.vue'

const SECRET = 'sec-shown-once'
const SHARE_URL = `https://mail.example/s/lid-1#${SECRET}`

const stubs = {
    'el-dialog': {
        props: ['modelValue', 'title'],
        template: '<div class="el-dialog-stub" v-if="modelValue"><slot /><slot name="footer" /></div>'
    },
    'el-input': {
        props: ['modelValue'],
        emits: ['update:modelValue'],
        template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />'
    },
    'el-select': {
        props: ['modelValue'],
        emits: ['update:modelValue'],
        template: '<select :value="modelValue" @change="$emit(\'update:modelValue\', Number($event.target.value))"><slot /></select>'
    },
    'el-option': {
        props: ['label', 'value'],
        template: '<option :value="value">{{ label }}</option>'
    },
    'el-button': {
        props: ['disabled'],
        template: '<button type="button" :disabled="disabled"><slot /></button>'
    },
    'el-alert': {
        props: ['title'],
        template: '<div><slot /><span>{{ title }}</span></div>'
    },
    'el-tag': { template: '<span><slot /></span>' }
}

function sampleShare(overrides = {}) {
    return {
        shareId: 7,
        lid: 'lid-1',
        accountId: 11,
        mailbox: 'otp@example.com',
        name: 'desk',
        remark: 'front',
        status: 'ACTIVE',
        effectiveStatus: 'ACTIVE',
        createTime: '2026-08-17 01:00:00',
        expiresAt: '2026-08-18 01:00:00',
        accessCount: 2,
        lastAccessAt: '2026-08-17 02:00:00',
        ...overrides
    }
}

function mountDialog(props = {}) {
    const pinia = createPinia()
    setActivePinia(pinia)
    useUserStore().user = { permKeys: ['share:manage'] }
    const i18n = createI18n({
        legacy: false,
        locale: 'en',
        messages: { en }
    })
    return mount(ShareDialog, {
        props: {
            modelValue: true,
            accountId: 11,
            ...props
        },
        global: {
            plugins: [pinia, i18n],
            stubs
        }
    })
}

describe('ShareDialog owner management (AC-MGMT / AC-SHARE / AC-LEAK-01)', () => {
    beforeEach(() => {
        createMailShare.mockReset()
        listMailShares.mockReset()
        revokeMailShare.mockReset()
        confirm.mockReset()
        listMailShares.mockResolvedValue({ list: [], total: 0 })
        createMailShare.mockResolvedValue({
            shareId: 7,
            lid: 'lid-1',
            sec: SECRET,
            expiresAt: '2026-08-18 01:00:00',
            shareUrl: SHARE_URL
        })
        revokeMailShare.mockResolvedValue({ shareId: 7 })
        confirm.mockResolvedValue()
    })

    it('shows the access-risk warning before create is available (AC-MGMT-06)', async () => {
        const wrapper = mountDialog()
        await flushPromises()
        const warning = wrapper.get('[data-test="create-warning"]').text()
        expect(warning).toMatch(/anyone with this link can read/i)
        expect(wrapper.get('[data-test="create-share"]').exists()).toBe(true)
    })

    it('shows the create secret once and never copies it from a later list (AC-SHARE-04, AC-LEAK-01)', async () => {
        listMailShares.mockResolvedValue({
            list: [sampleShare()],
            total: 1
        })
        const wrapper = mountDialog()
        await flushPromises()
        await wrapper.get('[data-test="create-share"]').trigger('click')
        await flushPromises()

        const urlField = wrapper.get('[data-test="share-url"]')
        expect(urlField.element.value).toBe(SHARE_URL)
        expect(urlField.element.value).toContain(`#${SECRET}`)
        expect(wrapper.get('[data-test="secret-once"]').text()).toMatch(/only time|cannot be retrieved/i)
        expect(createMailShare).toHaveBeenCalledTimes(1)
        const listText = wrapper.findAll('[data-test="share-row"]').map((row) => row.text()).join(' ')
        expect(listText).not.toContain(SECRET)
        expect(wrapper.get('[data-test="share-url"]').element.value).toContain(`#${SECRET}`)
    })

    it('sends the same Idempotency-Key when create is retried without changing the form (AC-SHARE-11)', async () => {
        createMailShare
            .mockRejectedValueOnce({ code: 500, message: 'SHARE_DISABLED' })
            .mockResolvedValueOnce({
                shareId: 7,
                lid: 'lid-1',
                sec: SECRET,
                shareUrl: SHARE_URL,
                expiresAt: '2026-08-18 01:00:00'
            })
        const wrapper = mountDialog()
        await flushPromises()
        await wrapper.get('[data-test="create-share"]').trigger('click')
        await flushPromises()
        await wrapper.get('[data-test="create-share"]').trigger('click')
        await flushPromises()

        expect(createMailShare).toHaveBeenCalledTimes(2)
        const firstKey = createMailShare.mock.calls[0][1]
        const secondKey = createMailShare.mock.calls[1][1]
        expect(firstKey).toEqual(expect.any(String))
        expect(firstKey.length).toBeGreaterThan(8)
        expect(secondKey).toBe(firstKey)
    })

    it('does not revoke until the owner confirms destruction (AC-MGMT-05)', async () => {
        listMailShares.mockResolvedValue({ list: [sampleShare()], total: 1 })
        confirm.mockRejectedValueOnce('cancel')
        const wrapper = mountDialog()
        await flushPromises()

        await wrapper.get('[data-test="revoke-share"]').trigger('click')
        await flushPromises()
        expect(confirm).toHaveBeenCalled()
        expect(revokeMailShare).not.toHaveBeenCalled()

        confirm.mockResolvedValueOnce()
        await wrapper.get('[data-test="revoke-share"]').trigger('click')
        await flushPromises()
        expect(revokeMailShare).toHaveBeenCalledWith(7)
    })

    it('renders the API effectiveStatus instead of recomputing expiry (AC-LIFE-08)', async () => {
        listMailShares.mockResolvedValue({
            list: [sampleShare({
                effectiveStatus: 'EXPIRED',
                status: 'ACTIVE',
                expiresAt: '2099-01-01 00:00:00'
            })],
            total: 1
        })
        const wrapper = mountDialog()
        await flushPromises()
        const row = wrapper.get('[data-test="share-row"]')
        expect(row.attributes('data-status')).toBe('EXPIRED')
        expect(row.text()).toMatch(/expired/i)
        expect(row.text()).not.toMatch(/active/i)
    })

    it('labels access count as a successful link open, not a read receipt', async () => {
        listMailShares.mockResolvedValue({ list: [sampleShare()], total: 1 })
        const wrapper = mountDialog()
        await flushPromises()
        const label = wrapper.get('[data-test="access-label"]').text()
        expect(label).toMatch(/successful open/i)
        expect(label).not.toMatch(/recipient read|delivered|read receipt/i)
    })
})
