import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { useAccountStore } from '@/store/account.js'
import en from '@/i18n/en.js'

const { createMailShare, accountList, confirm, message, copySpy, copyOutcome, copyFactory } = vi.hoisted(() => {
    const copyOutcome = { value: { copied: true, path: 'clipboard' } }
    const copySpy = vi.fn(async (text) => ({ ...copyOutcome.value, text }))
    return {
        createMailShare: vi.fn(),
        accountList: vi.fn(),
        confirm: vi.fn(),
        message: vi.fn(),
        copySpy,
        copyOutcome,
        copyFactory: vi.fn()
    }
})

// importOriginal keeps newIdempotencyKey and isShareForbidden real. Stubbing the whole module
// would hand the wizard an undefined key generator and turn every same-key assertion green
// for the wrong reason (undefined === undefined).
vi.mock('@/request/mail-share.js', async (importOriginal) => {
    const actual = await importOriginal()
    return {
        ...actual,
        createMailShare
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

// A real shallowRef, not a plain object: the two one-shot inputs bind it as a template ref,
// and Vue refuses to populate a non-ref, which would hide a mis-bound selectableRef.
vi.mock('@/composables/useCopyWithFallback.js', async () => {
    const { shallowRef } = await import('vue')
    copyFactory.mockImplementation(() => ({
        copy: copySpy,
        selectableRef: shallowRef(null),
        fallbackActive: shallowRef(false),
        fallbackText: shallowRef('')
    }))
    return { useCopyWithFallback: copyFactory }
})

import { CREATE_BODY_KEYS, capabilityV2 } from './presets.js'
import ShareCreateWizard from './ShareCreateWizard.vue'

// A select stub that carries its model as JSON keeps one shape for both pickers: the duration
// single value and the mailbox array. Driving it through setValue avoids depending on
// <option> rendering, which the 51-mailbox case could not produce anyway.
const selectStub = {
    props: ['modelValue', 'multiple', 'disabled'],
    emits: ['update:modelValue'],
    template: `<div class="el-select-stub"
        :data-multiple="multiple ? '1' : '0'"
        :data-disabled="disabled ? '1' : '0'"
        :data-value="JSON.stringify(modelValue === undefined ? null : modelValue)">
        <input class="select-input"
            :disabled="disabled"
            :value="JSON.stringify(modelValue === undefined ? null : modelValue)"
            @input="$emit('update:modelValue', JSON.parse($event.target.value))" />
        <slot />
    </div>`
}

const stubs = {
    Icon: { template: '<i />' },
    'el-dialog': {
        props: ['modelValue', 'title', 'width'],
        emits: ['update:modelValue'],
        template: `<div class="el-dialog-stub" v-if="modelValue">
            <header>{{ title }}</header>
            <slot />
            <footer><slot name="footer" /></footer>
        </div>`
    },
    'el-button': {
        props: ['disabled', 'loading', 'type', 'text'],
        template: '<button type="button" :disabled="disabled" :data-loading="loading ? \'1\' : \'0\'"><slot /></button>'
    },
    'el-tag': { props: ['type'], template: '<span :data-tone="type"><slot /></span>' },
    'el-input': {
        props: ['modelValue', 'disabled'],
        emits: ['update:modelValue'],
        template: '<input :value="modelValue" :disabled="disabled" @input="$emit(\'update:modelValue\', $event.target.value)" />'
    },
    'el-input-number': {
        props: ['modelValue', 'min', 'step', 'controls', 'disabled'],
        emits: ['update:modelValue'],
        template: '<input type="number" :value="modelValue" :disabled="disabled" @input="$emit(\'update:modelValue\', $event.target.value === \'\' ? null : Number($event.target.value))" />'
    },
    'el-switch': {
        props: ['modelValue', 'disabled'],
        emits: ['update:modelValue'],
        template: '<input type="checkbox" :checked="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.checked)" />'
    },
    'el-select': selectStub,
    'el-option': { props: ['label', 'value'], template: '<span>{{ label }}</span>' },
    // Always rendered: jsdom cannot evaluate the real collapse animation, and hiding the
    // advanced block behind it would make every gated-field assertion untestable.
    'el-collapse': {
        props: ['modelValue'],
        emits: ['update:modelValue'],
        template: '<div class="el-collapse-stub"><slot /></div>'
    },
    'el-collapse-item': {
        props: ['name', 'title'],
        template: '<section><h4>{{ title }}</h4><slot /></section>'
    }
}

function accountRows(count, offset = 0) {
    return Array.from({ length: count }, (unused, index) => ({
        accountId: offset + index + 1,
        email: `box${offset + index + 1}@example.com`,
        sort: offset + index + 1
    }))
}

function firstSuccess(overrides = {}) {
    return {
        shareId: 7,
        lid: 'lid-7',
        sec: 'sec-7',
        shareUrl: 'https://mail.example.com/s/lid-7#sec-7',
        shareType: 'single',
        expiresAt: '2026-08-25 01:00:00',
        bindings: [{ bindingId: 1, accountId: 11 }],
        ...overrides
    }
}

function replayResponse(overrides = {}) {
    return {
        shareId: 7,
        lid: 'lid-7',
        shareType: 'single',
        expiresAt: '2026-08-25 01:00:00',
        bindings: [{ bindingId: 1, accountId: 11 }],
        idempotentReplay: true,
        ...overrides
    }
}

function transportFailure() {
    return { isAxiosError: true, code: 'ECONNABORTED', message: 'timeout of 0ms exceeded' }
}

function mountWizard(currentAccountId = 11) {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAccountStore().currentAccountId = currentAccountId
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
    return mount(ShareCreateWizard, {
        global: {
            plugins: [pinia, i18n],
            stubs
        }
    })
}

async function openWizard(currentAccountId = 11) {
    const wrapper = mountWizard(currentAccountId)
    await wrapper.get('[data-test="wizard-open"]').trigger('click')
    await flushPromises()
    return wrapper
}

async function submit(wrapper) {
    await wrapper.get('[data-test="wizard-submit"]').trigger('click')
    await flushPromises()
}

function lastBody() {
    const calls = createMailShare.mock.calls
    return calls[calls.length - 1][0]
}

function keyAt(index) {
    return createMailShare.mock.calls[index][1]
}

function selectValue(wrapper, hook) {
    return JSON.parse(wrapper.get(`[data-test="${hook}"]`).attributes('data-value'))
}

async function setSelect(wrapper, hook, value) {
    await wrapper.get(`[data-test="${hook}"] .select-input`).setValue(JSON.stringify(value))
}

describe('share-admin create wizard (AC-CAP-12 / AC-CAP-14 / AC-LIFE-11)', () => {
    beforeEach(() => {
        createMailShare.mockReset()
        accountList.mockReset()
        confirm.mockReset()
        message.mockReset()
        copySpy.mockClear()
        copyFactory.mockClear()
        copyOutcome.value = { copied: true, path: 'clipboard' }
        // The capability memory is module scoped on purpose (it must outlive one dialog), so
        // each case has to put it back to the pristine deployment state.
        capabilityV2.value = 'unknown'
        createMailShare.mockResolvedValue(firstSuccess())
        accountList.mockResolvedValue(accountRows(3, 10))
        confirm.mockResolvedValue('confirm')
    })

    // W1
    it('treats presets as prefill only and never leaks a preset id into the request (AC-CAP-12)', async () => {
        const wrapper = await openWizard()

        await wrapper.get('[data-test="preset-tempMailbox"]').trigger('click')
        expect(selectValue(wrapper, 'wizard-duration')).toBe(86400)
        expect(wrapper.get('[data-test="mask-toggle"]').element.checked).toBe(true)

        await wrapper.get('[data-test="preset-multiOtp"]').trigger('click')
        expect(selectValue(wrapper, 'wizard-duration')).toBe(21600)
        expect(wrapper.get('[data-test="mailbox-select"]').attributes('data-multiple')).toBe('1')
        expect(wrapper.get('[data-test="mask-toggle"]').element.checked).toBe(false)

        await wrapper.get('[data-test="preset-custom"]').trigger('click')
        expect(selectValue(wrapper, 'wizard-duration')).toBe(3600)

        await wrapper.get('[data-test="preset-singleOtp"]').trigger('click')
        expect(selectValue(wrapper, 'wizard-duration')).toBe(3600)
        expect(wrapper.get('[data-test="mailbox-select"]').attributes('data-multiple')).toBe('0')

        await submit(wrapper)

        const body = lastBody()
        expect(Object.keys(body).sort()).toEqual(
            Object.keys(body).filter((key) => CREATE_BODY_KEYS.includes(key)).sort()
        )
        expect(body).not.toHaveProperty('preset')
        expect(body).not.toHaveProperty('presetId')
        expect(body).not.toHaveProperty('presetKey')
    })

    // W2
    it('keeps the single-mailbox preset on the legacy-compatible defaults (AC-CAP-10)', async () => {
        const wrapper = await openWizard()
        await submit(wrapper)

        const body = lastBody()
        expect(body.accountIds).toEqual([11])
        expect(body.durationSeconds).toBe(3600)
        // legacyCompatibleBody only recognises a body whose new fields all sit on the DDL
        // defaults; any drift here silently costs the rolling-deploy fingerprint.
        expect(body.refreshIntervalMs).toBe(3000)
        expect(body.onlyMessagesAfterCreated).toBe(true)
        expect(body.otpExtractionEnabled).toBe(true)
        expect(body.autoRefresh).toBe(true)
        expect(body.showFullAddress).toBe(false)
        expect(body.authKeyEnabled).toBe(false)
        expect(body).not.toHaveProperty('maxSessions')
        expect(body).not.toHaveProperty('messageLimit')
        expect(body).not.toHaveProperty('accountId')
    })

    // W3
    it('sends an Idempotency-Key with every create (AC-CAP-09)', async () => {
        const wrapper = await openWizard()
        await submit(wrapper)

        expect(createMailShare).toHaveBeenCalledTimes(1)
        expect(typeof keyAt(0)).toBe('string')
        expect(keyAt(0).length).toBeGreaterThan(8)
    })

    // W4
    it('locks the form and retries with the same key after an unknown result (AC-CAP-14)', async () => {
        createMailShare.mockRejectedValueOnce(transportFailure())
        const wrapper = await openWizard()
        await submit(wrapper)

        expect(wrapper.find('[data-test="wizard-unknown"]').exists()).toBe(true)
        expect(wrapper.get('[data-test="wizard-name"]').attributes('disabled')).toBeDefined()
        expect(wrapper.get('[data-test="mailbox-select"]').attributes('data-disabled')).toBe('1')
        expect(wrapper.find('[data-test="wizard-submit"]').exists()).toBe(false)

        await wrapper.get('[data-test="wizard-retry"]').trigger('click')
        await flushPromises()

        expect(createMailShare).toHaveBeenCalledTimes(2)
        expect(keyAt(1)).toBe(keyAt(0))
    })

    // W5
    it('keeps the form editable on a business reject and only then rotates the key', async () => {
        createMailShare.mockRejectedValueOnce({ code: 500, message: 'SHARE_DURATION_EXCEEDED' })
        const wrapper = await openWizard()
        await submit(wrapper)

        expect(wrapper.find('[data-test="wizard-unknown"]').exists()).toBe(false)
        expect(wrapper.get('[data-test="wizard-name"]').attributes('disabled')).toBeUndefined()
        // A domain error is not the capability being off, and must not grey anything.
        expect(wrapper.find('[data-test="capability-inactive"]').exists()).toBe(false)

        await wrapper.get('[data-test="wizard-name"]').setValue('front desk')
        await submit(wrapper)

        expect(createMailShare).toHaveBeenCalledTimes(2)
        expect(keyAt(1)).not.toBe(keyAt(0))
    })

    // W6
    it('recognises an idempotent replay and issues no secret and no third request (AC-CAP-14)', async () => {
        createMailShare.mockRejectedValueOnce(transportFailure())
        createMailShare.mockResolvedValueOnce(replayResponse())
        const wrapper = await openWizard()
        await submit(wrapper)
        await wrapper.get('[data-test="wizard-retry"]').trigger('click')
        await flushPromises()

        expect(createMailShare).toHaveBeenCalledTimes(2)
        expect(wrapper.find('[data-test="share-url"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="secret-once"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="authkey-once"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="share-replay"]').exists()).toBe(true)
        expect(wrapper.find('[data-test="replay-guidance"]').exists()).toBe(true)
        expect(wrapper.get('[data-test="replay-share-id"]').text()).toContain('7')
        expect(wrapper.text()).not.toContain('sec-7')
    })

    // W7
    it('points a replay at revoke or delete instead of offering a fresh key (AC-CAP-14)', async () => {
        createMailShare.mockResolvedValueOnce(replayResponse())
        const wrapper = await openWizard()
        await submit(wrapper)

        expect(wrapper.find('[data-test="replay-guidance"]').exists()).toBe(true)
        expect(wrapper.find('[data-test="wizard-retry"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="replay-new-key"]').exists()).toBe(false)
        expect(createMailShare).toHaveBeenCalledTimes(1)
    })

    // W8
    it('greys all four gated groups after a real fence rejection (AC-LIFE-11)', async () => {
        createMailShare.mockRejectedValueOnce({ code: 500, message: 'SHARE_INVALID_CONFIG' })
        const wrapper = await openWizard()
        await wrapper.get('[data-test="preset-custom"]').trigger('click')
        await wrapper.get('[data-test="authkey-toggle"]').setValue(true)
        await submit(wrapper)

        expect(createMailShare.mock.calls[0][0].authKeyEnabled).toBe(true)
        expect(wrapper.find('[data-test="capability-inactive"]').exists()).toBe(true)
        expect(wrapper.get('[data-test="mailbox-select"]').attributes('data-multiple')).toBe('0')
        expect(wrapper.get('[data-test="authkey-toggle"]').attributes('disabled')).toBeDefined()
        expect(wrapper.get('[data-test="max-sessions"]').attributes('disabled')).toBeDefined()
        // messageLimit is the fourth gate assertCreateBody checks and the one the task brief
        // leaves out; greying only three would misdescribe what the platform refused.
        expect(wrapper.get('[data-test="message-limit"]').attributes('disabled')).toBeDefined()
    })

    // W9
    it('never pre-greys the gated groups while the capability is unknown', async () => {
        const wrapper = await openWizard()
        await wrapper.get('[data-test="preset-multiOtp"]').trigger('click')

        expect(wrapper.find('[data-test="capability-inactive"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="capability-unknown-hint"]').exists()).toBe(true)
        expect(wrapper.get('[data-test="mailbox-select"]').attributes('data-multiple')).toBe('1')
        expect(wrapper.get('[data-test="authkey-toggle"]').attributes('disabled')).toBeUndefined()
        expect(wrapper.get('[data-test="max-sessions"]').attributes('disabled')).toBeUndefined()
        expect(wrapper.get('[data-test="message-limit"]').attributes('disabled')).toBeUndefined()
    })

    // W10
    it('resets the gated values so the owner can resubmit immediately after degrading', async () => {
        createMailShare.mockRejectedValueOnce({ code: 500, message: 'SHARE_INVALID_CONFIG' })
        const wrapper = await openWizard()
        await wrapper.get('[data-test="preset-custom"]').trigger('click')
        await setSelect(wrapper, 'mailbox-select', [11, 12])
        await wrapper.get('[data-test="authkey-toggle"]').setValue(true)
        await wrapper.get('[data-test="max-sessions"]').setValue('5')
        await wrapper.get('[data-test="message-limit"]').setValue('20')
        await submit(wrapper)

        await submit(wrapper)

        expect(createMailShare).toHaveBeenCalledTimes(2)
        const body = lastBody()
        expect(body.accountIds).toEqual([11])
        expect(body.authKeyEnabled).toBe(false)
        expect(body).not.toHaveProperty('maxSessions')
        expect(body).not.toHaveProperty('messageLimit')

        // The recheck control has to survive the resubmit, or a platform that switched the
        // capability on mid-session stays greyed until the owner reloads the page.
        await wrapper.get('[data-test="created-saved"]').trigger('click')
        expect(wrapper.find('[data-test="capability-inactive"]').exists()).toBe(true)
        await wrapper.get('[data-test="capability-recheck"]').trigger('click')
        expect(wrapper.find('[data-test="capability-inactive"]').exists()).toBe(false)
        expect(wrapper.get('[data-test="authkey-toggle"]').attributes('disabled')).toBeUndefined()
    })

    // W11
    it('stops every out-of-range value locally and never calls that a dead capability', async () => {
        const wrapper = await openWizard()
        await wrapper.get('[data-test="preset-custom"]').trigger('click')

        await wrapper.get('[data-test="refresh-interval"]').setValue('2999')
        await submit(wrapper)
        expect(wrapper.find('[data-test="wizard-error"]').exists()).toBe(true)
        await wrapper.get('[data-test="refresh-interval"]').setValue('3000')

        await wrapper.get('[data-test="max-sessions"]').setValue('0')
        await submit(wrapper)
        await wrapper.get('[data-test="max-sessions"]').setValue('')

        await wrapper.get('[data-test="message-limit"]').setValue('0')
        await submit(wrapper)
        await wrapper.get('[data-test="message-limit"]').setValue('')

        await setSelect(wrapper, 'wizard-duration', 0)
        await submit(wrapper)
        await setSelect(wrapper, 'wizard-duration', 3600)

        await setSelect(wrapper, 'mailbox-select', [])
        await submit(wrapper)

        expect(createMailShare).not.toHaveBeenCalled()
        // A local range error must never be mistaken for the capability being off, or the
        // owner loses multi-mailbox for the rest of the session over a typo.
        expect(capabilityV2.value).toBe('unknown')
        expect(wrapper.find('[data-test="capability-inactive"]').exists()).toBe(false)
    })

    // W12
    it('blocks 51 mailboxes in the browser (AC-CAP-13)', async () => {
        const wrapper = await openWizard()
        await wrapper.get('[data-test="preset-multiOtp"]').trigger('click')
        await setSelect(wrapper, 'mailbox-select', accountRows(51).map((row) => row.accountId))
        await submit(wrapper)

        expect(createMailShare).not.toHaveBeenCalled()
        expect(wrapper.find('[data-test="binding-limit"]').exists()).toBe(true)
        expect(wrapper.get('[data-test="wizard-submit"]').attributes('disabled')).toBeDefined()
    })

    // W13
    it('shows the link exactly once after a first success (AC-CAP-05)', async () => {
        const wrapper = await openWizard()
        await submit(wrapper)

        expect(wrapper.find('[data-test="secret-once"]').exists()).toBe(true)
        expect(wrapper.get('[data-test="share-url"]').element.value).toContain('#sec-7')
        expect(wrapper.emitted('created')).toHaveLength(1)
    })

    // W14
    it('shows the auth key once and only when the response carries one (AC-CAP-05)', async () => {
        createMailShare.mockResolvedValueOnce(firstSuccess({ authKey: 'Ab3dEf0123456789_-xyQ' }))
        const wrapper = await openWizard()
        await submit(wrapper)

        expect(wrapper.find('[data-test="authkey-once"]').exists()).toBe(true)
        expect(wrapper.get('[data-test="authkey-value"]').element.value).toBe('Ab3dEf0123456789_-xyQ')

        await wrapper.get('[data-test="created-saved"]').trigger('click')
        await submit(wrapper)

        expect(wrapper.find('[data-test="authkey-once"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="share-url"]').exists()).toBe(true)
    })

    // W15
    it('never lets the plaintext come back after the list refresh or the acknowledgement', async () => {
        const wrapper = await openWizard()
        await submit(wrapper)

        // The parent answers @created with a list reload; the wizard must not read the
        // plaintext back from anything that reload could touch.
        expect(wrapper.emitted('created')).toHaveLength(1)
        await flushPromises()
        expect(wrapper.get('[data-test="share-url"]').element.value).toContain('#sec-7')

        await wrapper.get('[data-test="created-saved"]').trigger('click')
        expect(wrapper.find('[data-test="share-url"]').exists()).toBe(false)
        expect(wrapper.text()).not.toContain('sec-7')

        createMailShare.mockResolvedValueOnce(firstSuccess({ sec: 'sec-8', shareUrl: 'https://mail.example.com/s/lid-8#sec-8' }))
        await wrapper.get('[data-test="wizard-name"]').setValue('second')
        await submit(wrapper)
        expect(wrapper.get('[data-test="share-url"]').element.value).toContain('#sec-8')

        await wrapper.get('[data-test="wizard-close"]').trigger('click')
        await flushPromises()

        expect(confirm).toHaveBeenCalledTimes(1)
        expect(wrapper.find('[data-test="share-url"]').exists()).toBe(false)
        expect(wrapper.text()).not.toContain('sec-8')
    })

    // W16
    it('falls back to buildShareUrl when the server did not resolve a public origin', async () => {
        createMailShare.mockResolvedValueOnce(firstSuccess({ shareUrl: undefined }))
        const wrapper = await openWizard()
        await submit(wrapper)

        expect(wrapper.get('[data-test="share-url"]').element.value)
            .toBe(`${window.location.origin}/s/lid-7#sec-7`)
    })

    // W17
    it('copies through the shared composable and stays quiet when it falls back to manual', async () => {
        createMailShare.mockResolvedValueOnce(firstSuccess({ authKey: 'Ab3dEf0123456789_-xyQ' }))
        const wrapper = await openWizard()
        // Two one-shot values, two composable instances: one selectableRef cannot hold the
        // manual-selection fallback for both inputs.
        expect(copyFactory).toHaveBeenCalledTimes(2)
        await submit(wrapper)

        await wrapper.get('[data-test="copy-share-url"]').trigger('click')
        await flushPromises()
        expect(copySpy).toHaveBeenLastCalledWith('https://mail.example.com/s/lid-7#sec-7')
        expect(message).toHaveBeenCalledTimes(1)

        await wrapper.get('[data-test="copy-authkey"]').trigger('click')
        await flushPromises()
        expect(copySpy).toHaveBeenLastCalledWith('Ab3dEf0123456789_-xyQ')
        expect(message).toHaveBeenCalledTimes(2)

        copyOutcome.value = { copied: false, path: 'manual' }
        await wrapper.get('[data-test="copy-share-url"]').trigger('click')
        await flushPromises()
        expect(message).toHaveBeenCalledTimes(2)
    })

    // W18
    it('fires one create for a double click (AC-CAP-09)', async () => {
        let resolveCreate = null
        createMailShare.mockImplementationOnce(() => new Promise((resolve) => {
            resolveCreate = resolve
        }))
        const wrapper = await openWizard()

        await wrapper.get('[data-test="wizard-submit"]').trigger('click')
        await wrapper.get('[data-test="wizard-submit"]').trigger('click')
        expect(createMailShare).toHaveBeenCalledTimes(1)

        resolveCreate(firstSuccess())
        await flushPromises()
        expect(createMailShare).toHaveBeenCalledTimes(1)
    })

    it('refuses to close while create is pending and still shows the secret (T22-P1-1)', async () => {
        let resolveCreate = null
        createMailShare.mockImplementationOnce(() => new Promise((resolve) => {
            resolveCreate = resolve
        }))
        const wrapper = await openWizard()

        await wrapper.get('[data-test="wizard-submit"]').trigger('click')
        await wrapper.get('[data-test="wizard-close"]').trigger('click')
        await flushPromises()

        expect(wrapper.find('[data-test="share-create-wizard"]').exists()).toBe(true)
        expect(wrapper.find('[data-test="secret-once"]').exists()).toBe(false)
        expect(wrapper.get('[data-test="wizard-close"]').attributes('disabled')).toBeDefined()

        resolveCreate(firstSuccess())
        await flushPromises()

        expect(wrapper.find('[data-test="secret-once"]').exists()).toBe(true)
        expect(wrapper.get('[data-test="share-url"]').element.value).toContain('#sec-7')
    })

    it('stops a fractional refresh interval locally and does not call that a dead capability (T22-P2-1)', async () => {
        const wrapper = await openWizard()
        await wrapper.get('[data-test="preset-custom"]').trigger('click')
        await wrapper.get('[data-test="authkey-toggle"]').setValue(true)
        await wrapper.get('[data-test="refresh-interval"]').setValue('3000.5')
        await submit(wrapper)

        expect(createMailShare).not.toHaveBeenCalled()
        expect(capabilityV2.value).toBe('unknown')
        expect(wrapper.find('[data-test="capability-inactive"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="wizard-error"]').exists()).toBe(true)
    })

    // A non-multiple el-select cannot render an array and quietly shows its placeholder, so a
    // single-mailbox preset looked like nothing was chosen while the request said otherwise.
    it('hands the picker a bare id when single and an array when multi', async () => {
        const wrapper = await openWizard()
        expect(selectValue(wrapper, 'mailbox-select')).toBe(11)

        await setSelect(wrapper, 'mailbox-select', 12)
        await submit(wrapper)
        expect(lastBody().accountIds).toEqual([12])

        await wrapper.get('[data-test="created-saved"]').trigger('click')
        await wrapper.get('[data-test="preset-multiOtp"]').trigger('click')
        expect(selectValue(wrapper, 'mailbox-select')).toEqual([12])
    })

    it('pages the owner mailboxes with the cursor the account endpoint expects', async () => {
        accountList.mockResolvedValueOnce(accountRows(30))
        accountList.mockResolvedValueOnce(accountRows(4, 30))
        const wrapper = await openWizard()

        expect(accountList).toHaveBeenCalledWith(0, 30, null)

        await wrapper.get('[data-test="mailbox-load-more"]').trigger('click')
        await flushPromises()

        expect(accountList).toHaveBeenLastCalledWith(30, 30, 30)
        expect(wrapper.find('[data-test="mailbox-load-more"]').exists()).toBe(false)
    })
})

describe('share create wizard styling contract', () => {
    it('keeps the repo-wide token discipline (jsdom cannot evaluate media queries)', async () => {
        const src = await readFile(path.join(process.cwd(), 'src/views/share-admin/ShareCreateWizard.vue'), 'utf8')
        expect(src).toContain('<style lang="scss" scoped>')
        expect(src).toContain('@media (max-width: 767px)')
        expect(src).not.toContain('window.onresize')
        // Raw hex is what broke dark mode in ShareDialog; the admin surface stays on tokens.
        expect(src.replace(/[\s\S]*<style/, '<style')).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    })
})
