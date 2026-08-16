import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import SafeMailRenderer from './index.vue'
import { IFRAME_SANDBOX } from './srcdoc.js'

const BOTH = {
    text: 'Weekly digest: 3 unread alerts.',
    html: '<table width="600"><tr><td>Acme Weekly</td></tr></table>'
}

function mountMail(props) {
    const i18n = createI18n({
        legacy: false,
        locale: 'en',
        messages: { en: {} }
    })
    return mount(SafeMailRenderer, {
        props,
        global: {
            plugins: [i18n],
            stubs: {
                'el-button': {
                    props: ['type', 'size', 'disabled'],
                    template: '<button type="button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>'
                },
                'el-alert': {
                    props: ['title', 'type', 'closable'],
                    template: '<div class="el-alert-stub" role="status">{{ title }}</div>'
                }
            }
        }
    })
}

describe('SafeMailRenderer per-consumer default (AC-SEC-01, AC-SEC-24)', () => {
    it('share-style default stays plain text when both parts exist', () => {
        const wrapper = mountMail(BOTH)
        expect(wrapper.find('pre.safe-mail-text').exists()).toBe(true)
        expect(wrapper.find('iframe.safe-mail-frame').exists()).toBe(false)
    })

    it('logged-in defaultMode html shows the sandbox iframe immediately', () => {
        const wrapper = mountMail({ ...BOTH, defaultMode: 'html' })
        const frame = wrapper.find('iframe.safe-mail-frame')
        expect(frame.exists()).toBe(true)
        expect(wrapper.find('pre.safe-mail-text').exists()).toBe(false)
        expect(frame.attributes('sandbox')).toBe(IFRAME_SANDBOX)
        expect(frame.attributes('sandbox')).not.toMatch(/allow-scripts/)
        expect(frame.attributes('sandbox')).not.toMatch(/allow-same-origin/)
        expect(frame.attributes('srcdoc')).toContain('Acme Weekly')
        expect(frame.attributes('srcdoc')).toContain("script-src 'none'")
    })

    it('html-only mail still forces iframe plus notice even when defaultMode is text (AC-SEC-24)', () => {
        const wrapper = mountMail({
            text: '',
            html: '<p>OTP 482917</p>',
            defaultMode: 'text'
        })
        expect(wrapper.find('iframe.safe-mail-frame').exists()).toBe(true)
        expect(wrapper.find('.el-alert-stub').text()).toMatch(/no plain-text version/i)
        expect(wrapper.find('iframe.safe-mail-frame').attributes('srcdoc')).toContain('OTP 482917')
    })
})

describe('SafeMailRenderer expand', () => {
    it('starts taller than the T-22 480px letterbox and expands on click', async () => {
        const wrapper = mountMail({ ...BOTH, defaultMode: 'html' })
        const frame = wrapper.find('iframe.safe-mail-frame')
        const before = frame.attributes('style') || ''
        expect(before).toContain('72vh')
        expect(before).not.toContain('480px')
        const expand = wrapper.find('[data-testid="safe-mail-expand"]')
        expect(expand.exists()).toBe(true)
        await expand.trigger('click')
        const after = wrapper.find('iframe.safe-mail-frame').attributes('style') || ''
        expect(after).toContain('90vh')
        expect(after).not.toBe(before)
    })
})
