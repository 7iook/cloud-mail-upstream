import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
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

// The account list endpoint is mocked only as a tripwire: P2 removed the mailbox dropdown, so
// the wizard has no reason left to call it. A call here means the deprecated pick-a-registered
// -account path grew back.
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

// A real shallowRef, not a plain object: the one-shot inputs bind it as a template ref,
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

import {
    CREATE_BODY_KEYS,
    DURATION_CUSTOM,
    MAX_DURATION_DAYS,
    MAX_DURATION_SECONDS,
    capabilityV2,
    parseShareEmails
} from './presets.js'
import ShareCreateWizard from './ShareCreateWizard.vue'

// A select stub that carries its model as JSON: the duration picker is the only select left
// after P2 replaced the mailbox dropdown with the full-address textarea.
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

function firstSuccess(overrides = {}) {
    return {
        shareId: 7,
        lid: 'lid-7',
        sec: 'sec-7',
        shareUrl: 'https://mail.example.com/s/lid-7#sec-7',
        shareType: 'single',
        expiresAt: '2026-08-25 01:00:00',
        mailbox: 'box11@example.com',
        bindings: [{ bindingId: 1, accountId: 11 }],
        ...overrides
    }
}

// The V2=false batch shape (DC-P0-1): one request, N single shares, each with its own lid/sec.
function batchSuccess() {
    return {
        shares: [
            firstSuccess({ mailbox: 'a@example.com' }),
            firstSuccess({
                shareId: 8,
                lid: 'lid-8',
                sec: 'sec-8',
                shareUrl: 'https://mail.example.com/s/lid-8#sec-8',
                mailbox: 'b@example.com',
                bindings: [{ bindingId: 2, accountId: 12 }]
            })
        ]
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

function mountWizard() {
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
    return mount(ShareCreateWizard, {
        global: {
            plugins: [i18n],
            stubs
        }
    })
}

async function openWizard() {
    const wrapper = mountWizard()
    await wrapper.get('[data-test="wizard-open"]').trigger('click')
    await flushPromises()
    return wrapper
}

async function fillEmails(wrapper, text = 'box11@example.com') {
    await wrapper.get('[data-test="wizard-emails"]').setValue(text)
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

describe('share-admin create wizard (AC-CAP-12 / AC-CAP-14 / P2 emails)', () => {
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
        expect(wrapper.get('[data-test="mask-toggle"]').element.checked).toBe(false)

        await wrapper.get('[data-test="preset-custom"]').trigger('click')
        expect(selectValue(wrapper, 'wizard-duration')).toBe(3600)

        await wrapper.get('[data-test="preset-singleOtp"]').trigger('click')
        expect(selectValue(wrapper, 'wizard-duration')).toBe(3600)

        await fillEmails(wrapper)
        await submit(wrapper)

        const body = lastBody()
        expect(Object.keys(body).sort()).toEqual(
            Object.keys(body).filter((key) => CREATE_BODY_KEYS.includes(key)).sort()
        )
        expect(body).not.toHaveProperty('preset')
        expect(body).not.toHaveProperty('presetId')
        expect(body).not.toHaveProperty('presetKey')
    })

    // W2 — P2: the wizard speaks full addresses, never account ids and never a prefix+domain
    // concatenation. The deprecated pick-a-registered-account path must leave no trace in the
    // request and no mailbox dropdown in the DOM.
    it('sends full addresses and no account id, with the deprecated dropdown gone (P2)', async () => {
        const wrapper = await openWizard()
        await fillEmails(wrapper, '  Box11@Example.COM ')
        await submit(wrapper)

        const body = lastBody()
        expect(body.emails).toEqual(['box11@example.com'])
        expect(body).not.toHaveProperty('accountIds')
        expect(body).not.toHaveProperty('accountId')
        expect(body.durationSeconds).toBe(3600)
        expect(body.refreshIntervalMs).toBe(3000)
        expect(body.onlyMessagesAfterCreated).toBe(true)
        expect(body.otpExtractionEnabled).toBe(true)
        expect(body.autoRefresh).toBe(true)
        expect(body.showFullAddress).toBe(false)
        expect(body.authKeyEnabled).toBe(false)
        expect(body).not.toHaveProperty('maxSessions')
        expect(body).not.toHaveProperty('messageLimit')

        expect(wrapper.find('[data-test="mailbox-select"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="mailbox-load-more"]').exists()).toBe(false)
        expect(accountList).not.toHaveBeenCalled()
    })

    // P2 — the paste grammar the decision card fixes: [\s,;]+ separators, trim, lowercase,
    // dedupe. The newline separator is asserted on parseShareEmails directly because a jsdom
    // <input> strips line breaks from value, which would test the harness instead of the parser.
    it('splits every separator of the paste grammar, including new lines and tabs', () => {
        expect(parseShareEmails('a@x.com\nb@x.com\tc@x.com,,;\n d@x.com ').emails)
            .toEqual(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'])
    })

    // The tags mirror exactly what the request will carry.
    it('parses a pasted batch, dedupes case-insensitively and rotates the key on edits', async () => {
        const wrapper = await openWizard()
        await fillEmails(wrapper, 'A@Example.com, b@example.com; a@example.com c@example.com')

        const tags = wrapper.findAll('[data-test="email-tag"]')
        expect(tags.map((tag) => tag.text())).toEqual(['a@example.com', 'b@example.com', 'c@example.com'])

        createMailShare.mockResolvedValueOnce(batchSuccess())
        await submit(wrapper)
        expect(lastBody().emails).toEqual(['a@example.com', 'b@example.com', 'c@example.com'])

        await wrapper.get('[data-test="created-saved"]').trigger('click')
        await fillEmails(wrapper, 'd@example.com')
        await submit(wrapper)

        expect(lastBody().emails).toEqual(['d@example.com'])
        // Editing the address list changes the fingerprint, so the key must rotate with it.
        expect(keyAt(1)).not.toBe(keyAt(0))
    })

    // W3
    it('sends an Idempotency-Key with every create (AC-CAP-09)', async () => {
        const wrapper = await openWizard()
        await fillEmails(wrapper)
        await submit(wrapper)

        expect(createMailShare).toHaveBeenCalledTimes(1)
        expect(typeof keyAt(0)).toBe('string')
        expect(keyAt(0).length).toBeGreaterThan(8)
    })

    // W4
    it('locks the form and retries with the same key after an unknown result (AC-CAP-14)', async () => {
        createMailShare.mockRejectedValueOnce(transportFailure())
        const wrapper = await openWizard()
        await fillEmails(wrapper)
        await submit(wrapper)

        expect(wrapper.find('[data-test="wizard-unknown"]').exists()).toBe(true)
        expect(wrapper.get('[data-test="wizard-name"]').attributes('disabled')).toBeDefined()
        expect(wrapper.get('[data-test="wizard-emails"]').attributes('disabled')).toBeDefined()
        expect(wrapper.find('[data-test="wizard-submit"]').exists()).toBe(false)

        await wrapper.get('[data-test="wizard-retry"]').trigger('click')
        await flushPromises()

        expect(createMailShare).toHaveBeenCalledTimes(2)
        expect(keyAt(1)).toBe(keyAt(0))
    })

    it('does not rotate the idempotency key when an unknown-result dialog is closed and reopened (AC-CAP-14)', async () => {
        createMailShare.mockRejectedValueOnce(transportFailure())
        const wrapper = await openWizard()
        await fillEmails(wrapper)
        await submit(wrapper)
        const firstKey = keyAt(0)

        await wrapper.get('[data-test="wizard-close"]').trigger('click')
        await flushPromises()
        await wrapper.get('[data-test="wizard-open"]').trigger('click')
        await flushPromises()

        expect(wrapper.find('[data-test="wizard-unknown"]').exists()).toBe(true)
        await wrapper.get('[data-test="wizard-retry"]').trigger('click')
        await flushPromises()

        expect(createMailShare).toHaveBeenCalledTimes(2)
        expect(keyAt(1)).toBe(firstKey)
    })

    // W5
    it('keeps the form editable on a business reject and only then rotates the key', async () => {
        createMailShare.mockRejectedValueOnce({ code: 500, message: 'SHARE_DURATION_EXCEEDED' })
        const wrapper = await openWizard()
        await fillEmails(wrapper)
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
        await fillEmails(wrapper)
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
        await fillEmails(wrapper)
        await submit(wrapper)

        expect(wrapper.find('[data-test="replay-guidance"]').exists()).toBe(true)
        expect(wrapper.find('[data-test="wizard-retry"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="replay-new-key"]').exists()).toBe(false)
        expect(createMailShare).toHaveBeenCalledTimes(1)
    })

    // P2 — a replayed V2=false batch comes back as { shares, idempotentReplay } with no sec:
    // the pane must list every share of the batch and still give away no plaintext.
    it('lists every share of a replayed batch without any plaintext', async () => {
        createMailShare.mockResolvedValueOnce({
            shares: [
                { shareId: 7, lid: 'lid-7', expiresAt: '2026-08-25 01:00:00', mailbox: 'a@example.com', bindings: [] },
                { shareId: 8, lid: 'lid-8', expiresAt: '2026-08-25 01:00:00', mailbox: 'b@example.com', bindings: [] }
            ],
            idempotentReplay: true
        })
        const wrapper = await openWizard()
        await fillEmails(wrapper, 'a@example.com b@example.com')
        await submit(wrapper)

        expect(wrapper.find('[data-test="share-replay"]').exists()).toBe(true)
        const ids = wrapper.findAll('[data-test="replay-share-id"]')
        expect(ids.map((node) => node.text())).toEqual(['7', '8'])
        expect(wrapper.find('[data-test="share-url"]').exists()).toBe(false)
        expect(wrapper.text()).not.toContain('sec-')
    })

    // W8
    it('greys the gated groups after a real fence rejection and keeps the batch intact', async () => {
        createMailShare.mockRejectedValueOnce({ code: 500, message: 'SHARE_CAPABILITY_NOT_ENABLED' })
        const wrapper = await openWizard()
        await wrapper.get('[data-test="preset-custom"]').trigger('click')
        await fillEmails(wrapper, 'a@example.com b@example.com')
        await wrapper.get('[data-test="authkey-toggle"]').setValue(true)
        await submit(wrapper)

        expect(createMailShare.mock.calls[0][0].authKeyEnabled).toBe(true)
        expect(wrapper.find('[data-test="capability-inactive"]').exists()).toBe(true)
        expect(wrapper.get('[data-test="authkey-toggle"]').attributes('disabled')).toBeDefined()
        expect(wrapper.get('[data-test="max-sessions"]').attributes('disabled')).toBeDefined()
        // messageLimit is the fourth gate assertCreateBody checks and the one the task brief
        // leaves out; greying only three would misdescribe what the platform refused.
        expect(wrapper.get('[data-test="message-limit"]').attributes('disabled')).toBeDefined()
        // Degrading must not shrink the address list: V2=false still serves the batch as
        // N single shares (DC-P0-1), so the fence has no claim on the emails.
        expect(wrapper.get('[data-test="wizard-emails"]').element.value).toBe('a@example.com b@example.com')
    })

    // 拆码前这条做不到:栅栏与「取值越域」共用 SHARE_INVALID_CONFIG,后端拒一个写错的值时
    // 前端会误读成「平台没开这项能力」,灰掉四组并让 Owner 去找管理员 —— 指向完全错误的动作。
    it('does not grey the gated groups when the server refused a value, not the capability', async () => {
        createMailShare.mockRejectedValueOnce({ code: 500, message: 'SHARE_INVALID_CONFIG' })
        const wrapper = await openWizard()
        await wrapper.get('[data-test="preset-custom"]').trigger('click')
        await fillEmails(wrapper)
        await wrapper.get('[data-test="authkey-toggle"]').setValue(true)
        await submit(wrapper)

        expect(wrapper.find('[data-test="capability-inactive"]').exists()).toBe(false)
        expect(wrapper.get('[data-test="authkey-toggle"]').attributes('disabled')).toBeUndefined()
        expect(wrapper.get('[data-test="max-sessions"]').attributes('disabled')).toBeUndefined()
        expect(wrapper.get('[data-test="message-limit"]').attributes('disabled')).toBeUndefined()
    })

    // W9
    it('never pre-greys the gated groups while the capability is unknown', async () => {
        const wrapper = await openWizard()
        await wrapper.get('[data-test="preset-multiOtp"]').trigger('click')

        expect(wrapper.find('[data-test="capability-inactive"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="capability-unknown-hint"]').exists()).toBe(true)
        expect(wrapper.get('[data-test="authkey-toggle"]').attributes('disabled')).toBeUndefined()
        expect(wrapper.get('[data-test="max-sessions"]').attributes('disabled')).toBeUndefined()
        expect(wrapper.get('[data-test="message-limit"]').attributes('disabled')).toBeUndefined()
    })

    // W10
    it('resets the gated values so the owner can resubmit immediately after degrading', async () => {
        createMailShare.mockRejectedValueOnce({ code: 500, message: 'SHARE_CAPABILITY_NOT_ENABLED' })
        const wrapper = await openWizard()
        await wrapper.get('[data-test="preset-custom"]').trigger('click')
        await fillEmails(wrapper, 'a@example.com b@example.com')
        await wrapper.get('[data-test="authkey-toggle"]').setValue(true)
        await wrapper.get('[data-test="max-sessions"]').setValue('5')
        await wrapper.get('[data-test="message-limit"]').setValue('20')
        await submit(wrapper)

        createMailShare.mockResolvedValueOnce(batchSuccess())
        await submit(wrapper)

        expect(createMailShare).toHaveBeenCalledTimes(2)
        const body = lastBody()
        // The batch survives the degrade: V2=false turns it into N single shares server-side.
        expect(body.emails).toEqual(['a@example.com', 'b@example.com'])
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
        await fillEmails(wrapper)

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

        await fillEmails(wrapper, '')
        await submit(wrapper)

        expect(createMailShare).not.toHaveBeenCalled()
        // A local range error must never be mistaken for the capability being off, or the
        // owner loses the gated groups for the rest of the session over a typo.
        expect(capabilityV2.value).toBe('unknown')
        expect(wrapper.find('[data-test="capability-inactive"]').exists()).toBe(false)
    })

    // P2 — a malformed address is stopped in the browser with the offending token in the
    // sentence: SHARE_EMAIL_INVALID from the server cannot say which of 20 addresses it meant.
    it('blocks a malformed address locally and names it in the error', async () => {
        const wrapper = await openWizard()
        await fillEmails(wrapper, 'a@example.com not-an-email')
        await submit(wrapper)

        expect(createMailShare).not.toHaveBeenCalled()
        expect(wrapper.get('[data-test="wizard-error"]').text()).toContain('not-an-email')
    })

    // W12 — the 50 cap mirrors the worker's SHARE_BINDING_LIMIT, which P2 applies to
    // emails.length on both the V2 multi path and the V2=false batch path.
    it('blocks 51 addresses in the browser (AC-CAP-13)', async () => {
        const wrapper = await openWizard()
        const addresses = Array.from({ length: 51 }, (unused, index) => `box${index + 1}@example.com`)
        await fillEmails(wrapper, addresses.join(' '))
        await submit(wrapper)

        expect(createMailShare).not.toHaveBeenCalled()
        expect(wrapper.find('[data-test="binding-limit"]').exists()).toBe(true)
        expect(wrapper.get('[data-test="wizard-submit"]').attributes('disabled')).toBeDefined()
    })

    // W13
    it('shows the link exactly once after a first success (AC-CAP-05)', async () => {
        const wrapper = await openWizard()
        await fillEmails(wrapper)
        await submit(wrapper)

        expect(wrapper.find('[data-test="secret-once"]').exists()).toBe(true)
        expect(wrapper.get('[data-test="share-url"]').element.value).toContain('#sec-7')
        expect(wrapper.emitted('created')).toHaveLength(1)
    })

    // P2 批量分流(DC-P0-1):V2=false 的多地址响应是 { shares: [...] },结果区必须把每条
    // 链接都列出来、都可复制 —— 静默只显示第一条等于把其余分享丢进永远看不见的地方。
    it('lists one copyable link per share when the response carries shares[] (DC-P0-1)', async () => {
        createMailShare.mockResolvedValueOnce(batchSuccess())
        const wrapper = await openWizard()
        await fillEmails(wrapper, 'a@example.com b@example.com')
        await submit(wrapper)

        expect(wrapper.emitted('created')).toHaveLength(1)
        const urls = wrapper.findAll('[data-test="share-url"]')
        expect(urls).toHaveLength(2)
        expect(urls[0].element.value).toContain('#sec-7')
        expect(urls[1].element.value).toContain('#sec-8')
        // Each link is labelled with its mailbox, or two identical-looking links cannot be
        // told apart when handing them to two different people.
        expect(wrapper.text()).toContain('a@example.com')
        expect(wrapper.text()).toContain('b@example.com')

        const copies = wrapper.findAll('[data-test="copy-share-url"]')
        await copies[1].trigger('click')
        await flushPromises()
        expect(copySpy).toHaveBeenLastCalledWith('https://mail.example.com/s/lid-8#sec-8')

        await wrapper.get('[data-test="created-saved"]').trigger('click')
        expect(wrapper.find('[data-test="share-url"]').exists()).toBe(false)
        expect(wrapper.text()).not.toContain('sec-8')
    })

    // P2 — the friendly words for an unconfigured domain, verbatim from the i18n table: this
    // is the decision card's "域名未配置有友好提示" seen from the owner's chair.
    it('shows the friendly domain-not-configured message and keeps the form editable (P2)', async () => {
        createMailShare.mockRejectedValueOnce({ code: 500, message: 'SHARE_DOMAIN_NOT_CONFIGURED' })
        const wrapper = await openWizard()
        await fillEmails(wrapper, 'someone@unconfigured.example')
        await submit(wrapper)

        expect(wrapper.get('[data-test="wizard-error"]').text()).toBe(en.shareDomainNotConfigured)
        expect(wrapper.get('[data-test="wizard-name"]').attributes('disabled')).toBeUndefined()
        expect(wrapper.find('[data-test="capability-inactive"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="wizard-unknown"]').exists()).toBe(false)
    })

    // W14
    it('shows the auth key once and only when the response carries one (AC-CAP-05)', async () => {
        createMailShare.mockResolvedValueOnce(firstSuccess({ authKey: 'Ab3dEf0123456789_-xyQ' }))
        const wrapper = await openWizard()
        await fillEmails(wrapper)
        await submit(wrapper)

        expect(wrapper.find('[data-test="authkey-once"]').exists()).toBe(true)
        expect(wrapper.get('[data-test="authkey-value"]').element.value).toBe('Ab3dEf0123456789_-xyQ')

        // The link and the key stopped sharing a fate: the link can be retrieved later, the key
        // is a one-way hash and cannot. shareSecretOnce used to warn for both, so when it stopped
        // claiming "gone forever" the key was briefly left with no warning of its own. Asserting
        // both texts here means neither can be rewritten into speaking for the other again.
        const keyWarning = wrapper.get('[data-test="wizard-authkey-once"]').text()
        const linkHint = wrapper.get('[data-test="secret-once"]').text()
        expect(keyWarning).toBe(en.shareAuthKeyOnce)
        expect(keyWarning).toMatch(/cannot be viewed again/i)
        expect(linkHint).not.toMatch(/cannot be viewed again/i)

        await wrapper.get('[data-test="created-saved"]').trigger('click')
        await submit(wrapper)

        expect(wrapper.find('[data-test="authkey-once"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="share-url"]').exists()).toBe(true)
    })

    // W15 — closing the result pane must not raise a second "shown only once" confirm: the
    // link is retrievable from the detail drawer (ADR-share-credential-recoverability), so the
    // scare dialog claimed something false and the user ordered it removed (P3).
    it('never lets the plaintext come back after the list refresh or the acknowledgement', async () => {
        const wrapper = await openWizard()
        await fillEmails(wrapper)
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

        expect(confirm).not.toHaveBeenCalled()
        expect(wrapper.find('[data-test="share-create-wizard"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="share-url"]').exists()).toBe(false)
        expect(wrapper.text()).not.toContain('sec-8')
    })

    // W16
    it('falls back to buildShareUrl when the server did not resolve a public origin', async () => {
        createMailShare.mockResolvedValueOnce(firstSuccess({ shareUrl: undefined }))
        const wrapper = await openWizard()
        await fillEmails(wrapper)
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
        await fillEmails(wrapper)
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
        await fillEmails(wrapper)

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
        await fillEmails(wrapper)

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
        await fillEmails(wrapper)
        await wrapper.get('[data-test="authkey-toggle"]').setValue(true)
        await wrapper.get('[data-test="refresh-interval"]').setValue('3000.5')
        await submit(wrapper)

        expect(createMailShare).not.toHaveBeenCalled()
        expect(capabilityV2.value).toBe('unknown')
        expect(wrapper.find('[data-test="capability-inactive"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="wizard-error"]').exists()).toBe(true)
    })

    // W-E1a
    it('sends a custom 30-day duration as seconds, not as the sentinel (W-E1)', async () => {
        const wrapper = await openWizard()
        await fillEmails(wrapper)

        expect(wrapper.find('[data-test="wizard-duration-amount"]').exists()).toBe(false)

        await setSelect(wrapper, 'wizard-duration', DURATION_CUSTOM)
        await setSelect(wrapper, 'wizard-duration-unit', 'days')
        await wrapper.get('[data-test="wizard-duration-amount"]').setValue(30)
        await submit(wrapper)

        expect(lastBody().durationSeconds).toBe(2592000)
        expect(wrapper.find('[data-test="wizard-error"]').exists()).toBe(false)
    })

    // W-E1b
    it('rejects a duration past the ceiling before the request leaves (W-E1)', async () => {
        const wrapper = await openWizard()
        await fillEmails(wrapper)

        await setSelect(wrapper, 'wizard-duration', DURATION_CUSTOM)
        await setSelect(wrapper, 'wizard-duration-unit', 'days')
        await wrapper.get('[data-test="wizard-duration-amount"]').setValue(3650)
        await submit(wrapper)

        expect(createMailShare).not.toHaveBeenCalled()
        // The ceiling has to be in the sentence: "invalid duration" leaves the owner guessing
        // which way to move the number.
        expect(wrapper.get('[data-test="wizard-error"]').text()).toContain(String(MAX_DURATION_DAYS))
    })

    // W-E1c
    it('carries the ceiling out of one constant into both the hint and the rejection (W-E1)', async () => {
        const wrapper = await openWizard()
        await fillEmails(wrapper)
        await setSelect(wrapper, 'wizard-duration', DURATION_CUSTOM)

        expect(wrapper.get('[data-test="duration-ceiling"]').text()).toContain(String(MAX_DURATION_DAYS))
        expect(wrapper.get('[data-test="duration-ceiling"]').text()).not.toContain('{days}')

        await setSelect(wrapper, 'wizard-duration-unit', 'hours')
        await wrapper.get('[data-test="wizard-duration-amount"]').setValue(MAX_DURATION_DAYS * 24)
        await submit(wrapper)

        expect(lastBody().durationSeconds).toBe(MAX_DURATION_SECONDS)
    })

    // W-E1d
    it('drops back to the rung a preset carries instead of stranding the custom fields (W-E1)', async () => {
        const wrapper = await openWizard()
        await fillEmails(wrapper)

        await setSelect(wrapper, 'wizard-duration', DURATION_CUSTOM)
        await wrapper.get('[data-test="wizard-duration-amount"]').setValue(30)
        expect(selectValue(wrapper, 'wizard-duration')).toBe(DURATION_CUSTOM)

        await wrapper.get('[data-test="preset-tempMailbox"]').trigger('click')

        expect(selectValue(wrapper, 'wizard-duration')).toBe(86400)
        expect(wrapper.find('[data-test="wizard-duration-amount"]').exists()).toBe(false)

        await submit(wrapper)
        expect(lastBody().durationSeconds).toBe(86400)
    })

    // W-E1e
    it('refuses an emptied custom amount rather than sending 0 seconds (W-E1)', async () => {
        const wrapper = await openWizard()
        await fillEmails(wrapper)

        await setSelect(wrapper, 'wizard-duration', DURATION_CUSTOM)
        await wrapper.get('[data-test="wizard-duration-amount"]').setValue('')
        await submit(wrapper)

        expect(createMailShare).not.toHaveBeenCalled()
        expect(wrapper.find('[data-test="wizard-error"]').exists()).toBe(true)
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
