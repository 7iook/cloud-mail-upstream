import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { useUserStore } from '@/store/user.js'
import { useSettingStore } from '@/store/setting.js'
import { useUiStore } from '@/store/ui.js'
import en from '@/i18n/en.js'

const { ElMessage } = vi.hoisted(() => ({
    ElMessage: vi.fn()
}))

vi.mock('element-plus', async (importOriginal) => {
    const actual = await importOriginal()
    return { ...actual, ElMessage }
})

vi.mock('@/router', () => ({
    default: { push: vi.fn(), replace: vi.fn() }
}))

vi.mock('vue-router', () => ({
    useRoute: () => ({ meta: { title: 'inbox' } })
}))

vi.mock('@/components/hamburger/index.vue', () => ({
    default: { name: 'hanburger', template: '<div class="hamburger-stub" />' }
}))

vi.mock('@iconify/vue', () => ({
    Icon: { name: 'Icon', template: '<span />' }
}))

vi.mock('@/perm/perm.js', () => ({
    hasPerm: () => true,
    default: { mounted() {} }
}))

setActivePinia(createPinia())
const { default: Header } = await import('./index.vue')

const stubs = {
    'el-dropdown': {
        template: '<div class="el-dropdown-stub"><slot /><slot name="dropdown" /></div>'
    },
    'el-tag': { template: '<span><slot /></span>' },
    'el-button': { template: '<button type="button"><slot /></button>' }
}

function seedStores() {
    const pinia = createPinia()
    setActivePinia(pinia)
    useUserStore().user = {
        name: 'Ada',
        email: 'ada@example.com',
        permKeys: ['*', 'email:send', 'account:add'],
        sendCount: 1,
        role: {
            name: 'user',
            sendType: 'count',
            sendCount: 10,
            accountCount: 5
        },
        account: { accountId: 1 }
    }
    useSettingStore().settings = {
        r2Domain: '',
        loginOpacity: 1,
        send: 0,
        manyEmail: 0,
        addEmail: 0
    }
    useUiStore().dark = false
    return pinia
}

function mountHeader() {
    const pinia = seedStores()
    const i18n = createI18n({
        legacy: false,
        locale: 'en',
        messages: { en }
    })
    return mount(Header, {
        global: {
            plugins: [pinia, i18n],
            stubs,
            directives: { perm: () => {} }
        }
    })
}

describe('header copy email (T-23 clipboard fallback)', () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const originalExecCommand = document.execCommand

    beforeEach(() => {
        ElMessage.mockReset()
    })

    afterEach(() => {
        if (originalClipboard) {
            Object.defineProperty(navigator, 'clipboard', originalClipboard)
        } else {
            delete navigator.clipboard
        }
        document.execCommand = originalExecCommand
        document.querySelectorAll('[data-copy-fallback]').forEach((el) => el.remove())
    })

    it('toasts success when Clipboard API writes the email', async () => {
        let stored = ''
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
                writeText: async (text) => {
                    stored = text
                }
            }
        })
        const wrapper = mountHeader()
        await wrapper.get('.detail-email').trigger('click')
        await flushPromises()
        expect(stored).toBe('ada@example.com')
        expect(ElMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'success',
            message: 'Copied successfully'
        }))
        wrapper.unmount()
    })

    it('does not toast success and shows selectable fallback when clipboard is missing after fix 2026-08-17', async () => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: undefined
        })
        document.execCommand = () => false
        const wrapper = mountHeader()
        await wrapper.get('.detail-email').trigger('click')
        await flushPromises()
        const successCalls = ElMessage.mock.calls.filter((args) => args[0] && args[0].type === 'success')
        expect(successCalls).toHaveLength(0)
        const fallback = document.querySelector('[data-copy-fallback]')
        expect(fallback).toBeTruthy()
        expect(fallback.value).toBe('ada@example.com')
        wrapper.unmount()
    })
})
