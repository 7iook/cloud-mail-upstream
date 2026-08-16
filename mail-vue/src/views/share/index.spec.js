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

const { createShareSession: createShareSessionMock, listShareMails, getShareAttachment } = vi.hoisted(() => ({
    createShareSession: vi.fn(),
    listShareMails: vi.fn(),
    getShareAttachment: vi.fn()
}))

vi.mock('@/request/share.js', async (importOriginal) => {
    const actual = await importOriginal()
    return {
        ...actual,
        createShareSession: createShareSessionMock,
        listShareMails,
        getShareAttachment
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
        listShareMails.mockResolvedValue({ list: [], nextCursor: null })
        getShareAttachment.mockResolvedValue(new Blob(['x']))
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
        expect(createShareSession).toHaveBeenCalledWith('lid-a', 'sec-a')
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
        listShareMails.mockResolvedValue({ list: [], nextCursor: null })
        getShareAttachment.mockResolvedValue(new Blob(['x']))
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
        expect(createShareSession).toHaveBeenCalledWith('lid-a', 'sec-keep')
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
        expect(createShareSession).toHaveBeenLastCalledWith('lid-a', 'sec-keep')
        expect(readShareSession('lid-a')).toBe('sess-b')
        expect(JSON.stringify(sessionStorage)).not.toContain('sec-keep')
        expect(wrapper.get('[data-share-mail-list]').text()).toContain('After recover')
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
        const src = readFileSync(path.join(process.cwd(), 'src/views/share/index.vue'), 'utf8')
        expect(src).not.toMatch(/@\/store\/user/)
        expect(src).not.toMatch(/@\/db\/db/)
        expect(src).not.toMatch(/@\/layout/)
        expect(src).not.toMatch(/@\/axios\/index/)
        expect(src).not.toMatch(/websiteConfig/)
        expect(src).not.toMatch(/<script[^>]+src=["']https?:/)
        expect(src).not.toMatch(/fonts\.googleapis|googletagmanager|gtag\(|sentry\.io|analytics/)
    })
})
