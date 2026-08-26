import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const websiteConfig = vi.fn()
const loginUserInfo = vi.fn()

vi.mock('@/request/setting.js', () => ({
    websiteConfig: (...args) => websiteConfig(...args)
}))

vi.mock('@/request/my.js', () => ({
    loginUserInfo: (...args) => loginUserInfo(...args)
}))

vi.mock('@/perm/perm.js', () => ({
    permsToRouter: () => []
}))

vi.mock('@/router', () => ({
    default: { addRoute: vi.fn() }
}))

vi.mock('@/i18n/index.js', () => ({
    default: { global: { locale: { value: 'en' } } }
}))

import { assertShareEntryBootstrap } from '@/init/assert-share-entry.js'
import { init } from '@/init/init.js'

describe('anonymous share bootstrap isolation', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        localStorage.clear()
        websiteConfig.mockReset()
        loginUserInfo.mockReset()
        websiteConfig.mockRejectedValue(new Error('websiteConfig down'))
    })

    it('does not reject anonymous /s/:lid when websiteConfig fails', async () => {
        window.history.replaceState(window.history.state, '', '/s/lid-visit')
        await expect(init()).resolves.toBeUndefined()
        expect(websiteConfig).not.toHaveBeenCalled()
    })

    it('treats /S/:lid as an anonymous share visit (case-insensitive path)', async () => {
        window.history.replaceState(window.history.state, '', '/S/lid-visit')
        await expect(init()).resolves.toBeUndefined()
        expect(websiteConfig).not.toHaveBeenCalled()
    })

    it('still rejects anonymous login startup when websiteConfig fails', async () => {
        window.history.replaceState(window.history.state, '', '/login')
        await expect(init()).rejects.toThrow('websiteConfig down')
        expect(websiteConfig).toHaveBeenCalledTimes(1)
    })

    it('returns from init before websiteConfig on anonymous share visits', async () => {
        const src = await readFile(path.join(process.cwd(), 'src/init/init.js'), 'utf8')
        expect(assertShareEntryBootstrap(src).ok).toBe(true)
    })

    it('entry assertion fails the pre-fix init that awaited websiteConfig unconditionally', () => {
        const preFix = [
            'import {websiteConfig} from "@/request/setting.js"',
            'export async function init() {',
            '    const token = localStorage.getItem("token")',
            '    if (token) {',
            '        await Promise.all([websiteConfig(), userPromise])',
            '    } else {',
            '        setting = await websiteConfig()',
            '    }',
            '}'
        ].join('\n')
        expect(assertShareEntryBootstrap(preFix).ok).toBe(false)
    })
})
