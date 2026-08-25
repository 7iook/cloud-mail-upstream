import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { useUserStore } from '@/store/user.js'
import { expectSameInstant } from '@/test/utc-instant.js'
import en from '@/i18n/en.js'

const { createMailShare, listMailShares, revokeMailShare, confirm, routerPush } = vi.hoisted(() => ({
    createMailShare: vi.fn(),
    listMailShares: vi.fn(),
    revokeMailShare: vi.fn(),
    confirm: vi.fn(),
    routerPush: vi.fn()
}))

// router/index.js default-exports null under MODE==='test', so the jump is only assertable
// against the mocked singleton; the module string matches the component's import verbatim.
vi.mock('@/router/index.js', () => ({
    default: {
        push: routerPush
    }
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

// day.js 在模块作用域就 `const settingStore = useSettingStore()`，import 期即需要活跃的 Pinia。
// 本弹窗自己不碰 settingStore，只有 day.js 读 lang，桩到 lang 即可，不动共享的 day.js。
vi.mock('@/store/setting.js', () => ({
    useSettingStore: () => ({ lang: 'zh' })
}))

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

import { ElMessage } from 'element-plus'
import {
    DURATION_CUSTOM,
    MAX_DURATION_DAYS,
    SHARE_DURATION_PRESETS
} from '@/views/share-admin/presets.js'
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
    // The duration select carries preset seconds alongside the 'custom' sentinel and the unit
    // select carries ids, so a stub that coerced everything to Number would turn both into NaN
    // and hide the sentinel handling entirely.
    'el-select': {
        props: ['modelValue'],
        emits: ['update:modelValue'],
        methods: {
            emitValue(raw) {
                this.$emit('update:modelValue', /^-?\d+$/.test(raw) ? Number(raw) : raw)
            }
        },
        template: '<select :value="modelValue" @change="emitValue($event.target.value)"><slot /></select>'
    },
    'el-input-number': {
        props: ['modelValue', 'min', 'step'],
        emits: ['update:modelValue'],
        template: '<input type="number" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value === \'\' ? null : Number($event.target.value))" />'
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

function mountDialog(props = {}, user = { permKeys: ['share:manage'] }) {
    const pinia = createPinia()
    setActivePinia(pinia)
    useUserStore().user = user
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
        routerPush.mockReset()
        ElMessage.mockClear()
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

    // 邮件页的分享列表读的是同一批后端裸串，和管理台必须同口径，否则同一条分享两处不一致。
    it('renders created / expiry / last access in the browser timezone (WA-TZ)', async () => {
        listMailShares.mockResolvedValue({ list: [sampleShare()], total: 1 })
        const wrapper = mountDialog()
        await flushPromises()

        const meta = wrapper.get('[data-test="share-row"]').text()
        const stamps = meta.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g) || []
        expect(stamps).toHaveLength(3)
        const [created, expires, lastAccess] = stamps
        expectSameInstant(created, '2026-08-17 01:00:00')
        expectSameInstant(expires, '2026-08-18 01:00:00')
        expectSameInstant(lastAccess, '2026-08-17 02:00:00')
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
        // Was /only time|cannot be retrieved/. Since the reveal endpoint landed the link *is*
        // retrievable from the detail drawer, so the old copy was telling the owner something
        // false — and a hint he cannot trust is worse than no hint. It still has to push him to
        // copy now, which is what this asserts.
        expect(wrapper.get('[data-test="secret-once"]').text()).toMatch(/copy .*now/i)
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

    it('closes itself before landing the owner on share-admin (AC-ADMIN-08)', async () => {
        const wrapper = mountDialog()
        await flushPromises()

        await wrapper.get('[data-test="goto-share-admin"]').trigger('click')
        await flushPromises()

        const closes = wrapper.emitted('update:modelValue')
        expect(closes[closes.length - 1]).toEqual([false])
        expect(routerPush).toHaveBeenCalledTimes(1)
        expect(routerPush).toHaveBeenCalledWith({ name: 'share-admin' })
    })

    it('hides the share-admin jump from owners without share:manage (AC-ADMIN-08)', async () => {
        // permsToRouter only addRoute()s share-admin for share:manage holders, so rendering the
        // jump for anyone else would push a name vue-router cannot resolve.
        const denied = mountDialog({}, { permKeys: ['email:send'] })
        await flushPromises()
        expect(denied.find('[data-test="goto-share-admin"]').exists()).toBe(false)
        // The entry degrades, the dialog does not.
        expect(denied.find('[data-test="create-share"]').exists()).toBe(true)

        // hasPerm() calls permKeys.includes() unguarded; an absent permKeys must not throw.
        const absent = mountDialog({}, {})
        await flushPromises()
        expect(absent.find('[data-test="goto-share-admin"]').exists()).toBe(false)

        expect(routerPush).not.toHaveBeenCalled()
    })

    it('still creates with the old single-mailbox four-field body (AC-CAP-10)', async () => {
        const wrapper = mountDialog()
        await flushPromises()
        await wrapper.get('[data-test="create-share"]').trigger('click')
        await flushPromises()

        const body = createMailShare.mock.calls[0][0]
        expect(body).toEqual({
            accountId: 11,
            durationSeconds: 3600,
            name: '',
            remark: ''
        })
        expect(body).not.toHaveProperty('accountIds')
        expect(body).not.toHaveProperty('authKeyEnabled')
        expect(body).not.toHaveProperty('maxSessions')
        expect(body).not.toHaveProperty('messageLimit')
    })

    it('keeps full share management out of the dialog (AC-ADMIN-08)', async () => {
        listMailShares.mockResolvedValue({ list: [sampleShare()], total: 1 })
        const wrapper = mountDialog()
        await flushPromises()

        const managementHooks = [
            'share-detail-drawer',
            'share-create-wizard',
            'binding-add',
            'authkey-once'
        ]
        managementHooks.forEach((hook) => {
            expect(wrapper.find(`[data-test="${hook}"]`).exists()).toBe(false)
        })
    })

    // W-E1: this dialog and the share-admin wizard are the same feature. A duration reachable
    // from one entry and not the other is the drift the shared module exists to prevent.
    it('offers every rung the wizard offers, plus the custom sentinel (W-E1)', async () => {
        const wrapper = mountDialog()
        await flushPromises()

        const values = wrapper.get('[data-test="duration-select"]')
            .findAll('option')
            .map((option) => option.attributes('value'))
        expect(values).toEqual([
            ...SHARE_DURATION_PRESETS.map((row) => String(row.value)),
            DURATION_CUSTOM
        ])
    })

    it('sends a custom 30-day duration as seconds (W-E1)', async () => {
        const wrapper = mountDialog()
        await flushPromises()

        expect(wrapper.find('[data-test="duration-amount"]').exists()).toBe(false)

        await wrapper.get('[data-test="duration-select"]').setValue(DURATION_CUSTOM)
        await wrapper.get('[data-test="duration-unit"]').setValue('days')
        await wrapper.get('[data-test="duration-amount"]').setValue(30)
        await wrapper.get('[data-test="create-share"]').trigger('click')
        await flushPromises()

        expect(createMailShare.mock.calls[0][0].durationSeconds).toBe(2592000)
    })

    it('warns with the ceiling instead of submitting a ten-year share (W-E1)', async () => {
        const wrapper = mountDialog()
        await flushPromises()

        await wrapper.get('[data-test="duration-select"]').setValue(DURATION_CUSTOM)
        await wrapper.get('[data-test="duration-unit"]').setValue('days')
        await wrapper.get('[data-test="duration-amount"]').setValue(3650)
        await wrapper.get('[data-test="create-share"]').trigger('click')
        await flushPromises()

        expect(createMailShare).not.toHaveBeenCalled()
        const warned = ElMessage.mock.calls.map((call) => call[0].message).join(' ')
        expect(warned).toContain(String(MAX_DURATION_DAYS))
        expect(warned).not.toContain('{days}')
        expect(wrapper.get('[data-test="duration-ceiling"]').text()).toContain(String(MAX_DURATION_DAYS))
    })

    it('returns to a rung without stranding the custom fields (W-E1)', async () => {
        const wrapper = mountDialog()
        await flushPromises()

        await wrapper.get('[data-test="duration-select"]').setValue(DURATION_CUSTOM)
        await wrapper.get('[data-test="duration-amount"]').setValue(30)
        await wrapper.get('[data-test="duration-select"]').setValue('604800')
        await wrapper.get('[data-test="create-share"]').trigger('click')
        await flushPromises()

        expect(wrapper.find('[data-test="duration-amount"]').exists()).toBe(false)
        expect(createMailShare.mock.calls[0][0].durationSeconds).toBe(604800)
    })
})
