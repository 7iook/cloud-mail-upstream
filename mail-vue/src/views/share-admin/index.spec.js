import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { useUserStore } from '@/store/user.js'
import en from '@/i18n/en.js'

const { listMailShares, routerReplace } = vi.hoisted(() => ({
    listMailShares: vi.fn(),
    routerReplace: vi.fn()
}))

// importOriginal keeps isShareForbidden real: mocking the whole module would make the
// page's 403 predicate undefined and turn the forbidden cases green for the wrong reason.
vi.mock('@/request/mail-share.js', async (importOriginal) => {
    const actual = await importOriginal()
    return {
        ...actual,
        listMailShares
    }
})

vi.mock('@/router', () => ({
    default: {
        replace: routerReplace,
        push: vi.fn(),
        addRoute: vi.fn()
    }
}))

import { permsToRouter } from '@/perm/perm.js'
import ShareAdmin from './index.vue'

const stubs = {
    Icon: { template: '<i />' },
    'el-scrollbar': { template: '<div><slot /></div>' },
    'el-tag': { props: ['type'], template: '<span :data-tone="type"><slot /></span>' },
    'el-empty': { props: ['description'], template: '<div class="el-empty-stub">{{ description }}</div>' },
    'el-select': {
        props: ['modelValue'],
        emits: ['update:modelValue', 'change'],
        template: '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value); $emit(\'change\', $event.target.value)"><slot /></select>'
    },
    'el-option': {
        props: ['label', 'value'],
        template: '<option :value="value">{{ label }}</option>'
    },
    'el-pagination': {
        props: ['currentPage', 'pageSize', 'total'],
        emits: ['current-change'],
        template: '<div class="el-pagination-stub"><button data-test="next-page" type="button" @click="$emit(\'current-change\', currentPage + 1)">next</button></div>'
    }
}

function sampleShare(overrides = {}) {
    return {
        shareId: 7,
        name: 'front desk',
        shareType: 'single',
        mailbox: 'otp@example.com',
        bindings: [{ bindingId: 1, accountId: 11, mailbox: 'otp@example.com' }],
        status: 'ACTIVE',
        effectiveStatus: 'ACTIVE',
        usedSessions: 2,
        accessCount: 2,
        maxSessions: 5,
        createTime: '2026-08-17 01:00:00',
        expiresAt: '2026-08-18 01:00:00',
        lastAccessAt: '2026-08-17 02:00:00',
        ...overrides
    }
}

function mountPage() {
    const pinia = createPinia()
    setActivePinia(pinia)
    useUserStore().user = { permKeys: ['share:manage'] }
    const i18n = createI18n({
        legacy: false,
        locale: 'en',
        messages: { en }
    })
    return mount(ShareAdmin, {
        global: {
            plugins: [pinia, i18n],
            stubs
        }
    })
}

function lastQuery() {
    const calls = listMailShares.mock.calls
    return calls[calls.length - 1][0]
}

describe('share-admin list page (AC-ADMIN-01 / AC-ADMIN-09 / AC-ADMIN-10)', () => {
    beforeEach(() => {
        listMailShares.mockReset()
        routerReplace.mockReset()
        localStorage.clear()
        listMailShares.mockResolvedValue({ list: [], total: 0 })
    })

    it('shows every audit field the owner needs on one row (AC-ADMIN-01)', async () => {
        listMailShares.mockResolvedValue({ list: [sampleShare()], total: 1 })
        const wrapper = mountPage()
        await flushPromises()

        const row = wrapper.get('[data-test="share-row"]')
        expect(row.attributes('data-share-id')).toBe('7')
        expect(row.attributes('data-status')).toBe('ACTIVE')
        expect(row.get('[data-test="share-name"]').text()).toBe('front desk')
        expect(row.get('[data-test="share-type"]').text()).not.toBe('')
        expect(row.get('[data-test="share-bindings"]').text()).toContain('otp@example.com')
        expect(row.get('[data-test="share-status"]').text()).toBe('Active')
        expect(row.get('[data-test="share-quota"]').text()).toContain('2')
        expect(row.get('[data-test="share-quota"]').text()).toContain('5')
        expect(row.get('[data-test="share-expires"]').text()).toContain('2026-08-18 01:00:00')
        expect(row.get('[data-test="share-last-access"]').text()).toContain('2026-08-17 02:00:00')
    })

    it('tells the four effective statuses apart by data-status and by text (AC-ADMIN-09)', async () => {
        const statuses = ['ACTIVE', 'EXPIRED', 'REVOKED', 'ACCESS_LIMIT_REACHED']
        listMailShares.mockResolvedValue({
            list: statuses.map((effectiveStatus, index) => sampleShare({
                shareId: index + 1,
                effectiveStatus
            })),
            total: 4
        })
        const wrapper = mountPage()
        await flushPromises()

        statuses.forEach((status) => {
            expect(wrapper.findAll(`[data-status="${status}"]`)).toHaveLength(1)
        })
        const labels = wrapper.findAll('[data-test="share-status"]').map((node) => node.text())
        expect(labels).toHaveLength(4)
        expect(new Set(labels).size).toBe(4)
    })

    it('renders an unlimited session quota instead of a raw null maxSessions', async () => {
        listMailShares.mockResolvedValue({
            list: [sampleShare({ maxSessions: null, usedSessions: 3, accessCount: 3 })],
            total: 1
        })
        const wrapper = mountPage()
        await flushPromises()

        const quota = wrapper.get('[data-test="share-quota"]').text()
        expect(quota).toContain('3')
        expect(quota).not.toContain('null')
    })

    it('falls back to the mailbox when a binding row lost its address (T-18 hard-delete window)', async () => {
        listMailShares.mockResolvedValue({
            list: [sampleShare({
                shareType: 'multi',
                bindings: [
                    { bindingId: 1, accountId: 11, mailbox: 'otp@example.com' },
                    { bindingId: 2, accountId: 12, mailbox: '' }
                ]
            })],
            total: 1
        })
        const wrapper = mountPage()
        await flushPromises()

        const summary = wrapper.get('[data-test="share-bindings"]').text()
        expect(summary).toContain('otp@example.com')
        expect(summary).not.toMatch(/,\s*(,|$)/)
    })

    it('sends the status query only once the filter is set, and resets to page 1', async () => {
        listMailShares.mockResolvedValue({ list: [sampleShare()], total: 60 })
        const wrapper = mountPage()
        await flushPromises()

        expect(lastQuery()).not.toHaveProperty('status')
        expect(lastQuery().page).toBe(1)

        await wrapper.get('[data-test="next-page"]').trigger('click')
        await flushPromises()
        expect(lastQuery().page).toBe(2)

        await wrapper.get('[data-test="status-filter"]').setValue('REVOKED')
        await flushPromises()
        expect(lastQuery().status).toBe('REVOKED')
        expect(lastQuery().page).toBe(1)
    })

    it('always paginates the list request and hides the pager on a single page (R1-F2)', async () => {
        listMailShares.mockResolvedValue({ list: [sampleShare()], total: 1 })
        const wrapper = mountPage()
        await flushPromises()

        const query = lastQuery()
        expect(query.page).toBe(1)
        expect(query.size).toBeGreaterThan(0)
        expect(wrapper.find('.el-pagination-stub').exists()).toBe(false)
    })

    it('renders a forbidden panel for a body-403, not the generic error panel', async () => {
        listMailShares.mockRejectedValue({ code: 403, message: 'SHARE_FORBIDDEN' })
        const wrapper = mountPage()
        await flushPromises()

        expect(wrapper.find('[data-test="share-admin-forbidden"]').exists()).toBe(true)
        expect(wrapper.find('[data-test="share-admin-error"]').exists()).toBe(false)
        expect(wrapper.findAll('[data-test="share-row"]')).toHaveLength(0)
    })

    it('does not sign the owner out on a 403 the way a 401 would', async () => {
        localStorage.setItem('token', 'owner-token')
        listMailShares.mockRejectedValue({ code: 403, message: 'SHARE_FORBIDDEN' })
        mountPage()
        await flushPromises()

        expect(localStorage.getItem('token')).toBe('owner-token')
        expect(routerReplace).not.toHaveBeenCalled()
    })

    it('routes a non-403 failure to the generic error panel', async () => {
        listMailShares.mockRejectedValue({ code: 500, message: 'SHARE_DISABLED' })
        const wrapper = mountPage()
        await flushPromises()

        expect(wrapper.find('[data-test="share-admin-error"]').exists()).toBe(true)
        expect(wrapper.find('[data-test="share-admin-forbidden"]').exists()).toBe(false)
    })

    it('shows an empty state when the owner has no shares yet', async () => {
        const wrapper = mountPage()
        await flushPromises()

        expect(wrapper.find('[data-test="share-admin-empty"]').exists()).toBe(true)
        expect(wrapper.find('[data-test="share-admin-error"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="share-admin-forbidden"]').exists()).toBe(false)
    })

    it('leaves every row action to T-21: rows carry hooks, not buttons', async () => {
        listMailShares.mockResolvedValue({ list: [sampleShare()], total: 1 })
        const wrapper = mountPage()
        await flushPromises()

        const row = wrapper.get('[data-test="share-row"]')
        expect(row.attributes('data-share-id')).toBe('7')
        expect(row.findAll('button')).toHaveLength(0)
        expect(row.findAll('[data-test="revoke-share"]')).toHaveLength(0)
    })
})

describe('share-admin route registration (AC-ADMIN-10)', () => {
    it('registers the layout child route only through the share:manage perm', () => {
        const route = permsToRouter(['share:manage']).find((item) => item.name === 'share-admin')
        expect(route).toBeTruthy()
        expect(route.path).toBe('/share-admin')
        expect(route.meta).toMatchObject({
            title: 'shareManage',
            name: 'share-admin',
            menu: true,
            perm: 'share:manage'
        })
    })

    it('never registers the route for an owner without share:manage', () => {
        const names = permsToRouter(['email:send']).map((item) => item.name)
        expect(names).not.toContain('share-admin')
        expect(permsToRouter(['*']).map((item) => item.name)).toContain('share-admin')
    })
})

describe('share-admin responsive contract', () => {
    it('keeps the repo-wide 767px card breakpoint (jsdom cannot evaluate media queries)', async () => {
        const src = await readFile(path.join(process.cwd(), 'src/views/share-admin/index.vue'), 'utf8')
        expect(src).toContain('@media (max-width: 767px)')
        expect(src).not.toContain('window.onresize')
    })
})
