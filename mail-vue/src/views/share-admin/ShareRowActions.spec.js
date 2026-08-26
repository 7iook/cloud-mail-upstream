import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/en.js'

const { deleteMailShare, revokeMailShare, confirm, message } = vi.hoisted(() => ({
    deleteMailShare: vi.fn(),
    revokeMailShare: vi.fn(),
    confirm: vi.fn(),
    message: vi.fn()
}))

// importOriginal keeps isShareForbidden real; mocking the whole module would make the
// component's 403 predicate undefined and turn the error branches green for the wrong reason.
vi.mock('@/request/mail-share.js', async (importOriginal) => {
    const actual = await importOriginal()
    return {
        ...actual,
        deleteMailShare,
        revokeMailShare
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

import ShareRowActions from './ShareRowActions.vue'

const stubs = {
    'el-button': {
        props: ['disabled', 'loading', 'type', 'text'],
        template: '<button type="button" :disabled="disabled"><slot /></button>'
    }
}

function sampleRow(overrides = {}) {
    return {
        shareId: 7,
        name: 'front desk',
        effectiveStatus: 'ACTIVE',
        ...overrides
    }
}

function mountActions(row = sampleRow()) {
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
    return mount(ShareRowActions, {
        props: { row },
        global: { plugins: [i18n], stubs }
    })
}

describe('share-admin row actions (AC-ADMIN-06 / AC-ADMIN-07)', () => {
    beforeEach(() => {
        deleteMailShare.mockReset()
        revokeMailShare.mockReset()
        confirm.mockReset()
        message.mockReset()
        deleteMailShare.mockResolvedValue({ shareId: 7 })
        revokeMailShare.mockResolvedValue({ shareId: 7 })
        confirm.mockResolvedValue('confirm')
    })

    it('opens the detail drawer through an emit, not a request', async () => {
        const wrapper = mountActions()

        await wrapper.get('[data-test="row-open-detail"]').trigger('click')

        expect(wrapper.emitted('open')).toHaveLength(1)
        expect(revokeMailShare).not.toHaveBeenCalled()
        expect(deleteMailShare).not.toHaveBeenCalled()
    })

    it('revokes only after a confirm, and tells the list to refresh', async () => {
        const wrapper = mountActions()

        await wrapper.get('[data-test="row-revoke"]').trigger('click')
        await flushPromises()

        expect(confirm).toHaveBeenCalledTimes(1)
        expect(revokeMailShare).toHaveBeenCalledTimes(1)
        expect(revokeMailShare).toHaveBeenCalledWith(7)
        expect(deleteMailShare).not.toHaveBeenCalled()
        expect(wrapper.emitted('changed')).toHaveLength(1)
    })

    it('deletes only after a confirm whose copy is not the revoke copy', async () => {
        const wrapper = mountActions()

        await wrapper.get('[data-test="row-revoke"]').trigger('click')
        await flushPromises()
        await wrapper.get('[data-test="row-delete"]').trigger('click')
        await flushPromises()

        const revokeCopy = confirm.mock.calls[0][0]
        const deleteCopy = confirm.mock.calls[1][0]
        expect(deleteCopy).toBeTruthy()
        // Destroy keeps the audit row, delete removes it: one confirm text cannot serve both.
        expect(deleteCopy).not.toBe(revokeCopy)
        expect(deleteMailShare).toHaveBeenCalledTimes(1)
        expect(deleteMailShare).toHaveBeenCalledWith(7)
        expect(wrapper.emitted('changed')).toHaveLength(2)
    })

    it('sends nothing when the owner dismisses either confirm', async () => {
        confirm.mockRejectedValue('cancel')
        const wrapper = mountActions()

        await wrapper.get('[data-test="row-revoke"]').trigger('click')
        await flushPromises()
        await wrapper.get('[data-test="row-delete"]').trigger('click')
        await flushPromises()

        expect(revokeMailShare).not.toHaveBeenCalled()
        expect(deleteMailShare).not.toHaveBeenCalled()
        expect(wrapper.emitted('changed')).toBeUndefined()
    })

    it('drops revoke on a REVOKED row but keeps detail and delete (delete has no status predicate)', () => {
        const wrapper = mountActions(sampleRow({ effectiveStatus: 'REVOKED' }))

        expect(wrapper.find('[data-test="row-revoke"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="row-open-detail"]').exists()).toBe(true)
        expect(wrapper.find('[data-test="row-delete"]').exists()).toBe(true)
    })

    it('still offers revoke on an expired row: the backend predicate is status, not expiry', () => {
        const wrapper = mountActions(sampleRow({ effectiveStatus: 'EXPIRED' }))

        expect(wrapper.find('[data-test="row-revoke"]').exists()).toBe(true)
    })

    // P1: the buttons read liveEffectiveStatus, not the raw API snapshot. A row whose
    // persisted status already says REVOKED must not offer revoke off a stale effectiveStatus.
    it('hides revoke when the persisted status says REVOKED even if the snapshot lags', () => {
        const wrapper = mountActions(sampleRow({ status: 'REVOKED', effectiveStatus: 'ACTIVE' }))

        expect(wrapper.find('[data-test="row-revoke"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="row-delete"]').exists()).toBe(true)
    })

    it('keeps revoke on a row that expired client-side after the list snapshot (P1)', () => {
        const wrapper = mountActions(sampleRow({
            status: 'ACTIVE',
            effectiveStatus: 'ACTIVE',
            expiresAt: '2020-01-01 00:00:00'
        }))

        expect(wrapper.find('[data-test="row-revoke"]').exists()).toBe(true)
    })
})
