import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { useEmailStore } from '@/store/email.js'
import { useSettingStore } from '@/store/setting.js'
import en from '@/i18n/en.js'

vi.mock('vue-router', () => ({
    useRouter: () => ({ back: vi.fn() })
}))

vi.mock('element-plus', () => {
    const slotStub = { template: '<div><slot /></div>' }
    return {
        ElMessage: vi.fn(),
        ElMessageBox: { confirm: vi.fn(() => Promise.resolve()) },
        ElAlert: slotStub,
        ElScrollbar: { template: '<div class="el-scrollbar-stub"><slot /></div>' },
        ElImageViewer: slotStub,
        ElButton: { template: '<button type="button"><slot /></button>' }
    }
})

vi.mock('@iconify/vue', () => ({
    Icon: { name: 'Icon', template: '<span />' }
}))

vi.mock('@/request/email.js', () => ({
    emailDelete: vi.fn(),
    emailRead: vi.fn()
}))

vi.mock('@/request/star.js', () => ({
    starAdd: vi.fn(),
    starCancel: vi.fn()
}))

vi.mock('@/request/all-email.js', () => ({
    allEmailDelete: vi.fn()
}))

setActivePinia(createPinia())
const { default: ContentView } = await import('@/views/content/index.vue')

const SafeMailStub = {
    name: 'SafeMailRenderer',
    props: {
        text: { type: String, default: '' },
        html: { type: String, default: '' },
        content: { type: String, default: '' },
        height: { type: String, default: '72vh' },
        defaultMode: { type: String, default: 'text' }
    },
    template: '<div class="safe-mail-stub" />'
}

const stubs = {
    Icon: true,
    SafeMailRenderer: SafeMailStub,
    ShadowHtml: {
        name: 'ShadowHtml',
        props: ['html'],
        template: '<div class="shadow-html" />'
    },
    'el-scrollbar': { template: '<div class="el-scrollbar-stub"><slot /></div>' },
    'el-alert': true,
    'el-image-viewer': true,
    'el-button': { template: '<button type="button"><slot /></button>' }
}

function sampleEmail(overrides = {}) {
    return {
        emailId: 41,
        subject: 'Detail',
        name: 'Sender',
        sendEmail: 'sender@example.com',
        recipient: JSON.stringify([{ address: 'me@example.com' }]),
        createTime: 1700000000000,
        status: 1,
        message: '',
        content: '',
        text: '',
        attList: [],
        isStar: 0,
        unread: 0,
        ...overrides
    }
}

function mountContent(emailOverrides = {}) {
    const pinia = createPinia()
    setActivePinia(pinia)
    useEmailStore().contentData.email = sampleEmail(emailOverrides)
    useSettingStore().settings.r2Domain = 'cdn.example.com'
    const i18n = createI18n({
        legacy: false,
        locale: 'en',
        messages: { en }
    })
    return mount(ContentView, {
        global: {
            plugins: [pinia, i18n],
            stubs,
            directives: {
                perm: () => {}
            }
        }
    })
}

describe('logged-in mail detail renderer (AC-SEC-10)', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
    })

    it('uses SafeMailRenderer instead of ShadowHtml after XSS fix 2026-08-17', () => {
        const wrapper = mountContent({
            content: '<p onclick="alert(1)">hello</p>',
            text: 'hello'
        })
        expect(wrapper.findComponent({ name: 'SafeMailRenderer' }).exists()).toBe(true)
        expect(wrapper.findComponent({ name: 'ShadowHtml' }).exists()).toBe(false)
        expect(wrapper.find('.shadow-html').exists()).toBe(false)
    })

    it('rewrites {{domain}} on HTML before it reaches the sandboxed renderer', () => {
        const wrapper = mountContent({
            content: '<img src="{{domain}}inline/a.png" alt="cid">',
            text: 'photo'
        })
        const renderer = wrapper.findComponent({ name: 'SafeMailRenderer' })
        expect(renderer.props('html')).toBe(
            '<img src="https://cdn.example.com/inline/a.png" alt="cid">'
        )
        expect(renderer.props('text')).toBe('photo')
    })

    it('keeps HTML-only mail on SafeMailRenderer when text is empty (AC-SEC-24)', () => {
        const wrapper = mountContent({
            content: '<table><tr><td>OTP 482917</td></tr></table>',
            text: ''
        })
        const renderer = wrapper.findComponent({ name: 'SafeMailRenderer' })
        expect(renderer.exists()).toBe(true)
        expect(renderer.props('html')).toContain('OTP 482917')
        expect(renderer.props('text')).toBe('')
        expect(wrapper.find('pre.email-text').exists()).toBe(false)
    })

    it('asks SafeMailRenderer for HTML as the logged-in default', () => {
        const wrapper = mountContent({
            content: '<table><tr><td>Acme Weekly</td></tr></table>',
            text: 'Weekly digest'
        })
        const renderer = wrapper.findComponent({ name: 'SafeMailRenderer' })
        expect(renderer.props('defaultMode')).toBe('html')
    })

    it('passes plain-text-only mail into SafeMailRenderer instead of a host pre', () => {
        const wrapper = mountContent({
            content: '',
            text: 'Just text\n> quoted'
        })
        const renderer = wrapper.findComponent({ name: 'SafeMailRenderer' })
        expect(renderer.exists()).toBe(true)
        expect(renderer.props('html')).toBe('')
        expect(renderer.props('text')).toBe('Just text\n> quoted')
        expect(wrapper.find('pre.email-text').exists()).toBe(false)
    })
})
