import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/en.js'
import zh from '@/i18n/zh.js'
import ShareOtpCard from './ShareOtpCard.vue'

const wrappers = []

function mail(overrides = {}) {
    return {
        mailId: 1,
        senderName: 'GitHub',
        senderAddress: 'noreply@github.com',
        subject: 'Your verification code',
        ...overrides
    }
}

function mountCard(props = {}) {
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en, zh } })
    const wrapper = mount(ShareOtpCard, {
        props: { enabled: true, selected: null, ...props },
        global: { plugins: [i18n] }
    })
    wrappers.push(wrapper)
    return wrapper
}

describe('ShareOtpCard', () => {
    beforeEach(() => {
        vi.stubGlobal('navigator', {
            ...navigator,
            clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
        })
    })

    afterEach(() => {
        while (wrappers.length) {
            wrappers.pop().unmount()
        }
        vi.clearAllMocks()
        vi.unstubAllGlobals()
    })

    // 用户报告的 bug:切到第一封没有验证码的邮件,顶部还挂着第二封的码。
    it('never shows another mail code when the selected mail has none', () => {
        const wrapper = mountCard({
            selected: mail({ mailId: 1, code: '' }),
            mails: [
                mail({ mailId: 1, code: '' }),
                mail({ mailId: 2, code: '999999' })
            ]
        })

        expect(wrapper.text()).not.toContain('999999')
        expect(wrapper.find('[data-share-code]').exists()).toBe(false)
        expect(wrapper.get('[data-share-nothing-found]').text()).toBe(en.shareVisitNothingFound)
    })

    it('shows the code block when only the code is present', () => {
        const wrapper = mountCard({ selected: mail({ code: '482917' }) })

        expect(wrapper.get('[data-share-code]').text()).toContain('482917')
        expect(wrapper.find('[data-share-link]').exists()).toBe(false)
        expect(wrapper.find('[data-share-nothing-found]').exists()).toBe(false)
    })

    it('shows the link block when only the link is present', () => {
        const wrapper = mountCard({
            selected: mail({ link: 'https://example.com/verify?token=abc' })
        })

        expect(wrapper.find('[data-share-code]').exists()).toBe(false)
        expect(wrapper.get('[data-share-link]').exists()).toBe(true)
        expect(wrapper.find('[data-share-nothing-found]').exists()).toBe(false)
    })

    it('shows both blocks when the mail carries a code and a link', () => {
        const wrapper = mountCard({
            selected: mail({ code: '482917', link: 'https://example.com/verify' })
        })

        expect(wrapper.get('[data-share-code]').text()).toContain('482917')
        expect(wrapper.get('[data-share-link-url]').text()).toBe('https://example.com/verify')
    })

    // 开关关闭时后端根本不下发这两个键(不是 null),所以缺键必须走"未识别"。
    it('shows the not-found line when neither key is present at all', () => {
        const wrapper = mountCard({ selected: mail() })

        expect(wrapper.get('[data-share-nothing-found]').text()).toBe(en.shareVisitNothingFound)
    })

    it('renders nothing at all when extraction display is disabled', () => {
        const wrapper = mountCard({
            enabled: false,
            selected: mail({ code: '482917', link: 'https://example.com/verify' })
        })

        expect(wrapper.find('[data-share-code]').exists()).toBe(false)
        expect(wrapper.find('[data-share-link]').exists()).toBe(false)
        expect(wrapper.find('[data-share-nothing-found]').exists()).toBe(false)
    })

    it('keeps neither the previous value nor the previous copy state after switching mail', async () => {
        const wrapper = mountCard({ selected: mail({ mailId: 1, code: '111111', link: 'https://a.example.com/v' }) })

        await wrapper.get('[data-share-copy]').trigger('click')
        await flushPromises()
        expect(wrapper.get('[data-share-copy-result]').attributes('data-share-copy-result')).toBe('copied')

        await wrapper.setProps({ selected: mail({ mailId: 2, code: '', link: '' }) })

        expect(wrapper.text()).not.toContain('111111')
        expect(wrapper.text()).not.toContain('a.example.com')
        expect(wrapper.find('[data-share-copy-result]').exists()).toBe(false)
        expect(wrapper.get('[data-share-nothing-found]').exists()).toBe(true)
    })

    // 正文是攻击者可控的,展示层是独立于后端的第二道防线。
    it.each([
        ['javascript:alert(1)'],
        ['data:text/html,<script>alert(1)</script>'],
        ['file:///etc/passwd'],
        ['/relative/verify']
    ])('does not render %s as a clickable entry point', (href) => {
        const wrapper = mountCard({ selected: mail({ link: href }) })

        expect(wrapper.find('[data-share-link]').exists()).toBe(false)
        expect(wrapper.findAll('a').length).toBe(0)
        expect(wrapper.get('[data-share-nothing-found]').exists()).toBe(true)
    })

    it('opens the link in a new window with noopener noreferrer and shows the whole URL', () => {
        const url = 'https://example.com/verify?token=abc&id=42'
        const wrapper = mountCard({ selected: mail({ link: url }) })

        const anchor = wrapper.get('[data-share-link-url]')
        expect(anchor.attributes('href')).toBe(url)
        expect(anchor.attributes('target')).toBe('_blank')
        const rel = (anchor.attributes('rel') || '').split(/\s+/)
        expect(rel).toContain('noopener')
        expect(rel).toContain('noreferrer')
        // 完整 URL 必须可见,不能只给一个按钮。
        expect(anchor.text()).toBe(url)
    })

    // 措辞只陈述来源,不做安全断言。
    it('labels the link by where it came from and never calls it safe', () => {
        const wrapper = mountCard({ selected: mail({ link: 'https://example.com/verify' }) })

        const text = wrapper.get('[data-share-link]').text()
        expect(text).toContain(en.shareVisitLink)
        expect(text).not.toMatch(/safe|trusted|secure|official/i)
    })

    it('copies the selected mail code and falls back to a selectable input when the clipboard is unusable', async () => {
        vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
        document.execCommand = () => false

        const wrapper = mountCard({ selected: mail({ code: '482917' }) })
        await wrapper.get('[data-share-copy]').trigger('click')
        await flushPromises()

        expect(wrapper.get('[data-share-copy-result]').attributes('data-share-copy-result')).toBe('manual')
        expect(wrapper.get('.share-otp-select').classes()).toContain('is-visible')
        expect(wrapper.get('.share-otp-select').attributes('value') ?? wrapper.get('.share-otp-select').element.value).toBe('482917')
    })
})
