import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { expectSameInstant } from '@/test/utc-instant.js'
import en from '@/i18n/en.js'

const {
    getMailShare,
    updateMailShare,
    updateMailShareBindings,
    resetMailShareAuthKey,
    regenerateMailShare,
    revealMailShareSec,
    accountList,
    confirm,
    message
} = vi.hoisted(() => ({
    getMailShare: vi.fn(),
    updateMailShare: vi.fn(),
    updateMailShareBindings: vi.fn(),
    resetMailShareAuthKey: vi.fn(),
    regenerateMailShare: vi.fn(),
    revealMailShareSec: vi.fn(),
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
        resetMailShareAuthKey,
        regenerateMailShare,
        revealMailShareSec
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

// day.js 在模块作用域就 `const settingStore = useSettingStore()`，import 期即需要活跃的 Pinia。
// 本抽屉自己不碰 settingStore，只有 day.js 读 lang，桩到 lang 即可，不动共享的 day.js。
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

import { tzText } from '@/utils/day.js'
import ShareDetailDrawer from './ShareDetailDrawer.vue'

const AUTH_KEY = 'Ab3dEf0123456789_-xyQ'
const NEW_SEC = 'sEc0123456789abcdefGHI'
const NEW_LID = 'lid-rotated'
const NEW_SHARE_URL = `https://mail.example.com/s/${NEW_LID}#${NEW_SEC}`
// The link as it was handed out at creation time -- what revealSec gives back, verbatim.
const ORIGINAL_SEC = 'origSec9876543210zyxwVU'
const ORIGINAL_SHARE_URL = `https://mail.example.com/s/lid-7#${ORIGINAL_SEC}`

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
    // The raw option value travels, not Number(...): the renewal select carries the 'keep' and
    // 'custom' sentinels beside the numeric rungs, and coercing here would turn both into NaN.
    // The account picker still works because submitAdd does its own Number() on the way out.
    'el-select': {
        props: ['modelValue', 'disabled'],
        emits: ['update:modelValue'],
        template: '<select :value="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.value)"><slot /></select>'
    },
    'el-option': {
        props: ['label', 'value'],
        template: '<option :value="value">{{ label }}</option>'
    },
    'el-date-picker': {
        props: ['modelValue', 'disabled', 'type', 'valueFormat'],
        emits: ['update:modelValue'],
        template: '<input type="text" :value="modelValue" :disabled="disabled" @input="$emit(\'update:modelValue\', $event.target.value)" />'
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
        // Far future on purpose: the drawer now reads liveEffectiveStatus, so a detail meant
        // to be writable must actually be unexpired; the live-expiry case supplies its own past.
        expiresAt: '2099-08-18 01:00:00',
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

// The rotated link carries the sec in its fragment, so the same "one readonly input, never
// rendered as text" rule the AuthKey lives under applies to the whole URL.
function linkTrace(wrapper) {
    return {
        inputs: wrapper.findAll('input').filter((node) => String(node.element.value || '').includes(NEW_SEC)),
        inText: wrapper.text().includes(NEW_SEC)
    }
}

// Same rule as linkTrace, for the link handed back by revealSec.
function revealTrace(wrapper) {
    return {
        inputs: wrapper.findAll('input').filter((node) => String(node.element.value || '').includes(ORIGINAL_SEC)),
        inText: wrapper.text().includes(ORIGINAL_SEC)
    }
}

// firstCreateResponse: regenerate answers with the create shape, not a detail. It has no
// name / effectiveStatus / authKeyEnabled, so feeding it into the drawer's detail would blank
// the header -- the drawer has to re-read instead.
function regenerateResponse(overrides = {}) {
    return {
        shareId: 7,
        lid: NEW_LID,
        sec: NEW_SEC,
        expiresAt: '2026-08-18 01:00:00',
        shareUrl: NEW_SHARE_URL,
        shareType: 'single',
        bindings: [{ bindingId: 91, accountId: 11 }],
        ...overrides
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

    // 详情页与列表页读同一批裸串，转换口径必须一致，否则同一条分享在两处显示不同时刻。
    it('renders created / expiry / last access in the browser timezone (WA-TZ)', async () => {
        const wrapper = await openDrawer()

        expectSameInstant(wrapper.get('[data-test="detail-created"]').text(), '2026-08-17 01:00:00')
        expectSameInstant(wrapper.get('[data-test="detail-expires"]').text(), '2099-08-18 01:00:00')
        expectSameInstant(wrapper.get('[data-test="detail-last-access"]').text(), '2026-08-17 02:00:00')
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

// 交付契约:管理员看到一条分享快到期，能当场把它延长，链接不变、在看的访客不掉线。
// 抽屉里的到期时刻一律是「本机墙上时钟」，与上面三个只读字段同一口径；请求要的是 UTC 裸串。
// 这一组的样本时刻写死在 2026-08 中旬，所以把系统时间也钉住 —— 否则真实时间一过
// 2026-08-18，样本分享就恒在过去，「新时刻必须在未来」这条会把每条用例都判红。
// expiresAt 在此显式覆盖回 2026-08-18：续期的每个断言都从这个已存时刻起算。
describe('share detail drawer · renewal (review-t22b P0-1)', () => {
    const NOW = '2026-08-17T12:00:00Z'
    const SAVED_EXPIRY = { expiresAt: '2026-08-18 01:00:00' }
    // createTime 2026-08-17 01:00:00Z。后端上限判据是「新 expires_at − create_time ≤ 90 天」，
    // 基准是创建时刻。
    const CEILING_UTC = '2026-11-15 01:00:00'

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date(NOW))
        getMailShare.mockReset()
        updateMailShare.mockReset()
        updateMailShareBindings.mockReset()
        resetMailShareAuthKey.mockReset()
        accountList.mockReset()
        confirm.mockReset()
        message.mockReset()
        getMailShare.mockResolvedValue(sampleDetail(SAVED_EXPIRY))
        updateMailShare.mockImplementation(async () => sampleDetail(SAVED_EXPIRY))
        accountList.mockResolvedValue([])
        confirm.mockResolvedValue('confirm')
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('extends by a preset rung and sends the new instant as a UTC bare string (R1)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="renew-choice"]').setValue('86400')
        await wrapper.get('[data-test="config-save"]').trigger('click')
        await flushPromises()

        expect(updateMailShare).toHaveBeenCalledTimes(1)
        // 24h past 2026-08-18 01:00:00Z. Sending the browser's wall clock instead would land
        // eight hours off on this machine, and the visitor countdown reads this very column.
        expect(saveBody()).toEqual({ shareId: 7, expiresAt: '2026-08-19 01:00:00' })
    })

    // 这条与 R1 是一对:R1 保证改了会发,这条保证没改绝不发。assertUpdatePatch 对「键存在
    // 且非 null」敏感而非「值变了」,全量回发会让改个名字都被 SHARE_INVALID_CONFIG 拒掉。
    it('keeps expiresAt out of the patch when the owner never touched it (R2)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="config-name"]').setValue('lobby desk')
        await wrapper.get('[data-test="config-save"]').trigger('click')
        await flushPromises()

        expect(saveBody()).toEqual({ shareId: 7, name: 'lobby desk' })
        expect(saveBody()).not.toHaveProperty('expiresAt')
    })

    it('drops the renewal again when the owner picks a rung and then goes back to keep (R3)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="renew-choice"]').setValue('86400')
        await wrapper.get('[data-test="renew-choice"]').setValue('keep')
        await wrapper.get('[data-test="config-save"]').trigger('click')
        await flushPromises()

        expect(updateMailShare).not.toHaveBeenCalled()
    })

    it('shows how far the share can still be extended, so the owner does not guess (R4)', async () => {
        const wrapper = await openDrawer()

        expect(wrapper.get('[data-test="renew-ceiling"]').text()).toContain(tzText(CEILING_UTC))
    })

    it('stops a renewal past the ceiling in the browser instead of posting it (R5)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="renew-choice"]').setValue('custom')
        await wrapper.get('[data-test="renew-exact"]').setValue(tzText('2026-11-16 01:00:00'))
        await wrapper.get('[data-test="config-save"]').trigger('click')
        await flushPromises()

        expect(updateMailShare).not.toHaveBeenCalled()
        const text = wrapper.get('[data-test="config-error"]').text()
        expect(text).toBeTruthy()
        expect(text).toContain('90')
    })

    it('stops a shortening that lands in the past: EXPIRED rows cannot be edited back (R6)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="renew-choice"]').setValue('custom')
        await wrapper.get('[data-test="renew-exact"]').setValue(tzText('2026-08-17 00:00:00'))
        await wrapper.get('[data-test="config-save"]').trigger('click')
        await flushPromises()

        expect(updateMailShare).not.toHaveBeenCalled()
        const text = wrapper.get('[data-test="config-error"]').text()
        expect(text).toBeTruthy()
        expect(text).not.toContain('90')
    })

    it('allows shortening to a still-future instant (R7)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="renew-choice"]').setValue('custom')
        await wrapper.get('[data-test="renew-exact"]').setValue(tzText('2026-08-17 18:00:00'))
        await wrapper.get('[data-test="config-save"]').trigger('click')
        await flushPromises()

        expect(saveBody()).toEqual({ shareId: 7, expiresAt: '2026-08-17 18:00:00' })
    })

    // 本项目刚修过一批「点了没反应」的缺陷:部署把上限配得比前端镜像更低时,浏览器放行、
    // 服务端拒绝,这条码必须上屏,而不是只落进 console。
    it('puts a server-side duration refusal on screen (R8)', async () => {
        updateMailShare.mockRejectedValue({ code: 500, message: 'SHARE_DURATION_EXCEEDED' })
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="renew-choice"]').setValue('86400')
        await wrapper.get('[data-test="config-save"]').trigger('click')
        await flushPromises()

        expect(wrapper.get('[data-test="config-error"]').text()).toBe(en.shareDurationServerRejected)
    })

    // The CAS guard on the renewal UPDATE emits this when the row moved between the read and
    // the write. Re-reading is the owner's action, so the message has to say so rather than
    // invite a blind retry.
    it('tells the owner to reload when the row changed under them (R9)', async () => {
        updateMailShare.mockRejectedValue({ code: 500, message: 'SHARE_UPDATE_CONFLICT' })
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="renew-choice"]').setValue('86400')
        await wrapper.get('[data-test="config-save"]').trigger('click')
        await flushPromises()

        expect(wrapper.get('[data-test="config-error"]').text()).toBe(en.shareUpdateConflict)
    })

    // Without a fallback branch a newly added error code silently does nothing, which the owner
    // cannot tell apart from a dead Save button. This asserts the branch exists at all, so the
    // next code added server-side cannot regress into silence.
    it('never leaves a business refusal off the screen, whatever the code (R10)', async () => {
        updateMailShare.mockRejectedValue({ code: 500, message: 'SHARE_SOME_FUTURE_CODE' })
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="config-name"]').setValue('lobby desk')
        await wrapper.get('[data-test="config-save"]').trigger('click')
        await flushPromises()

        expect(wrapper.get('[data-test="config-error"]').text()).toBe(en.shareUpdateFailed)
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
        resetMailShareAuthKey.mockRejectedValue({ code: 500, message: 'SHARE_CAPABILITY_NOT_ENABLED' })
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="authkey-enable"]').trigger('click')
        await flushPromises()

        expect(wrapper.find('[data-test="authkey-error"]').exists()).toBe(true)
        expect(wrapper.find('[data-test="authkey-once"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="authkey-enable"]').exists()).toBe(true)
        expect(wrapper.find('[data-test="authkey-reset"]').exists()).toBe(false)
    })

    // 交付契约成功状态②:被拒时管理员要能从提示分辨「能力尚未开放」与「自己写错了」,
    // 不必翻日志或找开发。栅栏拆出独立错误码前,这两种都显示同一句「可能…或…」。
    it('names the capability as the reason when the fence refuses enable', async () => {
        resetMailShareAuthKey.mockRejectedValue({ code: 500, message: 'SHARE_CAPABILITY_NOT_ENABLED' })
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="authkey-enable"]').trigger('click')
        await flushPromises()

        const text = wrapper.get('[data-test="authkey-error"]').text()
        expect(text).toBe(en.shareCapabilityNotEnabled)
        expect(text).not.toBe(en.shareAuthKeyFailed)
    })

    it('does not blame the capability when the refusal is a state change', async () => {
        resetMailShareAuthKey.mockRejectedValue({ code: 500, message: 'SHARE_INVALID_CONFIG' })
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="authkey-enable"]').trigger('click')
        await flushPromises()

        const text = wrapper.get('[data-test="authkey-error"]').text()
        expect(text).toBe(en.shareAuthKeyFailed)
        expect(text).not.toBe(en.shareCapabilityNotEnabled)
    })
})

// 交付契约:管理员发现链接可能外泄、或者自己弄丢了,能在管理台当场换一条新链接继续用 ——
// 有效期、可见邮件范围、各项配置全部原样保留;而且他在点下去之前就清楚知道旧链接会立刻作废。
describe('share detail drawer · link rotation (AC-LIFE-05 / AC-SHARE-13)', () => {
    beforeEach(() => {
        getMailShare.mockReset()
        updateMailShare.mockReset()
        updateMailShareBindings.mockReset()
        resetMailShareAuthKey.mockReset()
        regenerateMailShare.mockReset()
        accountList.mockReset()
        confirm.mockReset()
        message.mockReset()
        getMailShare.mockResolvedValue(sampleDetail())
        updateMailShare.mockImplementation(async () => sampleDetail())
        regenerateMailShare.mockResolvedValue(regenerateResponse())
        accountList.mockResolvedValue([])
        confirm.mockResolvedValue('confirm')
    })

    it('rotates the link after a confirm and shows the new one exactly once (L1)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="link-regenerate"]').trigger('click')
        await flushPromises()

        expect(confirm).toHaveBeenCalledTimes(1)
        expect(regenerateMailShare).toHaveBeenCalledTimes(1)
        expect(regenerateMailShare).toHaveBeenCalledWith(7)
        expect(wrapper.get('[data-test="link-url"]').element.value).toBe(NEW_SHARE_URL)
        expect(wrapper.get('[data-test="link-copy"]').exists()).toBe(true)
        expect(wrapper.emitted('changed')).toBeTruthy()
    })

    // 「踢掉在途访客」是用户可见的副作用,确认文案必须说出来 —— 只问「确定要重新生成吗」
    // 等于让管理员在不知道会断线的情况下按下去。
    it('spells out that open visits are cut off, not just "are you sure" (L2 copy)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="link-regenerate"]').trigger('click')
        await flushPromises()

        const copy = confirm.mock.calls[0][0]
        expect(copy).toBe(en.shareLinkRegenerateConfirm)
        // The two consequences the owner cannot discover afterwards: the old link dies, and
        // whoever is reading right now is disconnected.
        expect(copy).toMatch(/old link|previous link/i)
        expect(copy).toMatch(/disconnect|cut off|stop working|signed out/i)
    })

    it('sends nothing when the confirm is dismissed (L3)', async () => {
        confirm.mockRejectedValue('cancel')
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="link-regenerate"]').trigger('click')
        await flushPromises()

        expect(confirm).toHaveBeenCalledTimes(1)
        expect(regenerateMailShare).not.toHaveBeenCalled()
        expect(wrapper.find('[data-test="link-once"]').exists()).toBe(false)
    })

    // regenerate 回的是 create 形状(没有 name / effectiveStatus),直接灌进详情会把表头清空。
    it('re-reads the detail instead of painting the create-shaped response into it (L4)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="link-regenerate"]').trigger('click')
        await flushPromises()

        expect(getMailShare).toHaveBeenCalledTimes(2)
        expect(wrapper.get('[data-test="detail-name"]').text()).toBe('front desk')
        // 有效期原样保留:换链接不是续期,详情里的时刻不该动。
        expectSameInstant(wrapper.get('[data-test="detail-expires"]').text(), '2099-08-18 01:00:00')
        expect(wrapper.get('[data-test="detail-status"]').attributes('data-status')).toBe('ACTIVE')
    })

    it('keeps the new secret in one readonly input and drops it on acknowledge (L5)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="link-regenerate"]').trigger('click')
        await flushPromises()

        // 明文只此一次:详情接口永不再返回它,所以它不进 storage、不进 pinia、不进 URL,
        // 只活在一个组件内的 ref 里。
        const survived = linkTrace(wrapper)
        expect(survived.inputs).toHaveLength(1)
        expect(survived.inputs[0].attributes('data-test')).toBe('link-url')
        expect(survived.inText).toBe(false)
        const stored = { ...localStorage, ...sessionStorage }
        expect(JSON.stringify(stored)).not.toContain(NEW_SEC)
        expect(window.location.href).not.toContain(NEW_SEC)

        await wrapper.get('[data-test="link-ack"]').trigger('click')
        expect(wrapper.find('[data-test="link-once"]').exists()).toBe(false)
        expect(linkTrace(wrapper).inputs).toHaveLength(0)
    })

    it('copies the new link through the shared fallback helper (L6)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="link-regenerate"]').trigger('click')
        await flushPromises()

        message.mockClear()
        await wrapper.get('[data-test="link-copy"]').trigger('click')
        await flushPromises()

        expect(message).toHaveBeenCalledTimes(1)
    })

    it('names the capability when the fence refuses the rotation (L7)', async () => {
        regenerateMailShare.mockRejectedValue({ code: 500, message: 'SHARE_CAPABILITY_NOT_ENABLED' })
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="link-regenerate"]').trigger('click')
        await flushPromises()

        expect(wrapper.get('[data-test="link-error"]').text()).toBe(en.shareCapabilityNotEnabled)
        expect(wrapper.find('[data-test="link-once"]').exists()).toBe(false)
    })

    // 与 R10 同一条思路:没有兜底分支时,服务端新加的错误码在界面上什么都不会发生,
    // 管理员分辨不出「被拒了」和「按钮是死的」。本轮这个缺陷已在三处出现过。
    it('never leaves a business refusal off the screen, whatever the code (L8)', async () => {
        regenerateMailShare.mockRejectedValue({ code: 500, message: 'SHARE_SOME_FUTURE_CODE' })
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="link-regenerate"]').trigger('click')
        await flushPromises()

        expect(wrapper.get('[data-test="link-error"]').text()).toBe(en.shareLinkRegenerateFailed)
    })

    it('closes and refreshes the list when the share vanished mid-rotation (L9)', async () => {
        regenerateMailShare.mockRejectedValue({ code: 500, message: 'SHARE_NOT_FOUND' })
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="link-regenerate"]').trigger('click')
        await flushPromises()

        expect(wrapper.emitted('update:shareId')).toEqual([[0]])
        expect(wrapper.find('[data-test="link-once"]').exists()).toBe(false)
    })

    it('does not paint share A new link onto share B after a late rotation (L10)', async () => {
        getMailShare.mockImplementation(async (shareId) => sampleDetail({
            shareId,
            name: shareId === 8 ? 'share B' : 'share A'
        }))
        const rotate = deferred()
        regenerateMailShare.mockImplementationOnce(() => rotate.promise)
        const wrapper = await openDrawer({ shareId: 7 })

        await wrapper.get('[data-test="link-regenerate"]').trigger('click')
        await wrapper.setProps({ shareId: 8 })
        await flushPromises()

        rotate.resolve(regenerateResponse({ shareId: 7 }))
        await flushPromises()

        expect(wrapper.get('[data-test="detail-name"]').text()).toBe('share B')
        expect(wrapper.find('[data-test="link-once"]').exists()).toBe(false)
        expect(linkTrace(wrapper).inputs).toHaveLength(0)
    })
})

// 轨一的读取端(ADR-share-credential-recoverability):管理员点开任意一条分享的详情,
// 都能知道「这条链接现在还能不能拿回来」—— 能就当场拿回并复制,不能就看到一句说清
// 原因、并告诉他下一步该干什么的话。「上线前建的可以重新生成」与「服务配置异常要找
// 管理员」是两件不同的事,后端花了一整包把它们分开,前端折成一句就等于白做。
describe('share detail drawer · link reveal (ADR track 1)', () => {
    beforeEach(() => {
        getMailShare.mockReset()
        updateMailShare.mockReset()
        updateMailShareBindings.mockReset()
        resetMailShareAuthKey.mockReset()
        regenerateMailShare.mockReset()
        revealMailShareSec.mockReset()
        accountList.mockReset()
        confirm.mockReset()
        message.mockReset()
        getMailShare.mockResolvedValue(sampleDetail())
        updateMailShare.mockImplementation(async () => sampleDetail())
        regenerateMailShare.mockResolvedValue(regenerateResponse())
        revealMailShareSec.mockResolvedValue({ shareId: 7, lid: 'lid-7', shareUrl: ORIGINAL_SHARE_URL })
        accountList.mockResolvedValue([])
        confirm.mockResolvedValue('confirm')
    })

    it('hands back the link that was issued at creation, ready to copy (V1)', async () => {
        const wrapper = await openDrawer()

        expect(wrapper.find('[data-test="link-reveal-url"]').exists()).toBe(false)
        await wrapper.get('[data-test="link-reveal"]').trigger('click')
        await flushPromises()

        expect(revealMailShareSec).toHaveBeenCalledTimes(1)
        expect(revealMailShareSec).toHaveBeenCalledWith(7)
        // 逐字相同:后端 shareUrlOf 是 create / regenerate / reveal 的唯一拼装点,前端不得
        // 自己再拼一遍,否则交回的是一条看不出坏在哪的链接。
        expect(wrapper.get('[data-test="link-reveal-url"]').element.value).toBe(ORIGINAL_SHARE_URL)
        expect(wrapper.find('[data-test="link-reveal-copy"]').exists()).toBe(true)
        expect(wrapper.find('[data-test="link-reveal-error"]').exists()).toBe(false)
    })

    it('copies the revealed link through the shared fallback helper (V2)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="link-reveal"]').trigger('click')
        await flushPromises()
        message.mockClear()
        await wrapper.get('[data-test="link-reveal-copy"]').trigger('click')
        await flushPromises()

        expect(message).toHaveBeenCalledTimes(1)
    })

    // 四个码 = 四种不同的管理员动作。前两个「你可以自助解决」(重新生成一条),后两个
    // 「系统有问题」(找管理员/运维)。折叠成一句「获取失败」就把这个判断推回给了他。
    const FAILURES = [
        ['SHARE_SEC_ABSENT', 'shareSecAbsent'],
        ['SHARE_SEC_UNAVAILABLE', 'shareSecUnavailable'],
        ['SHARE_SEC_KEY_RETIRED', 'shareSecKeyRetired'],
        ['SHARE_SEC_CORRUPTED', 'shareSecCorrupted']
    ]

    it.each(FAILURES)('says what %s means and what to do next (V3)', async (code, key) => {
        revealMailShareSec.mockRejectedValue({ code: 500, message: code })
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="link-reveal"]').trigger('click')
        await flushPromises()

        expect(wrapper.get('[data-test="link-reveal-error"]').text()).toBe(en[key])
        expect(wrapper.find('[data-test="link-reveal-url"]').exists()).toBe(false)
    })

    // 逐条断言还不够:四条都渲染出来但文案相同,上面四个用例照样全绿。
    it('gives the four codes four different answers, not one "failed" (V4)', async () => {
        const texts = []
        for (const [code] of FAILURES) {
            revealMailShareSec.mockRejectedValue({ code: 500, message: code })
            const wrapper = await openDrawer()
            await wrapper.get('[data-test="link-reveal"]').trigger('click')
            await flushPromises()
            texts.push(wrapper.get('[data-test="link-reveal-error"]').text())
        }

        expect(new Set(texts).size).toBe(4)
        // 自助 vs 找人:前两个码告诉他自己能解决,后两个明确说不是他的操作问题。
        expect(texts[0]).toMatch(/重新生成|regenerate/i)
        expect(texts[2]).toMatch(/重新生成|regenerate/i)
        expect(texts[1]).toMatch(/管理员|运维|administrator|operator/i)
        expect(texts[3]).toMatch(/管理员|运维|administrator|operator/i)
    })

    // 与 R10 / L8 同一条思路:没有兜底分支时,服务端新加的码在界面上什么都不会发生,
    // 管理员分辨不出「被拒了」和「按钮是死的」。本轮这个缺陷已在三处出现过。
    it('never leaves a business refusal off the screen, whatever the code (V5)', async () => {
        revealMailShareSec.mockRejectedValue({ code: 500, message: 'SHARE_SOME_FUTURE_CODE' })
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="link-reveal"]').trigger('click')
        await flushPromises()

        expect(wrapper.get('[data-test="link-reveal-error"]').text()).toBe(en.shareLinkRevealFailed)
    })

    it('keeps the revealed link in one readonly input and drops it on acknowledge (V6)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="link-reveal"]').trigger('click')
        await flushPromises()

        const survived = revealTrace(wrapper)
        expect(survived.inputs).toHaveLength(1)
        expect(survived.inputs[0].attributes('data-test')).toBe('link-reveal-url')
        expect(survived.inText).toBe(false)
        // 取回的明文和新铸的一样,不进 storage、不进 pinia、不进 URL —— 只活在组件内的 ref 里。
        const stored = { ...localStorage, ...sessionStorage }
        expect(JSON.stringify(stored)).not.toContain(ORIGINAL_SEC)
        expect(window.location.href).not.toContain(ORIGINAL_SEC)

        await wrapper.get('[data-test="link-reveal-hide"]').trigger('click')
        expect(wrapper.find('[data-test="link-reveal-url"]').exists()).toBe(false)
        expect(revealTrace(wrapper).inputs).toHaveLength(0)
    })

    // 后端刻意不给这条路加状态门:非 ACTIVE 行的链接在访客侧恒被拒,而管理员恰恰要在
    // 这些行上排查「当初发出去的是哪条」。用 writable 禁掉入口就把这一半砍没了。
    it.each(['EXPIRED', 'REVOKED'])('still reveals a %s share: viewing is not using (V7)', async (effectiveStatus) => {
        getMailShare.mockResolvedValue(sampleDetail({ effectiveStatus, status: effectiveStatus }))
        const wrapper = await openDrawer()

        expect(wrapper.get('[data-test="link-reveal"]').attributes('disabled')).toBeUndefined()
        await wrapper.get('[data-test="link-reveal"]').trigger('click')
        await flushPromises()

        expect(revealMailShareSec).toHaveBeenCalledWith(7)
        expect(wrapper.get('[data-test="link-reveal-url"]').element.value).toBe(ORIGINAL_SHARE_URL)
        // 换链接仍然不行:那是写,会在一条死行上原地复活凭据。
        expect(wrapper.get('[data-test="link-regenerate"]').attributes('disabled')).toBeDefined()
    })

    // 两个入口同屏。同时挂两条链接,管理员没有任何办法看出哪条是现在有效的那条。
    it('shows the rotated link alone after a regenerate that follows a reveal (V8)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="link-reveal"]').trigger('click')
        await flushPromises()
        expect(wrapper.find('[data-test="link-reveal-url"]').exists()).toBe(true)

        await wrapper.get('[data-test="link-regenerate"]').trigger('click')
        await flushPromises()

        expect(wrapper.get('[data-test="link-url"]').element.value).toBe(NEW_SHARE_URL)
        // 旧链接刚被这次轮换作废,继续挂着就是一条会被复制出去的死链接。
        expect(wrapper.find('[data-test="link-reveal-url"]').exists()).toBe(false)
        expect(revealTrace(wrapper).inputs).toHaveLength(0)
    })

    it('shows the revealed link alone after a reveal that follows a regenerate (V9)', async () => {
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="link-regenerate"]').trigger('click')
        await flushPromises()
        expect(wrapper.find('[data-test="link-url"]').exists()).toBe(true)

        revealMailShareSec.mockResolvedValue({ shareId: 7, lid: NEW_LID, shareUrl: ORIGINAL_SHARE_URL })
        await wrapper.get('[data-test="link-reveal"]').trigger('click')
        await flushPromises()

        expect(wrapper.get('[data-test="link-reveal-url"]').element.value).toBe(ORIGINAL_SHARE_URL)
        // 「只显示这一次」的那块必须让位:两块同屏时它已经不是仅有的一次了。
        expect(wrapper.find('[data-test="link-url"]').exists()).toBe(false)
    })

    it('clears a stale reveal error once the next attempt succeeds (V10)', async () => {
        revealMailShareSec.mockRejectedValueOnce({ code: 500, message: 'SHARE_SEC_CORRUPTED' })
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="link-reveal"]').trigger('click')
        await flushPromises()
        expect(wrapper.get('[data-test="link-reveal-error"]').text()).toBe(en.shareSecCorrupted)

        await wrapper.get('[data-test="link-reveal"]').trigger('click')
        await flushPromises()

        expect(wrapper.find('[data-test="link-reveal-error"]').exists()).toBe(false)
        expect(wrapper.get('[data-test="link-reveal-url"]').element.value).toBe(ORIGINAL_SHARE_URL)
    })

    it('does not paint share A revealed link onto share B after a late reveal (V11)', async () => {
        getMailShare.mockImplementation(async (shareId) => sampleDetail({
            shareId,
            name: shareId === 8 ? 'share B' : 'share A'
        }))
        const pending = deferred()
        revealMailShareSec.mockImplementationOnce(() => pending.promise)
        const wrapper = await openDrawer({ shareId: 7 })

        await wrapper.get('[data-test="link-reveal"]').trigger('click')
        await wrapper.setProps({ shareId: 8 })
        await flushPromises()

        pending.resolve({ shareId: 7, lid: 'lid-7', shareUrl: ORIGINAL_SHARE_URL })
        await flushPromises()

        expect(wrapper.get('[data-test="detail-name"]').text()).toBe('share B')
        expect(wrapper.find('[data-test="link-reveal-url"]').exists()).toBe(false)
        expect(revealTrace(wrapper).inputs).toHaveLength(0)
    })

    it('closes and refreshes the list when the share vanished before the reveal (V12)', async () => {
        revealMailShareSec.mockRejectedValue({ code: 500, message: 'SHARE_NOT_FOUND' })
        const wrapper = await openDrawer()

        await wrapper.get('[data-test="link-reveal"]').trigger('click')
        await flushPromises()

        expect(wrapper.emitted('update:shareId')).toEqual([[0]])
        expect(wrapper.find('[data-test="link-reveal-url"]').exists()).toBe(false)
    })

    // 面板顶部那句话是管理员在点任何按钮之前读到的唯一说明。轨一落地后「已有链接
    // 无法再次查看」变成了假话,留着它会让他压根不去点「查看链接」。
    it('no longer tells the owner the existing link can never be seen again (V13)', async () => {
        const wrapper = await openDrawer()

        const hint = wrapper.get('[data-test="link-hint"]').text()
        expect(hint).not.toMatch(/cannot be shown again|never stored|无法再次查看/i)
        expect(hint).toMatch(/regenerate|重新生成/i)
    })
})

describe('share detail drawer · write predicate (AC-ADMIN-04 / AC-ADMIN-09)', () => {
    const WRITE_HOOKS = [
        'config-save',
        'binding-add',
        'binding-add-select',
        'config-name',
        'authkey-enable',
        'renew-choice',
        'link-regenerate'
    ]

    beforeEach(() => {
        getMailShare.mockReset()
        updateMailShare.mockReset()
        updateMailShareBindings.mockReset()
        resetMailShareAuthKey.mockReset()
        regenerateMailShare.mockReset()
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
        await wrapper.get('[data-test="link-regenerate"]').trigger('click')
        await wrapper.findAll('[data-test="binding-remove"]')[0].trigger('click')
        await flushPromises()

        expect(updateMailShare).not.toHaveBeenCalled()
        expect(updateMailShareBindings).not.toHaveBeenCalled()
        expect(resetMailShareAuthKey).not.toHaveBeenCalled()
        // EXPIRED / REVOKED 的凭据不得原地复活:后端也会拒,但入口本身就不该可用。
        expect(regenerateMailShare).not.toHaveBeenCalled()
        // Read side survives: the owner still audits a dead share.
        expect(wrapper.get('[data-test="binding-row"]').text()).toContain('otp@example.com')
        expect(wrapper.get('[data-test="detail-quota"]').text()).toContain('2')
    })

    // P1: the badge follows liveEffectiveStatus; the write predicate stays on the
    // server snapshot (AC-LIFE-08: 前端不得回写). A stale ACTIVE row whose clock
    // has passed still looks EXPIRED but remains writable until the next fetch.
    it('keeps writes on the server snapshot while the badge follows the live clock (P1 live)', async () => {
        getMailShare.mockResolvedValue(sampleDetail({
            status: 'ACTIVE',
            effectiveStatus: 'ACTIVE',
            expiresAt: '2020-01-01 00:00:00'
        }))
        const wrapper = await openDrawer()

        expect(wrapper.get('[data-test="detail-status"]').attributes('data-status')).toBe('EXPIRED')
        expect(wrapper.find('[data-test="detail-readonly"]').exists()).toBe(false)
        expect(wrapper.get('[data-test="config-save"]').attributes('disabled')).toBeUndefined()
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
