import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/en.js'

const {
    getMailShare,
    updateMailShare,
    updateMailShareBindings,
    resetMailShareAuthKey,
    accountList,
    confirm,
    message
} = vi.hoisted(() => ({
    getMailShare: vi.fn(),
    updateMailShare: vi.fn(),
    updateMailShareBindings: vi.fn(),
    resetMailShareAuthKey: vi.fn(),
    accountList: vi.fn(),
    confirm: vi.fn(),
    message: vi.fn()
}))

// importOriginal keeps isShareForbidden real: mocking the whole module would make the
// drawer's 403 predicate undefined and turn the failure branches green for the wrong reason.
vi.mock('@/request/mail-share.js', async (importOriginal) => {
    const actual = await importOriginal()
    return {
        ...actual,
        getMailShare,
        updateMailShare,
        updateMailShareBindings,
        resetMailShareAuthKey
    }
})

vi.mock('@/request/account.js', async (importOriginal) => {
    const actual = await importOriginal()
    return {
        ...actual,
        accountList
    }
})

vi.mock('element-plus', async (importOriginal) => {
    const actual = await importOriginal()
    return {
        ...actual,
        ElMessage: message,
        ElMessageBox: { confirm }
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

import ShareDetailDrawer from './ShareDetailDrawer.vue'

const AUTH_KEY = 'Ab3dEf0123456789_-xyQ'

const stubs = {
    Icon: { template: '<i />' },
    'el-drawer': {
        props: ['modelValue', 'title', 'size', 'direction', 'destroyOnClose'],
        emits: ['update:modelValue'],
        template: '<div class="el-drawer-stub" v-if="modelValue"><header>{{ title }}</header><slot /></div>'
    },
    'el-tag': { props: ['type'], template: '<span :data-tone="type"><slot /></span>' },
    'el-button': {
        props: ['disabled', 'loading', 'type', 'text'],
        template: '<button type="button" :disabled="disabled"><slot /></button>'
    },
    'el-input': {
        props: ['modelValue', 'disabled'],
        emits: ['update:modelValue'],
        template: '<input :value="modelValue" :disabled="disabled" @input="$emit(\'update:modelValue\', $event.target.value)" />'
    },
    'el-input-number': {
        props: ['modelValue', 'min', 'disabled'],
        emits: ['update:modelValue'],
        template: '<input type="number" :value="modelValue" :disabled="disabled" @input="$emit(\'update:modelValue\', $event.target.value === \'\' ? null : Number($event.target.value))" />'
    },
    'el-switch': {
        props: ['modelValue', 'disabled'],
        emits: ['update:modelValue'],
        template: '<input type="checkbox" :checked="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.checked)" />'
    },
    'el-checkbox': {
        props: ['modelValue', 'disabled'],
        emits: ['update:modelValue'],
        template: '<input type="checkbox" :checked="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.checked)" />'
    },
    'el-select': {
        props: ['modelValue', 'disabled'],
        emits: ['update:modelValue'],
        template: '<select :value="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', Number($event.target.value))"><slot /></select>'
    },
    'el-option': {
        props: ['label', 'value'],
        template: '<option :value="value">{{ label }}</option>'
    }
}

// bindingId and accountId are deliberately different numbers: add takes accountId and
// remove takes bindingId, and the backend answers a swapped pair with a FORBIDDEN code
// rather than telling anyone the dimension was wrong.
function sampleDetail(overrides = {}) {
    return {
        shareId: 7,
        lid: 'lid-7',
        name: 'front desk',
        remark: 'lobby',
        status: 'ACTIVE',
        effectiveStatus: 'ACTIVE',
        shareType: 'single',
        mailbox: 'otp@example.com',
        bindings: [{ bindingId: 91, accountId: 11, mailbox: 'otp@example.com' }],
        accessCount: 2,
        usedSessions: 2,
        maxSessions: 5,
        messageLimit: 50,
        onlyMessagesAfterCreated: true,
        otpExtractionEnabled: true,
        autoRefresh: false,
        refreshIntervalMs: 15000,
        showFullAddress: false,
        authKeyEnabled: false,
        createTime: '2026-08-17 01:00:00',
        expiresAt: '2026-08-18 01:00:00',
        lastAccessAt: '2026-08-17 02:00:00',
        revokedAt: null,
        deleteAt: null,
        ...overrides
    }
}

function mountDrawer(props = {}) {
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
    return mount(ShareDetailDrawer, {
        props: { shareId: 7, ...props },
        global: { plugins: [i18n], stubs }
    })
}

async function openDrawer(props = {}) {
    const wrapper = mountDrawer(props)
    await flushPromises()
    return wrapper
}

async function setMaxSessions(wrapper, value) {
    await wrapper.get('[data-test="max-sessions-unlimited"]').setValue(false)
    await wrapper.get('[data-test="max-sessions"]').setValue(value)
}

function saveBody() {
    return updateMailShare.mock.calls[0][0]
}

function deferred() {
    let resolve
    let reject
    const promise = new Promise((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

// The one-shot plaintext must live in exactly one readonly input and in no rendered text.
function plaintextTrace(wrapper) {
    return {
        inputs: wrapper.findAll('input').filter((node) => String(node.element.value || '').includes(AUTH_KEY)),
        inText: wrapper.text().includes(AUTH_KEY)
    }
}

describe('share detail drawer · read side (AC-ADMIN-02 / AC-ADMIN-09 / AC-CAP-05)', () => {
    beforeEach(() => {
        getMailShare.mockReset()
        updateMailShare.mockReset()
        updateMailShareBindings.mockReset()
        resetMailShareAuthKey.mockReset()
        accountList.mockReset()
        confirm.mockReset()
        message.mockReset()
        getMailShare.mockResolvedValue(sampleDetail())
        updateMailShare.mockImplementation(async () => sampleDetail())
        accountList.mockResolvedValue([{ accountId: 12, email: 'ops@example.com', sort: 5 }])
        confirm.mockResolvedValue('confirm')
    })

    it('loads the detail once and shows every binding address plus the shared status badge (D1)', async () => {
        getMailShare.mockResolvedValue(sampleDetail({
            shareType: 'multi',
            bindings: [
                { bindingId: 91, accountId: 11, mailbox: 'otp@example.com' },
                { bindingId: 92, accountId: 12, mailbox: 'ops@example.com' }
            ]
        }))
        const wrapper = await openDrawer()

        expect(getMailShare).toHaveBeenCalledTimes(1)
        expect(getMailShare).toHaveBeenCalledWith(7)

        const badge = wrapper.get('[data-test="detail-status"]')
        expect(badge.attributes('data-status')).toBe('ACTIVE')
        // statusMeta is the single source of truth for the label, so this is the list page's text.
        expect(badge.text()).toBe('Active')

        const rows = wrapper.findAll('[data-test="binding-row"]')
        expect(rows).toHaveLength(2)
        expect(rows[0].text()).toContain('otp@example.com')
        expect(rows[1].text()).toContain('ops@example.com')
        expect(wrapper.get('[data-test="detail-quota"]').text()).toContain('2')
        expect(wrapper.get('[data-test="detail-quota"]').text()).toContain('5')
    })

    it('falls back to #accountId for a binding whose account was hard deleted', async () => {
        getMailShare.mockResolvedValue(sampleDetail({
            bindings: [{ bindingId: 91, accountId: 11, mailbox: '' }]
        }))
        const wrapper = await openDrawer()

        expect(wrapper.get('[data-test="binding-row"]').text()).toContain('#11')
    })

    it('closes and refreshes the list when the share is already gone (D2)', async () => {
        getMailShare.mockRejectedValue({ code: 500, message: 'SHARE_NOT_FOUND' })
        const wrapper = await openDrawer()

        expect(wrapper.emitted('update:shareId')).toEqual([[0]])
        expect(wrapper.emitted('changed')).toHaveLength(1)
        expect(wrapper.find('[data-test="config-save"]').exists()).toBe(false)
        // A drawer that vanishes without a word reads as a lost click.
        expect(message).toHaveBeenCalledTimes(1)
    })

    it('never renders a one-shot key block from a plain detail: the detail has no authKey (D3)', async () => {
        const wrapper = await openDrawer()

        expect(wrapper.find('[data-test="authkey-state"]').exists()).toBe(true)
        expect(wrapper.find('[data-test="authkey-once"]').exists()).toBe(false)
    })
})

describe('share detail drawer · bindings (AC-BIND-02/04/12 / AC-CAP-13)', () => {
    beforeEach(() => {
        getMailShare.mockReset()
        updateMailShare.mockReset()
        updateMailShareBindings.mockReset()
        resetMailShareAuthKey.mockReset()
        accountList.mockReset()
        confirm.mockReset()
        message.mockReset()
        getMailShare.mockResolvedValue(sampleDetail())
        accountList.mockResolvedValue([{ accountId: 12, email: 'ops@example.com', sort: 5 }])
        updateMailShareBindings.mockResolvedValue({
            shareId: 7,
            status: 'ACTIVE',
            shareType: 'multi',
            bindings: [{ bindingId: 91, accountId: 11 }, { bindingId: 92, accountId: 12 }]
        })
        confirm.mockResolvedValue('confirm')
    })

    it('adds a mailbox by accountId, not by bindingId (B1)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="binding-add-select"]').setValue('12')
        await wrapper.get('[data-test="binding-add"]').trigger('click')
        await flushPromises()

        expect(updateMailShareBindings).toHaveBeenCalledTimes(1)
        expect(updateMailShareBindings).toHaveBeenCalledWith({ shareId: 7, add: [12] })
    })

    it('removes a mailbox by bindingId, not by accountId (B2)', async () => {
        const wrapper = await openDrawer()

        await wrapper.findAll('[data-test="binding-remove"]')[0].trigger('click')
        await flushPromises()

        const body = updateMailShareBindings.mock.calls[0][0]
        expect(body.remove).toEqual([91])
        expect(body.remove).not.toContain(11)
        // One dimension per request: mixing add with remove is SHARE_BINDING_DUPLICATE.
        expect(body).not.toHaveProperty('add')
    })

    it('sends nothing when the remove confirm is dismissed (B3)', async () => {
        confirm.mockRejectedValue('cancel')
        const wrapper = await openDrawer()

        await wrapper.findAll('[data-test="binding-remove"]')[0].trigger('click')
        await flushPromises()

        expect(confirm).toHaveBeenCalledTimes(1)
        expect(updateMailShareBindings).not.toHaveBeenCalled()
    })

    it('re-reads the detail after a bindings write, because that response has no mailbox (B4)', async () => {
        getMailShare
            .mockResolvedValueOnce(sampleDetail())
            .mockResolvedValueOnce(sampleDetail({
                shareType: 'multi',
                bindings: [
                    { bindingId: 91, accountId: 11, mailbox: 'otp@example.com' },
                    { bindingId: 92, accountId: 12, mailbox: 'ops@example.com' }
                ]
            }))
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="binding-add-select"]').setValue('12')
        await wrapper.get('[data-test="binding-add"]').trigger('click')
        await flushPromises()

        expect(getMailShare).toHaveBeenCalledTimes(2)
        const labels = wrapper.findAll('[data-test="binding-row"]').map((node) => node.text())
        expect(labels).toHaveLength(2)
        expect(labels.join(' ')).toContain('otp@example.com')
        expect(labels.join(' ')).toContain('ops@example.com')
    })

    it('warns that removing the last mailbox destroys the whole share (B5 copy)', async () => {
        const single = await openDrawer()
        await single.findAll('[data-test="binding-remove"]')[0].trigger('click')
        await flushPromises()
        const lastCopy = confirm.mock.calls[0][0]

        confirm.mockClear()
        getMailShare.mockResolvedValue(sampleDetail({
            shareType: 'multi',
            bindings: [
                { bindingId: 91, accountId: 11, mailbox: 'otp@example.com' },
                { bindingId: 92, accountId: 12, mailbox: 'ops@example.com' }
            ]
        }))
        const multi = await openDrawer()
        await multi.findAll('[data-test="binding-remove"]')[0].trigger('click')
        await flushPromises()
        const ordinaryCopy = confirm.mock.calls[0][0]

        expect(lastCopy).toBeTruthy()
        expect(lastCopy).not.toBe(ordinaryCopy)
    })

    it('turns read-only and refreshes the list when the last removal revoked the share (B5)', async () => {
        updateMailShareBindings.mockResolvedValue({ shareId: 7, status: 'REVOKED', shareType: 'single', bindings: [] })
        getMailShare
            .mockResolvedValueOnce(sampleDetail())
            .mockResolvedValueOnce(sampleDetail({ status: 'REVOKED', effectiveStatus: 'REVOKED', bindings: [] }))
        const wrapper = await openDrawer()

        await wrapper.findAll('[data-test="binding-remove"]')[0].trigger('click')
        await flushPromises()

        expect(wrapper.emitted('changed')).toBeTruthy()
        expect(wrapper.get('[data-test="detail-readonly"]').exists()).toBe(true)
        expect(wrapper.get('[data-test="config-save"]').attributes('disabled')).toBeDefined()
    })

    it('re-reads instead of replaying the same remove after SHARE_BINDING_CONFLICT (B6)', async () => {
        updateMailShareBindings.mockRejectedValue({ code: 500, message: 'SHARE_BINDING_CONFLICT' })
        const wrapper = await openDrawer()

        await wrapper.findAll('[data-test="binding-remove"]')[0].trigger('click')
        await flushPromises()

        expect(updateMailShareBindings).toHaveBeenCalledTimes(1)
        expect(getMailShare).toHaveBeenCalledTimes(2)
        // The raw SHARE_BINDING_CONFLICT toast says nothing about what to do next.
        expect(wrapper.get('[data-test="binding-error"]').text()).toBeTruthy()
    })

    it('disables the add control at the 50 binding ceiling and asks for no account page (B7)', async () => {
        getMailShare.mockResolvedValue(sampleDetail({
            shareType: 'multi',
            bindings: Array.from({ length: 50 }, (unused, index) => ({
                bindingId: 100 + index,
                accountId: 200 + index,
                mailbox: `box${index}@example.com`
            }))
        }))
        const wrapper = await openDrawer()

        expect(wrapper.get('[data-test="binding-add-select"]').attributes('disabled')).toBeDefined()
        expect(wrapper.find('[data-test="binding-limit"]').exists()).toBe(true)
        expect(accountList).not.toHaveBeenCalled()

        await wrapper.get('[data-test="binding-add"]').trigger('click')
        await flushPromises()
        expect(updateMailShareBindings).not.toHaveBeenCalled()
    })

    it('pages the account picker with a cursor and a size the backend will not clamp (T15)', async () => {
        accountList
            .mockResolvedValueOnce(Array.from({ length: 30 }, (unused, index) => ({
                accountId: 20 + index,
                email: `box${index}@example.com`,
                sort: 100 + index
            })))
            .mockResolvedValueOnce([{ accountId: 80, email: 'tail@example.com', sort: 200 }])
        const wrapper = await openDrawer()

        // account/list caps size at 30 and pages by (last accountId, last sort), so a single
        // shot would hide every mailbox past the thirtieth.
        expect(accountList).toHaveBeenCalledTimes(1)
        expect(accountList).toHaveBeenCalledWith(0, 30, null)

        await wrapper.get('[data-test="binding-load-more"]').trigger('click')
        await flushPromises()

        expect(accountList).toHaveBeenCalledTimes(2)
        expect(accountList).toHaveBeenLastCalledWith(49, 30, 129)
        expect(wrapper.find('[data-test="binding-load-more"]').exists()).toBe(false)
    })
})

describe('share detail drawer · config patch (AC-ADMIN-03 / AC-EDGE-14 / AC-LIFE-11)', () => {
    beforeEach(() => {
        getMailShare.mockReset()
        updateMailShare.mockReset()
        updateMailShareBindings.mockReset()
        resetMailShareAuthKey.mockReset()
        accountList.mockReset()
        confirm.mockReset()
        message.mockReset()
        getMailShare.mockResolvedValue(sampleDetail())
        updateMailShare.mockImplementation(async () => sampleDetail())
        accountList.mockResolvedValue([])
        confirm.mockResolvedValue('confirm')
    })

    it('sends only the dirty field, never the untouched quota columns (C1)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="config-name"]').setValue('lobby desk')
        await wrapper.get('[data-test="config-save"]').trigger('click')
        await flushPromises()

        expect(updateMailShare).toHaveBeenCalledTimes(1)
        // A full-form PUT would carry maxSessions:5 / messageLimit:50 and trip the V2 gate,
        // so renaming a share would fail with SHARE_INVALID_CONFIG.
        expect(saveBody()).toEqual({ shareId: 7, name: 'lobby desk' })
        expect(saveBody()).not.toHaveProperty('maxSessions')
        expect(saveBody()).not.toHaveProperty('messageLimit')
        expect(saveBody()).not.toHaveProperty('remark')
        expect(saveBody()).not.toHaveProperty('refreshIntervalMs')
        expect(confirm).not.toHaveBeenCalled()
    })

    it('clears a limit with an explicit null, not a missing key and not a zero (C2)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="max-sessions-unlimited"]').setValue(true)
        await wrapper.get('[data-test="config-save"]').trigger('click')
        await flushPromises()

        const body = saveBody()
        expect(Object.prototype.hasOwnProperty.call(body, 'maxSessions')).toBe(true)
        expect(body.maxSessions).toBeNull()
        expect(body.maxSessions).not.toBe(0)
        expect(body.maxSessions).not.toBe('')
        expect(confirm).not.toHaveBeenCalled()
    })

    it('asks about the used-session count on the first finite limit, and honours all three answers (C3)', async () => {
        getMailShare.mockResolvedValue(sampleDetail({ maxSessions: null }))

        confirm.mockResolvedValue('confirm')
        const reset = await openDrawer()
        await setMaxSessions(reset, 5)
        await reset.get('[data-test="config-save"]').trigger('click')
        await flushPromises()
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(saveBody().maxSessions).toBe(5)
        expect(saveBody().resetUsedSessions === undefined || saveBody().resetUsedSessions === true).toBe(true)

        updateMailShare.mockClear()
        confirm.mockReset()
        confirm.mockRejectedValue('cancel')
        const keep = await openDrawer()
        await setMaxSessions(keep, 5)
        await keep.get('[data-test="config-save"]').trigger('click')
        await flushPromises()
        expect(saveBody().resetUsedSessions).toBe(false)

        updateMailShare.mockClear()
        confirm.mockReset()
        confirm.mockRejectedValue('close')
        const aborted = await openDrawer()
        await setMaxSessions(aborted, 5)
        await aborted.get('[data-test="config-save"]').trigger('click')
        await flushPromises()
        expect(updateMailShare).not.toHaveBeenCalled()
    })

    it('does not ask again when the share already had a finite limit (C4)', async () => {
        const wrapper = await openDrawer()

        await setMaxSessions(wrapper, 8)
        await wrapper.get('[data-test="config-save"]').trigger('click')
        await flushPromises()

        expect(confirm).not.toHaveBeenCalled()
        expect(saveBody()).toEqual({ shareId: 7, maxSessions: 8 })
    })

    it('stops a sub-3000ms refresh interval in the browser instead of posting it (C5)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="refresh-interval"]').setValue(2999)
        await wrapper.get('[data-test="config-save"]').trigger('click')
        await flushPromises()

        expect(updateMailShare).not.toHaveBeenCalled()
        expect(wrapper.find('[data-test="config-error"]').exists()).toBe(true)
    })

    it('keeps an emptied refresh interval out of the patch (T7)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="refresh-interval"]').setValue('')
        await wrapper.get('[data-test="config-name"]').setValue('lobby desk')
        await wrapper.get('[data-test="config-save"]').trigger('click')
        await flushPromises()

        // Number(null) is 0, which the 3000ms floor rejects: an empty box means "no opinion".
        expect(saveBody()).not.toHaveProperty('refreshIntervalMs')
    })

    it('consumes the update response instead of re-reading the detail (C6)', async () => {
        updateMailShare.mockResolvedValue(sampleDetail({ name: 'renamed desk' }))
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="config-name"]').setValue('renamed desk')
        await wrapper.get('[data-test="config-save"]').trigger('click')
        await flushPromises()

        expect(wrapper.get('[data-test="detail-name"]').text()).toBe('renamed desk')
        expect(getMailShare).toHaveBeenCalledTimes(1)
    })

    it('sends nothing at all when no field is dirty', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="config-save"]').trigger('click')
        await flushPromises()

        expect(updateMailShare).not.toHaveBeenCalled()
    })
})

describe('share detail drawer · access key (AC-ADMIN-05 / AC-AUTH-07 / AC-AUTH-08 / AC-CAP-05)', () => {
    beforeEach(() => {
        getMailShare.mockReset()
        updateMailShare.mockReset()
        updateMailShareBindings.mockReset()
        resetMailShareAuthKey.mockReset()
        accountList.mockReset()
        confirm.mockReset()
        message.mockReset()
        getMailShare.mockResolvedValue(sampleDetail())
        updateMailShare.mockImplementation(async () => sampleDetail())
        accountList.mockResolvedValue([])
        confirm.mockResolvedValue('confirm')
    })

    it('shows the new key exactly once after enable (K1)', async () => {
        resetMailShareAuthKey.mockResolvedValue({ ...sampleDetail({ authKeyEnabled: true }), authKey: AUTH_KEY })
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="authkey-enable"]').trigger('click')
        await flushPromises()

        expect(resetMailShareAuthKey).toHaveBeenCalledWith({ shareId: 7, action: 'enable' })
        expect(wrapper.get('[data-test="authkey-value"]').element.value).toBe(AUTH_KEY)
        expect(wrapper.get('[data-test="authkey-once"]').text()).toBeTruthy()
        expect(wrapper.get('[data-test="authkey-state"]').text()).toBeTruthy()
        expect(wrapper.find('[data-test="authkey-reset"]').exists()).toBe(true)
    })

    it('keeps the plaintext out of every detail field and drops it on acknowledge (K2)', async () => {
        resetMailShareAuthKey.mockResolvedValue({ ...sampleDetail({ authKeyEnabled: true }), authKey: AUTH_KEY })
        updateMailShare.mockResolvedValue(sampleDetail({ authKeyEnabled: true, name: 'renamed desk' }))
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="authkey-enable"]').trigger('click')
        await flushPromises()

        // A detail refresh must not resurrect nor erase it: the plaintext lives in one local ref.
        await wrapper.get('[data-test="config-name"]').setValue('renamed desk')
        await wrapper.get('[data-test="config-save"]').trigger('click')
        await flushPromises()

        expect(wrapper.get('[data-test="detail-name"]').text()).toBe('renamed desk')
        const survived = plaintextTrace(wrapper)
        expect(survived.inputs).toHaveLength(1)
        expect(survived.inputs[0].attributes('data-test')).toBe('authkey-value')
        expect(survived.inText).toBe(false)

        await wrapper.get('[data-test="authkey-ack"]').trigger('click')
        const gone = plaintextTrace(wrapper)
        expect(wrapper.find('[data-test="authkey-once"]').exists()).toBe(false)
        expect(gone.inputs).toHaveLength(0)
        expect(gone.inText).toBe(false)
    })

    it('confirms reset and disable with distinct copy, and enable with none (K3)', async () => {
        getMailShare.mockResolvedValue(sampleDetail({ authKeyEnabled: true }))
        resetMailShareAuthKey.mockResolvedValue({ ...sampleDetail({ authKeyEnabled: true }), authKey: AUTH_KEY })
        confirm.mockRejectedValue('cancel')
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="authkey-reset"]').trigger('click')
        await flushPromises()
        await wrapper.get('[data-test="authkey-disable"]').trigger('click')
        await flushPromises()

        expect(resetMailShareAuthKey).not.toHaveBeenCalled()
        const resetCopy = confirm.mock.calls[0][0]
        const disableCopy = confirm.mock.calls[1][0]
        expect(resetCopy).toBeTruthy()
        expect(disableCopy).toBeTruthy()
        expect(resetCopy).not.toBe(disableCopy)

        confirm.mockReset()
        confirm.mockResolvedValue('confirm')
        await wrapper.get('[data-test="authkey-reset"]').trigger('click')
        await flushPromises()
        expect(resetMailShareAuthKey).toHaveBeenCalledWith({ shareId: 7, action: 'reset' })
    })

    it('enable asks for no kill confirm because it does not end open visits (K3 honesty)', async () => {
        resetMailShareAuthKey.mockResolvedValue({ ...sampleDetail({ authKeyEnabled: true }), authKey: AUTH_KEY })
        const wrapper = await openDrawer()

        // share-integration.spec.js:1436 pins that enable leaves established sessions alone,
        // so the enable path carries a hint instead of the destructive confirm.
        expect(wrapper.get('[data-test="authkey-enable-hint"]').text()).toBeTruthy()

        await wrapper.get('[data-test="authkey-enable"]').trigger('click')
        await flushPromises()

        expect(confirm).not.toHaveBeenCalled()
        expect(resetMailShareAuthKey).toHaveBeenCalledTimes(1)
    })

    it('renders no plaintext block for disable, which returns no authKey key (K4)', async () => {
        getMailShare.mockResolvedValue(sampleDetail({ authKeyEnabled: true }))
        resetMailShareAuthKey.mockResolvedValue(sampleDetail({ authKeyEnabled: false }))
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="authkey-disable"]').trigger('click')
        await flushPromises()

        expect(resetMailShareAuthKey).toHaveBeenCalledWith({ shareId: 7, action: 'disable' })
        expect(wrapper.find('[data-test="authkey-once"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="authkey-enable"]').exists()).toBe(true)
    })

    it('clears the one-shot key when disable succeeds after enable (T21-P2-1)', async () => {
        resetMailShareAuthKey
            .mockResolvedValueOnce({ ...sampleDetail({ authKeyEnabled: true }), authKey: AUTH_KEY })
            .mockResolvedValueOnce(sampleDetail({ authKeyEnabled: false }))
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="authkey-enable"]').trigger('click')
        await flushPromises()
        expect(wrapper.find('[data-test="authkey-once"]').exists()).toBe(true)

        await wrapper.get('[data-test="authkey-disable"]').trigger('click')
        await flushPromises()

        expect(wrapper.find('[data-test="authkey-once"]').exists()).toBe(false)
        expect(plaintextTrace(wrapper).inputs).toHaveLength(0)
        expect(wrapper.find('[data-test="authkey-enable"]').exists()).toBe(true)
    })

    it('keeps the panel intact and stays disabled when enable is refused (K5)', async () => {
        resetMailShareAuthKey.mockRejectedValue({ code: 500, message: 'SHARE_INVALID_CONFIG' })
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="authkey-enable"]').trigger('click')
        await flushPromises()

        expect(wrapper.find('[data-test="authkey-error"]').exists()).toBe(true)
        expect(wrapper.find('[data-test="authkey-once"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="authkey-enable"]').exists()).toBe(true)
        expect(wrapper.find('[data-test="authkey-reset"]').exists()).toBe(false)
    })
})

describe('share detail drawer · write predicate (AC-ADMIN-04 / AC-ADMIN-09)', () => {
    const WRITE_HOOKS = ['config-save', 'binding-add', 'binding-add-select', 'config-name', 'authkey-enable']

    beforeEach(() => {
        getMailShare.mockReset()
        updateMailShare.mockReset()
        updateMailShareBindings.mockReset()
        resetMailShareAuthKey.mockReset()
        accountList.mockReset()
        confirm.mockReset()
        message.mockReset()
        updateMailShare.mockImplementation(async () => sampleDetail())
        accountList.mockResolvedValue([{ accountId: 12, email: 'ops@example.com', sort: 5 }])
        confirm.mockResolvedValue('confirm')
    })

    it.each(['EXPIRED', 'REVOKED'])('keeps %s readable but never writable (S1)', async (effectiveStatus) => {
        getMailShare.mockResolvedValue(sampleDetail({ effectiveStatus, status: effectiveStatus }))
        const wrapper = await openDrawer()

        expect(wrapper.find('[data-test="detail-readonly"]').exists()).toBe(true)
        WRITE_HOOKS.forEach((hook) => {
            expect(wrapper.get(`[data-test="${hook}"]`).attributes('disabled')).toBeDefined()
        })
        expect(wrapper.findAll('[data-test="binding-remove"]')[0].attributes('disabled')).toBeDefined()

        await wrapper.get('[data-test="config-save"]').trigger('click')
        await wrapper.get('[data-test="authkey-enable"]').trigger('click')
        await wrapper.findAll('[data-test="binding-remove"]')[0].trigger('click')
        await flushPromises()

        expect(updateMailShare).not.toHaveBeenCalled()
        expect(updateMailShareBindings).not.toHaveBeenCalled()
        expect(resetMailShareAuthKey).not.toHaveBeenCalled()
        // Read side survives: the owner still audits a dead share.
        expect(wrapper.get('[data-test="binding-row"]').text()).toContain('otp@example.com')
        expect(wrapper.get('[data-test="detail-quota"]').text()).toContain('2')
    })

    it('leaves ACCESS_LIMIT_REACHED fully writable: that is when the quota needs raising (S2)', async () => {
        getMailShare.mockResolvedValue(sampleDetail({ effectiveStatus: 'ACCESS_LIMIT_REACHED' }))
        const wrapper = await openDrawer()

        expect(wrapper.find('[data-test="detail-readonly"]').exists()).toBe(false)
        WRITE_HOOKS.forEach((hook) => {
            expect(wrapper.get(`[data-test="${hook}"]`).attributes('disabled')).toBeUndefined()
        })

        await setMaxSessions(wrapper, 20)
        await wrapper.get('[data-test="config-save"]').trigger('click')
        await flushPromises()

        expect(updateMailShare).toHaveBeenCalledTimes(1)
        expect(saveBody()).toEqual({ shareId: 7, maxSessions: 20 })
    })
})

describe('share detail drawer · mask toggle copy (AC-MAIL-08 / Decision 14)', () => {
    beforeEach(() => {
        getMailShare.mockReset()
        updateMailShare.mockReset()
        accountList.mockReset()
        confirm.mockReset()
        message.mockReset()
        getMailShare.mockResolvedValue(sampleDetail())
        updateMailShare.mockImplementation(async () => sampleDetail())
        accountList.mockResolvedValue([])
    })

    it('labels the mask switch as a display option and never promises secrecy (M1)', async () => {
        const wrapper = await openDrawer()

        const label = wrapper.get('[data-test="mask-toggle-label"]').text()
        const hint = wrapper.get('[data-test="mask-toggle-hint"]').text()
        expect(label).toBeTruthy()
        expect(hint).toBeTruthy()
        // Decision 14: masking is a display preference, not a confidentiality boundary. The
        // word lists cover zh and en so the guard survives T-29 swapping in real translations.
        expect(label).not.toMatch(/保密|加密|安全|私密|secret|hidden|hide|private|privacy|secure|protect/i)
        expect(hint).not.toMatch(/保密|加密|私密|secret|encrypt|privacy|secure|protect/i)
    })

    it('saves the mask switch through the same dirty patch, not its own request (M2)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="mask-toggle"]').setValue(true)
        await wrapper.get('[data-test="config-save"]').trigger('click')
        await flushPromises()

        expect(updateMailShare).toHaveBeenCalledTimes(1)
        expect(saveBody()).toEqual({ shareId: 7, showFullAddress: true })
    })
})

describe('share detail drawer · stale response isolation (T21-P1-1)', () => {
    beforeEach(() => {
        getMailShare.mockReset()
        updateMailShare.mockReset()
        updateMailShareBindings.mockReset()
        resetMailShareAuthKey.mockReset()
        accountList.mockReset()
        confirm.mockReset()
        message.mockReset()
        accountList.mockResolvedValue([])
        confirm.mockResolvedValue('confirm')
    })

    it('drops a late detail for share A after the owner opened share B', async () => {
        const first = deferred()
        const second = deferred()
        getMailShare
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise)

        const wrapper = mountDrawer({ shareId: 7 })
        await wrapper.setProps({ shareId: 8 })

        first.resolve(sampleDetail({ shareId: 7, name: 'share A' }))
        await flushPromises()
        expect(wrapper.find('[data-test="detail-name"]').exists()).toBe(false)

        second.resolve(sampleDetail({ shareId: 8, name: 'share B' }))
        await flushPromises()
        expect(wrapper.get('[data-test="detail-name"]').text()).toBe('share B')
        expect(wrapper.text()).not.toContain('share A')
    })

    it('does not paint share A AuthKey onto share B after a late enable', async () => {
        getMailShare.mockImplementation(async (shareId) => sampleDetail({
            shareId,
            name: shareId === 8 ? 'share B' : 'share A'
        }))
        const enable = deferred()
        resetMailShareAuthKey.mockImplementationOnce(() => enable.promise)
        const wrapper = await openDrawer({ shareId: 7 })

        await wrapper.get('[data-test="authkey-enable"]').trigger('click')
        await wrapper.setProps({ shareId: 8 })
        await flushPromises()

        enable.resolve({ ...sampleDetail({ shareId: 7, authKeyEnabled: true }), authKey: AUTH_KEY })
        await flushPromises()

        expect(wrapper.get('[data-test="detail-name"]').text()).toBe('share B')
        expect(wrapper.find('[data-test="authkey-once"]').exists()).toBe(false)
        expect(plaintextTrace(wrapper).inputs).toHaveLength(0)
    })

    it('does not close share B when a late SHARE_NOT_FOUND for share A arrives', async () => {
        const first = deferred()
        const second = deferred()
        getMailShare
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise)

        const wrapper = mountDrawer({ shareId: 7 })
        await wrapper.setProps({ shareId: 8 })

        first.reject({ code: 404, message: 'SHARE_NOT_FOUND' })
        await flushPromises()
        second.resolve(sampleDetail({ shareId: 8, name: 'share B' }))
        await flushPromises()

        expect(wrapper.get('[data-test="detail-name"]').text()).toBe('share B')
        expect(wrapper.emitted('update:shareId')).toBeFalsy()
    })
})

describe('share detail drawer · source contract', () => {
    it('keeps the repo theming and chunk rules (jsdom cannot evaluate media queries)', async () => {
        const src = await readFile(
            path.join(process.cwd(), 'src/views/share-admin/ShareDetailDrawer.vue'),
            'utf8'
        )

        expect(src).toContain('@media (max-width: 767px)')
        expect(src).not.toContain('window.onresize')
        expect(src).toContain("shareShowFullAddress")
        // The visitor bundle is guarded by share-chunk.spec.js; importing it here would turn
        // that guard red as a build failure rather than as a readable assertion.
        expect(src).not.toMatch(/from '@\/views\/share\//)
        expect(src).not.toMatch(/from '@\/request\/share\.js'/)
        expect(src).not.toMatch(/useSharePolling/)

        const style = src.slice(src.indexOf('<style'))
        expect(style).toContain('lang="scss"')
        expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    })
})
