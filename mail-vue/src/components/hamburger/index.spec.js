import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import Hamburger from '@/components/hamburger/index.vue'

describe('Hamburger', () => {
    it('applies is-active on the svg when isActive is true', () => {
        const wrapper = mount(Hamburger, {
            props: { isActive: true }
        })
        expect(wrapper.find('svg').classes()).toContain('is-active')
    })

    it('emits toggleClick when the root is clicked', async () => {
        const wrapper = mount(Hamburger)
        await wrapper.trigger('click')
        expect(wrapper.emitted('toggleClick')).toBeTruthy()
        expect(wrapper.emitted('toggleClick')).toHaveLength(1)
    })
})
