import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import { createAppRouter } from '@/router/index.js'
import { writeShareSession } from '@/views/share/session.js'

vi.mock('@/request/share.js', () => ({
    createShareSession: vi.fn().mockResolvedValue({ sessionToken: 'sess-from-guard', mailbox: 'share@example.com' }),
    isShareUnavailable: () => false,
    isShareRateLimited: () => false
}))

vi.mock('@/views/share/index.vue', () => ({
    default: { name: 'share', template: '<div data-share-stub></div>' }
}))

vi.mock('@/views/login/index.vue', () => ({
    default: { name: 'login-stub', template: '<div data-login-stub></div>' }
}))

vi.mock('@/layout/index.vue', () => ({
    default: { name: 'layout-stub', template: '<div data-layout-stub><router-view /></div>' }
}))

let router

async function go(location) {
    await router.push(location).catch((err) => {
        if (err && err.name !== 'NavigationDuplicated' && err.name !== 'NavigationAborted') {
            throw err
        }
    })
}

describe('share route guard and session lifecycle', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        localStorage.clear()
        sessionStorage.clear()
        router = createAppRouter(createMemoryHistory())
    })

    afterEach(() => {
        localStorage.clear()
        sessionStorage.clear()
    })

    it('registers share as a top-level sibling of layout, not a child', () => {
        const share = router.getRoutes().find((route) => route.name === 'share')
        const layout = router.getRoutes().find((route) => route.name === 'layout')

        expect(share).toBeTruthy()
        expect(share.path).toBe('/s/:lid')
        expect(layout.children.map((child) => child.name)).not.toContain('share')
        expect(share.parent && share.parent.name).not.toBe('layout')
    })

    it('lets an anonymous visitor open /s/:lid without a login token', async () => {
        await go('/s/lid-visit')

        expect(router.currentRoute.value.name).toBe('share')
        expect(router.currentRoute.value.params.lid).toBe('lid-visit')
    })

    it('still sends an anonymous visitor to login for inbox', async () => {
        await go('/inbox')

        expect(router.currentRoute.value.name).toBe('login')
    })

    it('clears the fragment during the share guard before the view runs', async () => {
        window.history.replaceState(window.history.state, '', '/s/lid-frag#sec-from-link')

        await go('/s/lid-frag')

        expect(router.currentRoute.value.name).toBe('share')
        expect(window.location.hash).toBe('')
        expect(window.location.href).not.toContain('sec-from-link')
    })

    it('keeps the current lid token on a same-route revisit and isolates a second lid', async () => {
        writeShareSession('lid-a', 'token-a')
        await go('/s/lid-a')
        expect(sessionStorage.getItem('share:session:lid-a')).toBe('token-a')

        await go({ name: 'share', params: { lid: 'lid-a' } })
        expect(sessionStorage.getItem('share:session:lid-a')).toBe('token-a')

        writeShareSession('lid-b', 'token-b')
        await go('/s/lid-b')
        expect(sessionStorage.getItem('share:session:lid-a')).toBeNull()
        expect(sessionStorage.getItem('share:session:lid-b')).toBe('token-b')
    })

    it('clears the lid token when leaving the share route and does not restore it without a fragment', async () => {
        writeShareSession('lid-a', 'token-a')

        await go('/s/lid-a')
        expect(sessionStorage.getItem('share:session:lid-a')).toBe('token-a')

        await go('/login')
        expect(router.currentRoute.value.name).toBe('login')
        expect(sessionStorage.getItem('share:session:lid-a')).toBeNull()

        await go('/s/lid-a')
        expect(router.currentRoute.value.name).toBe('share')
        expect(sessionStorage.getItem('share:session:lid-a')).toBeNull()
    })
})
