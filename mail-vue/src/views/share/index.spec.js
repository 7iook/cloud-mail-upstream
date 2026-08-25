import { readFileSync } from 'node:fs'
import path from 'node:path'
import axios from 'axios'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createShareSession, isShareRateLimited, isShareUnavailable } from '@/request/share.js'
import en from '@/i18n/en.js'
import zh from '@/i18n/zh.js'
import { POLL_INTERVAL_MS } from '@/composables/useSharePolling.js'
import { readShareSession, writeShareSession } from './session.js'
import ShareView from './index.vue'

const {
    createShareSession: createShareSessionMock,
    listShareMails,
    getShareAttachment,
    getShareMailboxesStatus
} = vi.hoisted(() => ({
    createShareSession: vi.fn(),
    listShareMails: vi.fn(),
    getShareAttachment: vi.fn(),
    getShareMailboxesStatus: vi.fn()
}))

vi.mock('@/request/share.js', async (importOriginal) => {
    const actual = await importOriginal()
    return {
        ...actual,
        createShareSession: createShareSessionMock,
        listShareMails,
        getShareAttachment,
        getShareMailboxesStatus
    }
})

const wrappers = []

function flattenLogged(args) {
    const parts = []
    const seen = new WeakSet()
    function walk(value) {
        if (value == null) {
            return
        }
        const type = typeof value
        if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
            parts.push(String(value))
            return
        }
        if (type !== 'object' && type !== 'function') {
            return
        }
        if (seen.has(value)) {
            return
        }
        seen.add(value)
        if (value instanceof Error) {
            parts.push(value.name || '', value.message || '', value.stack || '')
        }
        try {
            parts.push(JSON.stringify(value))
        } catch {
            // AxiosError / circular objects still get walked by key below
        }
        const keys = new Set([
            ...Object.keys(value),
            ...Object.getOwnPropertyNames(value)
        ])
        for (const key of keys) {
            try {
                walk(value[key])
            } catch {
                // skip throwing getters
            }
        }
    }
    for (const arg of args) {
        walk(arg)
    }
    return parts.join('\n')
}

const elementStubs = {
    'el-button': {
        props: ['type', 'size', 'disabled'],
        template: '<button type="button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>'
    },
    'el-alert': {
        props: ['title', 'type', 'closable'],
        template: '<div class="el-alert-stub" role="status">{{ title }}</div>'
    }
}

function mail(overrides = {}) {
    return {
        mailId: 1,
        senderName: 'GitHub',
        senderAddress: 'noreply@github.com',
        subject: 'Your verification code',
        text: 'Your code is 482917',
        content: '<p>Your code is 482917</p>',
        receivedAt: '2026-08-17 02:00:00',
        code: '482917',
        attachments: [],
        ...overrides
    }
}

async function mountShare(lid, hash = '') {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/s/:lid', name: 'share', component: ShareView }]
    })
    const i18n = createI18n({
        legacy: false,
        locale: 'en',
        messages: { en, zh }
    })
    window.history.replaceState(window.history.state, '', hash ? `/s/${lid}#${hash}` : `/s/${lid}`)
    await router.push(`/s/${lid}`)
    await router.isReady()
    const wrapper = mount(ShareView, {
        global: {
            plugins: [router, i18n],
            stubs: elementStubs
        }
    })
    wrappers.push(wrapper)
    await flushPromises()
    return wrapper
}

describe('share view session shell', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        sessionStorage.clear()
        createShareSession.mockReset()
        listShareMails.mockReset()
        getShareAttachment.mockReset()
        getShareMailboxesStatus.mockReset()
        listShareMails.mockResolvedValue({ list: [], nextCursor: null })
        getShareAttachment.mockResolvedValue(new Blob(['x']))
        getShareMailboxesStatus.mockResolvedValue({ mailboxes: [{ bindingId: 0, latestEmailId: null }] })
    })

    afterEach(() => {
        while (wrappers.length) {
            wrappers.pop().unmount()
        }
        sessionStorage.clear()
        vi.clearAllMocks()
        vi.useRealTimers()
    })

    it('exchanges the fragment once, stores share:session:<lid>, and clears the hash', async () => {
        createShareSession.mockResolvedValue({ sessionToken: 'sess-a', mailbox: 'a@example.com' })

        const wrapper = await mountShare('lid-a', 'sec-a')

        expect(createShareSession).toHaveBeenCalledTimes(1)
        expect(createShareSession).toHaveBeenCalledWith('lid-a', 'sec-a', expect.objectContaining({
            idempotencyKey: expect.any(String)
        }))
        expect(readShareSession('lid-a')).toBe('sess-a')
        expect(window.location.hash).toBe('')
        expect(window.location.href).not.toContain('sec-a')
        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('ready')
        expect(wrapper.text()).not.toMatch(/textHtml|textPlain/)
    })

    it('restores a stored token on refresh without calling createShareSession', async () => {
        writeShareSession('lid-a', 'sess-refresh')

        const wrapper = await mountShare('lid-a')

        expect(createShareSession).not.toHaveBeenCalled()
        expect(readShareSession('lid-a')).toBe('sess-refresh')
        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('ready')
    })

    it('does not reuse another lid token when the fragment is missing', async () => {
        writeShareSession('lid-other', 'sess-other')

        const wrapper = await mountShare('lid-a')

        expect(createShareSession).not.toHaveBeenCalled()
        expect(readShareSession('lid-other')).toBe('')
        expect(readShareSession('lid-a')).toBe('')
        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('unavailable')
    })

    it('does not write sec to console when session establish fails (AC-LEAK-05)', async () => {
        const secret = 'sec-capability-secret-9f3a'
        const axiosError = new axios.AxiosError(
            'Request failed with status code 403',
            axios.AxiosError.ERR_BAD_RESPONSE,
            {
                url: '/share/session',
                method: 'post',
                data: { lid: 'lid-a', sec: secret }
            },
            {},
            {
                status: 403,
                statusText: 'Forbidden',
                data: { code: 501, message: 'SHARE_UNAVAILABLE' },
                config: {
                    url: '/share/session',
                    method: 'post',
                    data: { lid: 'lid-a', sec: secret }
                }
            }
        )
        createShareSession.mockRejectedValue(axiosError)
        const lines = []
        const capture = (...args) => {
            lines.push(flattenLogged(args))
        }
        const log = vi.spyOn(console, 'log').mockImplementation(capture)
        const error = vi.spyOn(console, 'error').mockImplementation(capture)
        const warn = vi.spyOn(console, 'warn').mockImplementation(capture)
        const info = vi.spyOn(console, 'info').mockImplementation(capture)
        try {
            const wrapper = await mountShare('lid-a', secret)
            expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('unavailable')
            const joined = lines.join('\n')
            expect(joined).not.toContain(secret)
            expect(joined).not.toMatch(/"sec"\s*:/)
        } finally {
            log.mockRestore()
            error.mockRestore()
            warn.mockRestore()
            info.mockRestore()
        }
    })

    it('clears the lid token when session establish fails', async () => {
        writeShareSession('lid-a', 'stale')
        createShareSession.mockRejectedValue({ code: 'SHARE_UNAVAILABLE', message: 'SHARE_UNAVAILABLE' })
        window.history.replaceState(window.history.state, '', '/s/lid-a#bad-sec')

        const wrapper = await mountShare('lid-a', 'bad-sec')

        expect(isShareUnavailable({ code: 'SHARE_UNAVAILABLE', message: 'SHARE_UNAVAILABLE' })).toBe(true)
        expect(readShareSession('lid-a')).toBe('')
        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('unavailable')
    })

    it('shows timed-out, not a dead link, when a later share call fails after a working session and the secret is gone (AC-VISIT-12, AC-VISIT-14)', async () => {
        writeShareSession('lid-a', 'sess-a')
        const wrapper = await mountShare('lid-a')

        await wrapper.vm.noteShareFailure({ code: 'SHARE_UNAVAILABLE', message: 'SHARE_UNAVAILABLE' })
        await flushPromises()

        expect(readShareSession('lid-a')).toBe('')
        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('timedout')
        expect(wrapper.text()).toMatch(/timed out/i)
        expect(wrapper.text()).toMatch(/original link/i)
        expect(wrapper.text()).not.toMatch(/no longer available/i)
    })

    it('clears the lid token on explicit exit', async () => {
        writeShareSession('lid-a', 'sess-a')
        const wrapper = await mountShare('lid-a')

        await wrapper.get('[data-share-exit]').trigger('click')
        await flushPromises()

        expect(readShareSession('lid-a')).toBe('')
        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('exited')
    })

    it('does not clear a stored token on a 429 from session establish', async () => {
        writeShareSession('lid-a', 'keep-me')
        const limited = { name: 'ShareRateLimitedError', status: 429 }
        createShareSession.mockRejectedValue(limited)
        expect(isShareRateLimited(limited)).toBe(true)

        const wrapper = await mountShare('lid-a', 'sec-a')

        expect(readShareSession('lid-a')).toBe('keep-me')
        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('limited')
    })
})

describe('share view visitor mailbox', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        sessionStorage.clear()
        createShareSession.mockReset()
        listShareMails.mockReset()
        getShareAttachment.mockReset()
        getShareMailboxesStatus.mockReset()
        listShareMails.mockResolvedValue({ list: [], nextCursor: null })
        getShareAttachment.mockResolvedValue(new Blob(['x']))
        getShareMailboxesStatus.mockResolvedValue({ mailboxes: [{ bindingId: 0, latestEmailId: null }] })
    })

    afterEach(() => {
        while (wrappers.length) {
            wrappers.pop().unmount()
        }
        sessionStorage.clear()
        vi.clearAllMocks()
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('lists mail for a valid session (AC-VISIT-01 after session)', async () => {
        createShareSession.mockResolvedValue({ sessionToken: 'sess-a', mailbox: 'otp@example.com' })
        listShareMails.mockResolvedValue({
            list: [mail({ mailId: 11, subject: 'Desk code', code: '' })],
            nextCursor: null
        })

        const wrapper = await mountShare('lid-a', 'sec-a')

        expect(listShareMails).toHaveBeenCalledWith(expect.objectContaining({
            sessionToken: 'sess-a'
        }))
        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('ready')
        expect(wrapper.get('[data-share-mail-list]').text()).toContain('Desk code')
        expect(wrapper.get('[data-share-body]').text()).toContain('Desk code')
        expect(wrapper.find('[data-share-code]').exists()).toBe(false)
    })

    it('shows a non-empty email.code with sender name and address, and copies only when the clipboard accepts (AC-OTP-07, AC-OTP-08)', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        vi.stubGlobal('navigator', {
            ...navigator,
            language: 'en',
            clipboard: { writeText }
        })
        createShareSession.mockResolvedValue({ sessionToken: 'sess-a', mailbox: 'otp@example.com' })
        listShareMails.mockResolvedValue({
            list: [mail()],
            nextCursor: null
        })

        const wrapper = await mountShare('lid-a', 'sec-a')

        const codeBox = wrapper.get('[data-share-code]')
        expect(codeBox.text()).toContain('482917')
        expect(wrapper.get('[data-share-code-from]').text()).toContain('GitHub')
        expect(wrapper.get('[data-share-code-from]').text()).toContain('noreply@github.com')

        await wrapper.get('[data-share-copy]').trigger('click')
        await flushPromises()

        expect(writeText).toHaveBeenCalledWith('482917')
        expect(wrapper.get('[data-share-copy-result]').attributes('data-share-copy-result')).toBe('copied')
    })

    it('does not claim copy success when the clipboard rejects and only the fallback path remains', async () => {
        const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
        vi.stubGlobal('navigator', {
            ...navigator,
            language: 'en',
            clipboard: { writeText }
        })
        document.execCommand = () => false
        createShareSession.mockResolvedValue({ sessionToken: 'sess-a', mailbox: 'otp@example.com' })
        listShareMails.mockResolvedValue({
            list: [mail()],
            nextCursor: null
        })

        const wrapper = await mountShare('lid-a', 'sec-a')
        await wrapper.get('[data-share-copy]').trigger('click')
        await flushPromises()

        expect(wrapper.get('[data-share-copy-result]').attributes('data-share-copy-result')).toBe('manual')
        expect(wrapper.get('[data-share-copy-result]').text()).not.toMatch(/copied/i)
    })

    it('shows an indistinguishable unavailable state for a dead link, without guessing why (AC-VISIT-04)', async () => {
        createShareSession.mockResolvedValue({ sessionToken: 'sess-a', mailbox: 'otp@example.com' })
        listShareMails.mockRejectedValue({ code: 'SHARE_UNAVAILABLE', message: 'SHARE_UNAVAILABLE' })

        const wrapper = await mountShare('lid-a', 'sec-a')

        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('unavailable')
        expect(readShareSession('lid-a')).toBe('')
        expect(wrapper.text()).toMatch(/no longer available/i)
        expect(wrapper.text()).not.toMatch(/expired|revoked|invalid secret|never existed|wrong secret/i)
        expect(wrapper.find('[data-share-mail-list]').exists()).toBe(false)
    })

    it('shows a wait state on 429 from the mailbox, not a dead link', async () => {
        createShareSession.mockResolvedValue({ sessionToken: 'sess-a', mailbox: 'otp@example.com' })
        listShareMails.mockRejectedValue({ name: 'ShareRateLimitedError', status: 429, retryAfter: 12 })

        const wrapper = await mountShare('lid-a', 'sec-a')

        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).not.toBe('unavailable')
        expect(readShareSession('lid-a')).toBe('sess-a')
        expect(wrapper.find('[data-share-wait]').exists()).toBe(true)
        expect(wrapper.get('[data-share-wait]').text()).toMatch(/wait/i)
        expect(wrapper.text()).not.toMatch(/no longer available/i)
    })

    it('re-establishes from the in-memory secret when polling hits SHARE_UNAVAILABLE and does not claim the share is gone (AC-VISIT-12, AC-RT-14, AC-RT-16)', async () => {
        vi.useFakeTimers()
        createShareSession
            .mockResolvedValueOnce({ sessionToken: 'sess-a', mailbox: 'otp@example.com' })
            .mockResolvedValueOnce({ sessionToken: 'sess-b', mailbox: 'otp@example.com' })
        listShareMails
            .mockResolvedValueOnce({
                list: [mail({ mailId: 1, subject: 'Wait for code', code: '111111' })],
                nextCursor: '1'
            })
            .mockRejectedValueOnce({ code: 'SHARE_UNAVAILABLE', message: 'SHARE_UNAVAILABLE' })
            .mockResolvedValue({
                list: [mail({ mailId: 2, subject: 'After recover', code: '222222' })],
                nextCursor: '2'
            })

        const wrapper = await mountShare('lid-a', 'sec-keep')
        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('ready')
        expect(createShareSession).toHaveBeenCalledTimes(1)
        expect(createShareSession).toHaveBeenCalledWith('lid-a', 'sec-keep', expect.objectContaining({
            idempotencyKey: expect.any(String)
        }))
        expect(window.location.hash).toBe('')
        expect(window.location.href).not.toContain('sec-keep')
        expect(JSON.stringify(sessionStorage)).not.toContain('sec-keep')
        expect(readShareSession('lid-a')).toBe('sess-a')

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushPromises()

        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('ready')
        expect(wrapper.text()).not.toMatch(/no longer available/i)
        expect(wrapper.text()).not.toMatch(/timed out/i)
        expect(createShareSession).toHaveBeenCalledTimes(2)
        expect(createShareSession).toHaveBeenLastCalledWith('lid-a', 'sec-keep', expect.objectContaining({
            idempotencyKey: expect.any(String)
        }))
        expect(readShareSession('lid-a')).toBe('sess-b')
        expect(JSON.stringify(sessionStorage)).not.toContain('sec-keep')
        expect(wrapper.get('[data-share-mail-list]').text()).toContain('After recover')
    })

    // T-22b3 · 同一个访客续期不该再扣一个访问名额。后端靠旧 token 认出「还是这个人」,
    // 所以重建时必须把刚过期的那个 token 递下去;首次打开没有旧 token,请求形状不变。
    it('hands the expiring token to the rebuild so a renewal is not counted as a second visitor', async () => {
        vi.useFakeTimers()
        createShareSession
            .mockResolvedValueOnce({ sessionToken: 'sess-a', mailbox: 'otp@example.com' })
            .mockResolvedValueOnce({ sessionToken: 'sess-b', mailbox: 'otp@example.com' })
        listShareMails
            .mockResolvedValueOnce({ list: [], nextCursor: null })
            .mockRejectedValueOnce({ code: 'SHARE_UNAVAILABLE', message: 'SHARE_UNAVAILABLE' })
            .mockResolvedValue({ list: [], nextCursor: null })

        await mountShare('lid-a', 'sec-keep')

        const [, , firstOptions] = createShareSession.mock.calls[0]
        expect(firstOptions.previousSessionToken).toBeFalsy()

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushPromises()

        expect(createShareSession).toHaveBeenCalledTimes(2)
        expect(createShareSession).toHaveBeenLastCalledWith('lid-a', 'sec-keep', expect.objectContaining({
            previousSessionToken: 'sess-a'
        }))
        expect(readShareSession('lid-a')).toBe('sess-b')
    })

    it('shows timed-out, not unavailable, when a stored token dies after reload with no in-memory secret (AC-VISIT-12, AC-VISIT-14)', async () => {
        writeShareSession('lid-a', 'sess-dead')
        listShareMails.mockRejectedValue({ code: 'SHARE_UNAVAILABLE', message: 'SHARE_UNAVAILABLE' })

        const wrapper = await mountShare('lid-a')

        expect(createShareSession).not.toHaveBeenCalled()
        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('timedout')
        expect(wrapper.text()).toMatch(/timed out/i)
        expect(wrapper.text()).toMatch(/original link/i)
        expect(wrapper.text()).not.toMatch(/no longer available/i)
        expect(readShareSession('lid-a')).toBe('')
        expect(wrapper.find('[data-share-mail-list]').exists()).toBe(false)
    })

    it('appends newly polled mail without a click (AC-RT-14)', async () => {
        vi.useFakeTimers()
        createShareSession.mockResolvedValue({ sessionToken: 'sess-a', mailbox: 'otp@example.com' })
        listShareMails
            .mockResolvedValueOnce({ list: [], nextCursor: null })
            .mockResolvedValueOnce({
                list: [mail({ mailId: 22, subject: 'Just arrived', code: '998877' })],
                nextCursor: '22'
            })

        const wrapper = await mountShare('lid-a', 'sec-a')
        expect(wrapper.find('[data-share-empty]').exists()).toBe(true)
        expect(wrapper.text()).not.toContain('Just arrived')

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushPromises()

        expect(wrapper.get('[data-share-mail-list]').text()).toContain('Just arrived')
        expect(wrapper.get('[data-share-code]').text()).toContain('998877')
    })

    it('downloads attachments through /share/attachment and never a storage href (AC-SEC-20)', async () => {
        const blobUrl = 'blob:http://localhost/share-att'
        vi.spyOn(URL, 'createObjectURL').mockReturnValue(blobUrl)
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
        const click = vi.fn()
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(click)
        createShareSession.mockResolvedValue({ sessionToken: 'sess-a', mailbox: 'otp@example.com' })
        listShareMails.mockResolvedValue({
            list: [mail({
                code: '',
                attachments: [{
                    attachmentId: 9,
                    filename: 'invoice.pdf',
                    size: 12,
                    downloadUrl: '/share/attachment?mailId=1&attachmentId=9'
                }]
            })],
            nextCursor: null
        })

        const wrapper = await mountShare('lid-a', 'sec-a')
        const att = wrapper.get('[data-share-attachment]')
        expect(att.attributes('href') || '').not.toMatch(/\/oss\//)
        expect(att.attributes('href') || '').not.toContain('/share/attachment')

        await att.trigger('click')
        await flushPromises()

        expect(getShareAttachment).toHaveBeenCalledWith(expect.objectContaining({
            sessionToken: 'sess-a',
            mailId: 1,
            attachmentId: 9
        }))
        expect(click).toHaveBeenCalled()
    })

    it('does not import logged-in graph modules or third-party script hosts (AC-VISIT-10)', () => {
        for (const file of ['index.vue', 'ShareOtpCard.vue', 'mail-fields.js', 'status-watermark.js']) {
            const src = readFileSync(path.join(process.cwd(), 'src/views/share', file), 'utf8')
            expect(src).not.toMatch(/@\/store\/user/)
            expect(src).not.toMatch(/@\/db\/db/)
            expect(src).not.toMatch(/@\/layout/)
            expect(src).not.toMatch(/@\/axios\/index/)
            expect(src).not.toMatch(/websiteConfig/)
            expect(src).not.toMatch(/<script[^>]+src=["']https?:/)
            expect(src).not.toMatch(/fonts\.googleapis|googletagmanager|gtag\(|sentry\.io|analytics/)
        }
    })

    it('hides the OTP zone when the session config turns extraction off, even though the mail still carries a code (T-24 Fog-2a)', async () => {
        createShareSession.mockResolvedValue({
            sessionToken: 'sess-a',
            mailbox: 'otp@example.com',
            config: { otpExtractionEnabled: false }
        })
        listShareMails.mockResolvedValue({
            list: [mail({ mailId: 31, subject: 'Extraction off', code: '482917' })],
            nextCursor: null
        })

        const wrapper = await mountShare('lid-a', 'sec-a')

        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('ready')
        expect(wrapper.find('[data-share-code]').exists()).toBe(false)
        expect(wrapper.get('[data-share-mail-list]').text()).toContain('Extraction off')
    })

    it('does not carry a stale copy result into the next ready state (T-24 Fog-1)', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        vi.stubGlobal('navigator', {
            ...navigator,
            language: 'en',
            clipboard: { writeText }
        })
        createShareSession.mockResolvedValue({ sessionToken: 'sess-a', mailbox: 'otp@example.com' })
        listShareMails.mockResolvedValue({
            list: [mail()],
            nextCursor: null
        })

        const first = await mountShare('lid-a', 'sec-a')
        await first.get('[data-share-copy]').trigger('click')
        await flushPromises()
        expect(first.get('[data-share-copy-result]').attributes('data-share-copy-result')).toBe('copied')

        first.vm.exitShare()
        await flushPromises()
        expect(first.find('[data-share-copy-result]').exists()).toBe(false)

        const second = await mountShare('lid-a', 'sec-a')

        expect(second.get('[data-share-state]').attributes('data-share-state')).toBe('ready')
        expect(second.get('[data-share-code]').text()).toContain('482917')
        expect(second.find('[data-share-copy-result]').exists()).toBe(false)
    })

    it('reveals the selectable fallback input when both clipboard paths fail (T-24 Fog-3 runtime)', async () => {
        const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
        vi.stubGlobal('navigator', {
            ...navigator,
            language: 'en',
            clipboard: { writeText }
        })
        document.execCommand = () => false
        createShareSession.mockResolvedValue({ sessionToken: 'sess-a', mailbox: 'otp@example.com' })
        listShareMails.mockResolvedValue({
            list: [mail()],
            nextCursor: null
        })

        const wrapper = await mountShare('lid-a', 'sec-a')
        await wrapper.get('[data-share-copy]').trigger('click')
        await flushPromises()

        expect(wrapper.get('.share-otp-select').classes()).toContain('is-visible')
    })

    it('keeps the OTP typography and fallback styles with the card that owns the markup (T-24 Fog-3 source)', () => {
        const card = readFileSync(path.join(process.cwd(), 'src/views/share/ShareOtpCard.vue'), 'utf8')
        expect(card).toMatch(/font-size:\s*32px/)
        expect(card).toMatch(/letter-spacing:\s*0\.12em/)
        expect(card).toMatch(/\.share-otp-select\.is-visible/)

        const src = readFileSync(path.join(process.cwd(), 'src/views/share/index.vue'), 'utf8')
        expect(src).not.toMatch(/\.share-otp\s*\{/)
    })
})

// T-25 · 多邮箱 Tab + 水位角标 + 单实例轮询。
// bindingId 0 是合法键(存量单邮箱形态),所以第一个 Binding 刻意用 0。
function multiSession(overrides = {}) {
    return {
        sessionToken: 'sess-a',
        mailbox: 'first@example.com',
        shareType: 'multi',
        mailboxes: [
            { bindingId: 0, address: 'f***@example.com' },
            { bindingId: 8002, address: 's***@example.com' }
        ],
        ...overrides
    }
}

function statusFrame(mailboxes) {
    return { mailboxes, serverTime: '2026-08-24T00:00:00.000Z' }
}

function tabKeys(wrapper) {
    return wrapper.findAll('[data-share-tab]').map((node) => node.attributes('data-share-tab'))
}

function badgedTabs(wrapper) {
    return wrapper.findAll('[data-share-tab]')
        .filter((node) => node.find('[data-share-tab-badge]').exists())
        .map((node) => node.attributes('data-share-tab'))
}

describe('share view multi-mailbox tabs', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        sessionStorage.clear()
        createShareSession.mockReset()
        listShareMails.mockReset()
        getShareAttachment.mockReset()
        getShareMailboxesStatus.mockReset()
        listShareMails.mockResolvedValue({ list: [], nextCursor: null })
        getShareAttachment.mockResolvedValue(new Blob(['x']))
        getShareMailboxesStatus.mockResolvedValue({ mailboxes: [{ bindingId: 0, latestEmailId: null }] })
    })

    afterEach(() => {
        while (wrappers.length) {
            wrappers.pop().unmount()
        }
        sessionStorage.clear()
        vi.clearAllMocks()
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('renders one tab per masked address for a multi share and none for a single one', async () => {
        createShareSession.mockResolvedValue(multiSession())

        const multi = await mountShare('lid-a', 'sec-a')

        expect(multi.get('[data-share-tabs]').attributes('role')).toBe('tablist')
        expect(tabKeys(multi)).toEqual(['0', '8002'])
        expect(multi.get('[data-share-tab="0"]').text()).toContain('f***@example.com')
        expect(multi.get('[data-share-tab="8002"]').text()).toContain('s***@example.com')
        expect(multi.get('[data-share-tab="0"]').attributes('aria-selected')).toBe('true')
        expect(multi.get('[data-share-tab="8002"]').attributes('aria-selected')).toBe('false')
        // Tab 与整页都不得复读 session 遗留的明文 mailbox（AC-MAIL-08）。
        expect(multi.get('[data-share-tabs]').text()).not.toContain('first@example.com')
        expect(multi.text()).not.toContain('first@example.com')
        expect(multi.get('[data-share-tab="0"]').attributes('tabindex')).toBe('0')
        expect(multi.get('[data-share-tab="8002"]').attributes('tabindex')).toBe('-1')

        createShareSession.mockResolvedValue({ sessionToken: 'sess-b', mailbox: 'only@example.com' })
        const single = await mountShare('lid-b', 'sec-b')

        expect(single.find('[data-share-tabs]').exists()).toBe(false)
        expect(single.get('[data-share-state]').attributes('data-share-state')).toBe('ready')
    })

    it('shows only the active tab mail and swaps the list when another tab is selected', async () => {
        createShareSession.mockResolvedValue(multiSession())
        listShareMails.mockImplementation(async ({ bindingId }) => ({
            list: bindingId === 8002
                ? [mail({ mailId: 52, bindingId: 8002, subject: 'Second box mail', code: '222222' })]
                : [mail({ mailId: 11, bindingId: 0, subject: 'First box mail', code: '111111' })],
            nextCursor: null
        }))

        const wrapper = await mountShare('lid-a', 'sec-a')

        expect(wrapper.get('[data-share-mail-list]').text()).toContain('First box mail')
        expect(wrapper.get('[data-share-mail-list]').text()).not.toContain('Second box mail')
        expect(wrapper.get('[data-share-code]').text()).toContain('111111')

        await wrapper.get('[data-share-tab="8002"]').trigger('click')
        await flushPromises()

        expect(listShareMails).toHaveBeenCalledWith(expect.objectContaining({ bindingId: 8002 }))
        expect(wrapper.get('[data-share-tab="8002"]').attributes('aria-selected')).toBe('true')
        expect(wrapper.get('[data-share-mail-list]').text()).toContain('Second box mail')
        expect(wrapper.get('[data-share-mail-list]').text()).not.toContain('First box mail')
        expect(wrapper.get('[data-share-code]').text()).toContain('222222')
    })

    it('fetches a tab with no cached mail immediately instead of waiting for the next poll (T25-TAB-LOAD)', async () => {
        vi.useFakeTimers()
        createShareSession.mockResolvedValue(multiSession())
        listShareMails.mockResolvedValue({ list: [], nextCursor: null })

        const wrapper = await mountShare('lid-a', 'sec-a')
        listShareMails.mockClear()
        listShareMails.mockResolvedValue({
            list: [mail({ mailId: 52, bindingId: 8002, subject: 'Fetched on select', code: '' })],
            nextCursor: null
        })

        await wrapper.get('[data-share-tab="8002"]').trigger('click')
        await flushPromises()

        expect(listShareMails).toHaveBeenCalledTimes(1)
        expect(listShareMails).toHaveBeenCalledWith(expect.objectContaining({
            sessionToken: 'sess-a',
            bindingId: 8002
        }))
        expect(wrapper.get('[data-share-mail-list]').text()).toContain('Fetched on select')

        // 无新邮件时，已缓存 Tab 再点不取数。
        listShareMails.mockClear()
        await wrapper.get('[data-share-tab="8002"]').trigger('click')
        await flushPromises()
        expect(listShareMails).not.toHaveBeenCalled()
    })

    it('spends exactly one status and one mails call per tick, never one per binding (AC-OTP-07)', async () => {
        vi.useFakeTimers()
        createShareSession.mockResolvedValue(multiSession())
        getShareMailboxesStatus.mockResolvedValue(statusFrame([
            { bindingId: 0, latestEmailId: 11 },
            { bindingId: 8002, latestEmailId: 52 }
        ]))

        const wrapper = await mountShare('lid-a', 'sec-a')
        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('ready')
        listShareMails.mockClear()
        getShareMailboxesStatus.mockClear()

        for (let tick = 1; tick <= 3; tick++) {
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
            await flushPromises()
            expect(getShareMailboxesStatus).toHaveBeenCalledTimes(tick)
            expect(listShareMails).toHaveBeenCalledTimes(tick)
            const askedThisTick = listShareMails.mock.calls.slice(tick - 1).map(([args]) => args.bindingId)
            expect(askedThisTick).toEqual([0])
        }
        expect(new Set(listShareMails.mock.calls.map(([args]) => args.bindingId))).toEqual(new Set([0]))
        expect(listShareMails).not.toHaveBeenCalledWith(expect.objectContaining({ bindingId: 8002 }))
    })

    it('seeds watermarks from the first status frame and badges nothing that predates the visit', async () => {
        vi.useFakeTimers()
        createShareSession.mockResolvedValue(multiSession())
        getShareMailboxesStatus.mockResolvedValue(statusFrame([
            { bindingId: 0, latestEmailId: 11 },
            { bindingId: 8002, latestEmailId: 52 }
        ]))

        const wrapper = await mountShare('lid-a', 'sec-a')
        expect(wrapper.find('[data-share-tab-badge]').exists()).toBe(false)

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushPromises()

        expect(JSON.parse(sessionStorage.getItem('share:status:lid-a'))).toEqual({ 0: 11, 8002: 52 })
        expect(badgedTabs(wrapper)).toEqual([])
    })

    it('badges the sibling that got new mail and not the tab being read (AC-OTP-09)', async () => {
        vi.useFakeTimers()
        createShareSession.mockResolvedValue(multiSession())
        getShareMailboxesStatus.mockResolvedValue(statusFrame([
            { bindingId: 0, latestEmailId: 11 },
            { bindingId: 8002, latestEmailId: 52 }
        ]))
        listShareMails.mockResolvedValue({
            list: [mail({ mailId: 11, bindingId: 0, subject: 'First box mail', code: '' })],
            nextCursor: null
        })

        const wrapper = await mountShare('lid-a', 'sec-a')
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushPromises()
        expect(badgedTabs(wrapper)).toEqual([])

        getShareMailboxesStatus.mockResolvedValue(statusFrame([
            { bindingId: 0, latestEmailId: 12 },
            { bindingId: 8002, latestEmailId: 53 }
        ]))
        listShareMails.mockResolvedValue({
            list: [
                mail({ mailId: 11, bindingId: 0, subject: 'First box mail', code: '' }),
                mail({ mailId: 12, bindingId: 0, subject: 'Fresh here', code: '' })
            ],
            nextCursor: null
        })

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushPromises()

        expect(badgedTabs(wrapper)).toEqual(['8002'])
        expect(wrapper.get('[data-share-tab-badge]').attributes('aria-label')).toMatch(/new mail/i)
        // 水位推进到本页实际最大 mailId,不是 status 的 latestEmailId。
        expect(JSON.parse(sessionStorage.getItem('share:status:lid-a'))).toEqual({ 0: 12, 8002: 52 })
        expect(wrapper.get('[data-share-mail-list]').text()).toContain('Fresh here')

        await wrapper.get('[data-share-tab="8002"]').trigger('click')
        await flushPromises()

        expect(badgedTabs(wrapper)).toEqual([])
    })

    it('keeps the watermark on the page it actually delivered when status runs ahead', async () => {
        vi.useFakeTimers()
        createShareSession.mockResolvedValue(multiSession())
        getShareMailboxesStatus.mockResolvedValue(statusFrame([
            { bindingId: 0, latestEmailId: 11 },
            { bindingId: 8002, latestEmailId: 52 }
        ]))
        listShareMails.mockResolvedValue({ list: [], nextCursor: null })

        const wrapper = await mountShare('lid-a', 'sec-a')
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushPromises()

        getShareMailboxesStatus.mockResolvedValue(statusFrame([
            { bindingId: 0, latestEmailId: 99 },
            { bindingId: 8002, latestEmailId: 52 }
        ]))
        listShareMails.mockResolvedValue({
            list: [mail({ mailId: 12, bindingId: 0, subject: 'Only this arrived', code: '' })],
            nextCursor: null
        })

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushPromises()

        expect(JSON.parse(sessionStorage.getItem('share:status:lid-a'))).toEqual({ 0: 12, 8002: 52 })
        expect(wrapper.get('[data-share-mail-list]').text()).toContain('Only this arrived')
    })

    it('drops a tab the status frame stopped listing and keeps the rest usable (AC-EDGE-04)', async () => {
        vi.useFakeTimers()
        createShareSession.mockResolvedValue(multiSession({
            mailboxes: [
                { bindingId: 0, address: 'f***@example.com' },
                { bindingId: 8002, address: 's***@example.com' },
                { bindingId: 8003, address: 't***@example.com' }
            ]
        }))
        getShareMailboxesStatus.mockResolvedValue(statusFrame([
            { bindingId: 0, latestEmailId: 11 },
            { bindingId: 8002, latestEmailId: 52 },
            { bindingId: 8003, latestEmailId: 71 }
        ]))
        listShareMails.mockImplementation(async ({ bindingId }) => ({
            list: [mail({
                mailId: 11 + Number(bindingId),
                bindingId,
                subject: `Box ${bindingId} mail`,
                code: ''
            })],
            nextCursor: null
        }))

        const wrapper = await mountShare('lid-a', 'sec-a')
        await wrapper.get('[data-share-tab="8003"]').trigger('click')
        await flushPromises()
        expect(tabKeys(wrapper)).toEqual(['0', '8002', '8003'])
        expect(wrapper.get('[data-share-mail-list]').text()).toContain('Box 8003 mail')

        getShareMailboxesStatus.mockResolvedValue(statusFrame([
            { bindingId: 0, latestEmailId: 11 },
            { bindingId: 8002, latestEmailId: 52 }
        ]))

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushPromises()

        expect(tabKeys(wrapper)).toEqual(['0', '8002'])
        expect(wrapper.text()).not.toContain('t***@example.com')
        expect(wrapper.text()).not.toContain('Box 8003 mail')
        expect(wrapper.get('[data-share-tab="0"]').attributes('aria-selected')).toBe('true')
        expect(JSON.parse(sessionStorage.getItem('share:status:lid-a'))).not.toHaveProperty('8003')

        await wrapper.get('[data-share-tab="8002"]').trigger('click')
        await flushPromises()
        expect(wrapper.get('[data-share-mail-list]').text()).toContain('Box 8002 mail')
    })

    it('does not carry the copy confirmation of one mailbox code onto another tab', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        vi.stubGlobal('navigator', { ...navigator, language: 'en', clipboard: { writeText } })
        createShareSession.mockResolvedValue(multiSession())
        listShareMails.mockImplementation(async ({ bindingId }) => ({
            list: bindingId === 8002
                ? [mail({ mailId: 52, bindingId: 8002, subject: 'Second box mail', code: '222222' })]
                : [mail({ mailId: 11, bindingId: 0, subject: 'First box mail', code: '111111' })],
            nextCursor: null
        }))

        const wrapper = await mountShare('lid-a', 'sec-a')
        await wrapper.get('[data-share-copy]').trigger('click')
        await flushPromises()
        expect(writeText).toHaveBeenCalledWith('111111')
        expect(wrapper.get('[data-share-copy-result]').attributes('data-share-copy-result')).toBe('copied')

        await wrapper.get('[data-share-tab="8002"]').trigger('click')
        await flushPromises()

        expect(wrapper.get('[data-share-code]').text()).toContain('222222')
        expect(wrapper.find('[data-share-copy-result]').exists()).toBe(false)
    })

    it('scopes the first page to the active binding and never reuses another lid watermark', async () => {
        sessionStorage.setItem('share:status:lid-other', JSON.stringify({ 0: 999 }))
        createShareSession.mockResolvedValue(multiSession())

        await mountShare('lid-a', 'sec-a')

        expect(listShareMails).toHaveBeenCalledWith(expect.objectContaining({ bindingId: 0 }))
        expect(sessionStorage.getItem('share:status:lid-a')).toBeNull()
    })

    it('advances a tab watermark on the fetch that consumed it, so leaving before the next tick stays quiet (AC-OTP-09)', async () => {
        vi.useFakeTimers()
        createShareSession.mockResolvedValue(multiSession())
        getShareMailboxesStatus.mockResolvedValue(statusFrame([
            { bindingId: 0, latestEmailId: 11 },
            { bindingId: 8002, latestEmailId: 52 }
        ]))
        listShareMails.mockResolvedValue({
            list: [mail({ mailId: 11, bindingId: 0, subject: 'First box mail', code: '' })],
            nextCursor: null
        })

        const wrapper = await mountShare('lid-a', 'sec-a')
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushPromises()

        getShareMailboxesStatus.mockResolvedValue(statusFrame([
            { bindingId: 0, latestEmailId: 11 },
            { bindingId: 8002, latestEmailId: 53 }
        ]))
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushPromises()
        expect(badgedTabs(wrapper)).toEqual(['8002'])

        listShareMails.mockResolvedValue({
            list: [mail({ mailId: 53, bindingId: 8002, subject: 'Sibling fresh', code: '' })],
            nextCursor: null
        })
        await wrapper.get('[data-share-tab="8002"]').trigger('click')
        await flushPromises()
        await wrapper.get('[data-share-tab="0"]').trigger('click')
        await flushPromises()

        expect(JSON.parse(sessionStorage.getItem('share:status:lid-a'))[8002]).toBe(53)
        expect(badgedTabs(wrapper)).toEqual([])
    })

    it('refetches a cached tab when status has already reported newer mail (AC-OTP-09)', async () => {
        vi.useFakeTimers()
        createShareSession.mockResolvedValue(multiSession())
        getShareMailboxesStatus.mockResolvedValue(statusFrame([
            { bindingId: 0, latestEmailId: 11 },
            { bindingId: 8002, latestEmailId: 52 }
        ]))
        listShareMails.mockImplementation(async ({ bindingId }) => ({
            list: bindingId === 8002
                ? [mail({ mailId: 52, bindingId: 8002, subject: 'Cached sibling', code: '' })]
                : [mail({ mailId: 11, bindingId: 0, subject: 'First box mail', code: '' })],
            nextCursor: null
        }))

        const wrapper = await mountShare('lid-a', 'sec-a')
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushPromises()

        await wrapper.get('[data-share-tab="8002"]').trigger('click')
        await flushPromises()
        expect(wrapper.get('[data-share-mail-list]').text()).toContain('Cached sibling')

        await wrapper.get('[data-share-tab="0"]').trigger('click')
        await flushPromises()

        getShareMailboxesStatus.mockResolvedValue(statusFrame([
            { bindingId: 0, latestEmailId: 11 },
            { bindingId: 8002, latestEmailId: 53 }
        ]))
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushPromises()
        expect(badgedTabs(wrapper)).toEqual(['8002'])

        listShareMails.mockClear()
        listShareMails.mockResolvedValue({
            list: [mail({ mailId: 53, bindingId: 8002, subject: 'Sibling fresh', code: '' })],
            nextCursor: null
        })
        await wrapper.get('[data-share-tab="8002"]').trigger('click')
        await flushPromises()

        expect(listShareMails).toHaveBeenCalledTimes(1)
        expect(listShareMails).toHaveBeenCalledWith(expect.objectContaining({ bindingId: 8002 }))
        expect(wrapper.get('[data-share-mail-list]').text()).toContain('Sibling fresh')

        await wrapper.get('[data-share-tab="0"]').trigger('click')
        await flushPromises()
        expect(JSON.parse(sessionStorage.getItem('share:status:lid-a'))[8002]).toBe(53)
        expect(badgedTabs(wrapper)).toEqual([])
    })

    it('hydrates tabs from the first status tick after a stored-token refresh', async () => {
        vi.useFakeTimers()
        writeShareSession('lid-a', 'sess-refresh')
        getShareMailboxesStatus.mockResolvedValue(statusFrame([
            { bindingId: 0, latestEmailId: 11 },
            { bindingId: 8002, latestEmailId: 52 }
        ]))
        listShareMails.mockImplementation(async ({ bindingId }) => ({
            list: bindingId === 8002
                ? [mail({ mailId: 52, bindingId: 8002, subject: 'Second box mail', code: '' })]
                : [mail({ mailId: 11, bindingId: 0, subject: 'First box mail', code: '' })],
            nextCursor: null
        }))

        const wrapper = await mountShare('lid-a')
        expect(createShareSession).not.toHaveBeenCalled()
        expect(wrapper.find('[data-share-tabs]').exists()).toBe(false)

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushPromises()

        expect(tabKeys(wrapper)).toEqual(['0', '8002'])
        expect(wrapper.get('[data-share-mail-list]').text()).toContain('First box mail')
        expect(wrapper.get('[data-share-mail-list]').text()).not.toContain('Second box mail')
        expect(wrapper.text()).not.toContain('first@example.com')
    })
})

// T-26 · 需要 AuthKey 的分享、建会话幂等、刷新策略与会话清理。
const AUTH_REQUIRED = { code: 501, message: 'SHARE_AUTH_REQUIRED' }

function idempotencyKeys() {
    return createShareSession.mock.calls.map(([, , options]) => options && options.idempotencyKey)
}

function sentAuthKeys() {
    return createShareSession.mock.calls.map(([, , options]) => (options && options.authKey) || '')
}

async function submitAuthKey(wrapper, value) {
    await wrapper.get('[data-share-auth-input]').setValue(value)
    await wrapper.get('[data-share-auth]').trigger('submit')
    await flushPromises()
}

describe('share view visitor auth key', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        sessionStorage.clear()
        createShareSession.mockReset()
        listShareMails.mockReset()
        getShareAttachment.mockReset()
        getShareMailboxesStatus.mockReset()
        listShareMails.mockResolvedValue({ list: [], nextCursor: null })
        getShareAttachment.mockResolvedValue(new Blob(['x']))
        getShareMailboxesStatus.mockResolvedValue({ mailboxes: [{ bindingId: 0, latestEmailId: null }] })
    })

    afterEach(() => {
        while (wrappers.length) {
            wrappers.pop().unmount()
        }
        sessionStorage.clear()
        vi.clearAllMocks()
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('asks for the access key instead of declaring the link dead (AC-AUTH-01)', async () => {
        createShareSession.mockRejectedValue(AUTH_REQUIRED)

        const wrapper = await mountShare('lid-a', 'sec-a')

        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('authRequired')
        // 信封已经回来了,重发只会白烧一个会话名额。
        expect(createShareSession).toHaveBeenCalledTimes(1)
        expect(readShareSession('lid-a')).toBe('')
        expect(wrapper.find('[data-share-auth]').exists()).toBe(true)
        expect(wrapper.find('[data-share-auth-input]').exists()).toBe(true)
        expect(wrapper.find('[data-share-body]').exists()).toBe(true)
        expect(wrapper.find('[data-share-auth-error]').exists()).toBe(false)
        expect(wrapper.find('[data-share-wait]').exists()).toBe(false)
        expect(wrapper.text()).not.toMatch(/no longer available|timed out/i)
        // 空输入不能提交。
        expect(wrapper.get('[data-share-auth-submit]').attributes('disabled')).toBeDefined()
    })

    it('labels the key field visibly and keeps the mobile keyboard from mangling it', async () => {
        createShareSession.mockRejectedValue(AUTH_REQUIRED)

        const wrapper = await mountShare('lid-a', 'sec-a')

        const input = wrapper.get('[data-share-auth-input]')
        const id = input.attributes('id')
        expect(id).toBeTruthy()
        expect(wrapper.get(`label[for="${id}"]`).text()).toBeTruthy()
        // AuthKey 是大小写敏感的定长串:移动端自动首字母大写会稳定毁掉第一次输入。
        expect(input.attributes('autocapitalize')).toBe('none')
        expect(input.attributes('autocomplete')).toBe('off')
        expect(input.attributes('spellcheck')).toBe('false')
        expect(input.attributes('type')).toBe('text')
    })

    it('lets a wrong key be retried and keeps the same idempotency key, without leaking either secret (AC-AUTH-01, AC-SEC-09)', async () => {
        createShareSession
            .mockRejectedValueOnce(AUTH_REQUIRED)
            .mockRejectedValueOnce(AUTH_REQUIRED)
            .mockResolvedValueOnce({ sessionToken: 'sess-a', mailbox: 'otp@example.com' })
        const lines = []
        const capture = (...args) => {
            lines.push(flattenLogged(args))
        }
        const log = vi.spyOn(console, 'log').mockImplementation(capture)
        const error = vi.spyOn(console, 'error').mockImplementation(capture)
        const warn = vi.spyOn(console, 'warn').mockImplementation(capture)
        const info = vi.spyOn(console, 'info').mockImplementation(capture)

        try {
            const wrapper = await mountShare('lid-a', 'sec-a')

            await submitAuthKey(wrapper, 'wrong-key-aaaa')

            expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('authRequired')
            expect(wrapper.get('[data-share-auth-error]').text()).toBeTruthy()
            // 无锁定、无冷却、无「还剩 N 次」。
            expect(wrapper.text()).not.toMatch(/attempt|remaining|locked|too many/i)
            expect(wrapper.get('[data-share-auth-input]').attributes('disabled')).toBeUndefined()

            await submitAuthKey(wrapper, 'right-key-bbbb')

            expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('ready')
            expect(createShareSession).toHaveBeenCalledTimes(3)
            expect(sentAuthKeys()).toEqual(['', 'wrong-key-aaaa', 'right-key-bbbb'])
            const keys = idempotencyKeys()
            expect(keys[0]).toEqual(expect.any(String))
            expect(new Set(keys).size).toBe(1)
            // 成功之后这个去重标签就没用了。
            expect(sessionStorage.getItem('share:est-key:lid-a')).toBeNull()

            const stored = JSON.stringify(sessionStorage)
            const joined = lines.join('\n')
            for (const secret of ['wrong-key-aaaa', 'right-key-bbbb', 'sec-a']) {
                expect(stored).not.toContain(secret)
                expect(joined).not.toContain(secret)
            }
            expect(window.location.href).not.toContain('right-key-bbbb')
        } finally {
            log.mockRestore()
            error.mockRestore()
            warn.mockRestore()
            info.mockRestore()
        }
    })

    it('treats a 429 on the key submit as wait, not as a wrong key (AC-AUTH-06)', async () => {
        createShareSession
            .mockRejectedValueOnce(AUTH_REQUIRED)
            .mockRejectedValueOnce({ name: 'ShareRateLimitedError', status: 429, retryAfter: 12 })

        const wrapper = await mountShare('lid-a', 'sec-a')
        await submitAuthKey(wrapper, 'some-key')

        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('authRequired')
        expect(wrapper.get('[data-share-wait]').text()).toMatch(/wait/i)
        expect(wrapper.find('[data-share-auth-error]').exists()).toBe(false)
        // 429 是运输层的节流,重发只会加重限流。
        expect(createShareSession).toHaveBeenCalledTimes(2)
    })
})

describe('share view session idempotency', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        sessionStorage.clear()
        createShareSession.mockReset()
        listShareMails.mockReset()
        getShareAttachment.mockReset()
        getShareMailboxesStatus.mockReset()
        listShareMails.mockResolvedValue({ list: [], nextCursor: null })
        getShareAttachment.mockResolvedValue(new Blob(['x']))
        getShareMailboxesStatus.mockResolvedValue({ mailboxes: [{ bindingId: 0, latestEmailId: null }] })
    })

    afterEach(() => {
        while (wrappers.length) {
            wrappers.pop().unmount()
        }
        sessionStorage.clear()
        vi.clearAllMocks()
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('stores the idempotency key before the request leaves and clears it once a token arrives (AC-SESS-10)', async () => {
        const keyAtCallTime = []
        createShareSession.mockImplementation(async () => {
            keyAtCallTime.push(sessionStorage.getItem('share:est-key:lid-a'))
            return { sessionToken: 'sess-a', mailbox: 'otp@example.com' }
        })

        await mountShare('lid-a', 'sec-a')

        expect(keyAtCallTime).toEqual([idempotencyKeys()[0]])
        expect(keyAtCallTime[0]).toMatch(/^[0-9a-f]{32}$/)
        expect(sessionStorage.getItem('share:est-key:lid-a')).toBeNull()
    })

    it('replays a lost response once under the same key instead of spending a second session (AC-SESS-10)', async () => {
        createShareSession
            .mockRejectedValueOnce(new Error('Network Error'))
            .mockResolvedValueOnce({ sessionToken: 'sess-a', mailbox: 'otp@example.com' })

        const wrapper = await mountShare('lid-a', 'sec-a')

        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('ready')
        expect(createShareSession).toHaveBeenCalledTimes(2)
        const keys = idempotencyKeys()
        expect(keys[0]).toMatch(/^[0-9a-f]{32}$/)
        expect(keys[1]).toBe(keys[0])
        expect(sessionStorage.getItem('share:est-key:lid-a')).toBeNull()
        expect(readShareSession('lid-a')).toBe('sess-a')
    })

    it('gives up after one replay rather than hammering an unreachable worker', async () => {
        createShareSession.mockRejectedValue(new Error('Network Error'))

        const wrapper = await mountShare('lid-a', 'sec-a')

        expect(createShareSession).toHaveBeenCalledTimes(2)
        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('unavailable')
    })

    it('does not replay a 429 or a business envelope, which both mean the worker answered', async () => {
        createShareSession.mockRejectedValue({ name: 'ShareRateLimitedError', status: 429 })
        const limited = await mountShare('lid-a', 'sec-a')
        expect(createShareSession).toHaveBeenCalledTimes(1)
        expect(limited.get('[data-share-state]').attributes('data-share-state')).toBe('limited')

        createShareSession.mockReset()
        createShareSession.mockRejectedValue({ code: 501, message: 'SHARE_UNAVAILABLE' })
        const dead = await mountShare('lid-b', 'sec-b')
        expect(createShareSession).toHaveBeenCalledTimes(1)
        expect(dead.get('[data-share-state]').attributes('data-share-state')).toBe('unavailable')
    })
})

describe('share view refresh policy', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        sessionStorage.clear()
        createShareSession.mockReset()
        listShareMails.mockReset()
        getShareAttachment.mockReset()
        getShareMailboxesStatus.mockReset()
        listShareMails.mockResolvedValue({ list: [], nextCursor: null })
        getShareAttachment.mockResolvedValue(new Blob(['x']))
        getShareMailboxesStatus.mockResolvedValue({ mailboxes: [{ bindingId: 0, latestEmailId: null }] })
    })

    afterEach(() => {
        while (wrappers.length) {
            wrappers.pop().unmount()
        }
        sessionStorage.clear()
        vi.clearAllMocks()
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('polls nothing and offers a manual refresh when autoRefresh is off (AC-OTP-05)', async () => {
        vi.useFakeTimers()
        createShareSession.mockResolvedValue({
            sessionToken: 'sess-a',
            mailbox: 'otp@example.com',
            config: { autoRefresh: false }
        })

        const wrapper = await mountShare('lid-a', 'sec-a')
        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('ready')
        expect(wrapper.find('[data-share-refresh]').exists()).toBe(true)
        listShareMails.mockClear()
        getShareMailboxesStatus.mockClear()

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 20)
        await flushPromises()

        expect(getShareMailboxesStatus).not.toHaveBeenCalled()
        expect(listShareMails).not.toHaveBeenCalled()

        // 一次点击 = 一拍:1 次 status + 1 次 mails,与自动轮询同形。
        await wrapper.get('[data-share-refresh]').trigger('click')
        await flushPromises()

        expect(getShareMailboxesStatus).toHaveBeenCalledTimes(1)
        expect(listShareMails).toHaveBeenCalledTimes(1)
        expect(listShareMails).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: 'sess-a' }))
    })

    it('merges what a manual refresh returned and keeps the token when it hits a 429', async () => {
        createShareSession.mockResolvedValue({
            sessionToken: 'sess-a',
            mailbox: 'otp@example.com',
            config: { autoRefresh: false }
        })

        const wrapper = await mountShare('lid-a', 'sec-a')
        listShareMails.mockResolvedValue({
            list: [mail({ mailId: 41, subject: 'Pulled by hand', code: '' })],
            nextCursor: null
        })

        await wrapper.get('[data-share-refresh]').trigger('click')
        await flushPromises()
        expect(wrapper.get('[data-share-mail-list]').text()).toContain('Pulled by hand')

        getShareMailboxesStatus.mockRejectedValue({ name: 'ShareRateLimitedError', status: 429, retryAfter: 9 })
        await wrapper.get('[data-share-refresh]').trigger('click')
        await flushPromises()

        expect(wrapper.get('[data-share-wait]').text()).toMatch(/wait/i)
        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('ready')
        expect(readShareSession('lid-a')).toBe('sess-a')
        expect(wrapper.find('[data-share-refresh]').exists()).toBe(true)
    })

    it('honours a session refreshIntervalMs that only arrives after setup (AC-OTP-05)', async () => {
        vi.useFakeTimers()
        createShareSession.mockResolvedValue({
            sessionToken: 'sess-a',
            mailbox: 'otp@example.com',
            config: { refreshIntervalMs: 8000 }
        })

        const wrapper = await mountShare('lid-a', 'sec-a')
        expect(wrapper.find('[data-share-refresh]').exists()).toBe(false)
        listShareMails.mockClear()
        getShareMailboxesStatus.mockClear()

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushPromises()
        expect(getShareMailboxesStatus).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(5000)
        await flushPromises()
        expect(getShareMailboxesStatus).toHaveBeenCalledTimes(1)
        expect(listShareMails).toHaveBeenCalledTimes(1)
    })

    it('clamps a downstream interval below the floor back up to it, so the visitor never self-DoSes', async () => {
        vi.useFakeTimers()
        createShareSession.mockResolvedValue({
            sessionToken: 'sess-a',
            mailbox: 'otp@example.com',
            config: { refreshIntervalMs: 10 }
        })

        await mountShare('lid-a', 'sec-a')
        getShareMailboxesStatus.mockClear()

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1)
        expect(getShareMailboxesStatus).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(1)
        await flushPromises()
        expect(getShareMailboxesStatus).toHaveBeenCalledTimes(1)
    })

    // Fog-3:复活路径拿不到 config,刷新策略与倒计时按缺省降级 —— 这是已知限制,不是回归。
    it('revives a stored token without spending a session, an establish key or a countdown (AC-SESS-03)', async () => {
        vi.useFakeTimers()
        writeShareSession('lid-a', 'sess-refresh')

        const wrapper = await mountShare('lid-a')

        expect(createShareSession).not.toHaveBeenCalled()
        expect(sessionStorage.getItem('share:est-key:lid-a')).toBeNull()
        expect(wrapper.find('[data-share-expires]').exists()).toBe(false)
        expect(wrapper.find('[data-share-refresh]').exists()).toBe(false)

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushPromises()
        expect(getShareMailboxesStatus).toHaveBeenCalledTimes(1)
    })
})

describe('share view expiry countdown and cleanup', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        sessionStorage.clear()
        createShareSession.mockReset()
        listShareMails.mockReset()
        getShareAttachment.mockReset()
        getShareMailboxesStatus.mockReset()
        listShareMails.mockResolvedValue({ list: [], nextCursor: null })
        getShareAttachment.mockResolvedValue(new Blob(['x']))
        getShareMailboxesStatus.mockResolvedValue({ mailboxes: [{ bindingId: 0, latestEmailId: null }] })
    })

    afterEach(() => {
        while (wrappers.length) {
            wrappers.pop().unmount()
        }
        sessionStorage.clear()
        vi.clearAllMocks()
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    // expires_at 是 worker 用 UTC 写下的裸字符串。浏览器把它当本地时间解析,东八区访客
    // 的倒计时就会凭空多出 8 小时,所以这条测试刻意在非 UTC 时区里跑。
    it('reads expiresAt as UTC, not as the visitor local time', async () => {
        const original = process.env.TZ
        process.env.TZ = 'Asia/Shanghai'
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-08-24T12:00:00Z'))
        try {
            createShareSession.mockResolvedValue({
                sessionToken: 'sess-a',
                mailbox: 'otp@example.com',
                expiresAt: '2026-08-24 12:30:00'
            })

            const wrapper = await mountShare('lid-a', 'sec-a')

            const node = wrapper.get('[data-share-expires]')
            expect(node.attributes('datetime')).toBe('2026-08-24T12:30:00.000Z')
            expect(node.text()).toMatch(/30m/)
            // 每秒播报剩余时间是读屏灾难。
            expect(node.attributes('aria-live')).toBeUndefined()

            await vi.advanceTimersByTimeAsync(60_000)
            expect(wrapper.get('[data-share-expires]').text()).toMatch(/29m/)
        } finally {
            if (original === undefined) {
                delete process.env.TZ
            } else {
                process.env.TZ = original
            }
        }
    })

    it('renders no countdown at all when the session carries no expiresAt', async () => {
        createShareSession.mockResolvedValue({ sessionToken: 'sess-a', mailbox: 'otp@example.com' })

        const wrapper = await mountShare('lid-a', 'sec-a')

        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('ready')
        expect(wrapper.find('[data-share-expires]').exists()).toBe(false)
        expect(wrapper.text()).not.toContain('--')
    })

    // 倒计时节点挂在 header 上、只看 expiresLabel 不看 state,所以死壳态必须把 expiresAt 一起清掉,
    // 否则访客会盯着一个"还有 30 分钟"的链接读"此链接已不可用"。
    it('drops the countdown when the share turns out to be gone', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-08-24T12:00:00Z'))
        createShareSession.mockResolvedValue({
            sessionToken: 'sess-a',
            mailbox: 'otp@example.com',
            expiresAt: '2026-08-24 12:30:00'
        })

        const wrapper = await mountShare('lid-a', 'sec-a')
        expect(wrapper.get('[data-share-expires]').text()).toMatch(/30m/)

        await wrapper.vm.noteShareFailure({ code: 'SHARE_UNAVAILABLE', message: 'SHARE_UNAVAILABLE' }, true)
        await flushPromises()

        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('unavailable')
        expect(wrapper.find('[data-share-expires]').exists()).toBe(false)
    })

    it('drops the countdown when the visitor leaves the share', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-08-24T12:00:00Z'))
        createShareSession.mockResolvedValue({
            sessionToken: 'sess-a',
            mailbox: 'otp@example.com',
            expiresAt: '2026-08-24 12:30:00'
        })

        const wrapper = await mountShare('lid-a', 'sec-a')
        expect(wrapper.get('[data-share-expires]').text()).toMatch(/30m/)

        await wrapper.get('[data-share-exit]').trigger('click')
        await flushPromises()

        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('exited')
        expect(wrapper.find('[data-share-expires]').exists()).toBe(false)
    })

    it('drops the session and the establish key on unmount but keeps the read watermark (AC-SEC-07)', async () => {
        createShareSession.mockRejectedValue(AUTH_REQUIRED)
        writeShareSession('lid-a', 'stale-token')
        sessionStorage.setItem('share:status:lid-a', '{"0":7}')

        const wrapper = await mountShare('lid-a', 'sec-a')
        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('authRequired')
        expect(sessionStorage.getItem('share:est-key:lid-a')).not.toBeNull()

        wrappers.pop()
        wrapper.unmount()

        expect(sessionStorage.getItem('share:session:lid-a')).toBeNull()
        expect(sessionStorage.getItem('share:est-key:lid-a')).toBeNull()
        // 水位是已读进度不是凭据:清掉只会丢失跨会话未读(T-25 红线)。
        expect(sessionStorage.getItem('share:status:lid-a')).toBe('{"0":7}')
    })

    it('drops both session keys on SHARE_UNAVAILABLE but keeps the read watermark (AC-SEC-07)', async () => {
        writeShareSession('lid-a', 'sess-a')
        sessionStorage.setItem('share:status:lid-a', '{"0":7}')

        const wrapper = await mountShare('lid-a')
        sessionStorage.setItem('share:est-key:lid-a', 'leftover-from-a-failed-establish')

        await wrapper.vm.noteShareFailure({ code: 'SHARE_UNAVAILABLE', message: 'SHARE_UNAVAILABLE' }, true)
        await flushPromises()

        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('unavailable')
        expect(sessionStorage.getItem('share:session:lid-a')).toBeNull()
        expect(sessionStorage.getItem('share:est-key:lid-a')).toBeNull()
        expect(sessionStorage.getItem('share:status:lid-a')).toBe('{"0":7}')
    })

    it('drops both session keys when the visitor leaves the share (AC-SEC-07)', async () => {
        writeShareSession('lid-a', 'sess-a')
        sessionStorage.setItem('share:status:lid-a', '{"0":7}')

        const wrapper = await mountShare('lid-a')
        sessionStorage.setItem('share:est-key:lid-a', 'leftover-from-a-failed-establish')

        await wrapper.get('[data-share-exit]').trigger('click')
        await flushPromises()

        expect(wrapper.get('[data-share-state]').attributes('data-share-state')).toBe('exited')
        expect(sessionStorage.getItem('share:session:lid-a')).toBeNull()
        expect(sessionStorage.getItem('share:est-key:lid-a')).toBeNull()
        expect(sessionStorage.getItem('share:status:lid-a')).toBe('{"0":7}')
    })
})
