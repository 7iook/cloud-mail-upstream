import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    SHARE_ESTABLISH_KEY_PREFIX,
    SHARE_GONE_KEY_PREFIX,
    SHARE_SESSION_KEY_PREFIX,
    captureShareSecret,
    clearEstablishKey,
    clearOtherShareSessions,
    clearShareFragment,
    clearShareGone,
    clearShareSession,
    consumeShareSecret,
    ensureEstablishKey,
    markShareGone,
    readShareSecretFromFragment,
    readShareSession,
    shareEstablishKey,
    shareGoneKey,
    shareSessionKey,
    takeShareSecret,
    writeShareSession
} from './session.js'

function setLocation(pathWithHash) {
    window.history.replaceState(window.history.state, '', pathWithHash)
}

describe('share session fragment and storage', () => {
    beforeEach(() => {
        sessionStorage.clear()
        setLocation('/s/lid-a')
    })

    afterEach(() => {
        sessionStorage.clear()
        setLocation('/')
    })

    it('namespaces the session key by lid', () => {
        expect(shareSessionKey('lid-a')).toBe('share:session:lid-a')
        expect(SHARE_SESSION_KEY_PREFIX).toBe('share:session:')
    })

    it('writes and reads a session token only for that lid', () => {
        writeShareSession('lid-a', 'token-a')
        writeShareSession('lid-b', 'token-b')

        expect(readShareSession('lid-a')).toBe('token-a')
        expect(readShareSession('lid-b')).toBe('token-b')
        expect(sessionStorage.getItem('share:session:lid-a')).toBe('token-a')
        expect(sessionStorage.getItem('share:session:lid-b')).toBe('token-b')
    })

    it('clears only the requested lid key', () => {
        writeShareSession('lid-a', 'token-a')
        writeShareSession('lid-b', 'token-b')

        clearShareSession('lid-a')

        expect(readShareSession('lid-a')).toBe('')
        expect(sessionStorage.getItem('share:session:lid-a')).toBeNull()
        expect(readShareSession('lid-b')).toBe('token-b')
    })

    it('clears unused lid keys when opening a second share in the same tab', () => {
        writeShareSession('lid-a', 'token-a')
        writeShareSession('lid-b', 'token-b')

        clearOtherShareSessions('lid-b')

        expect(sessionStorage.getItem('share:session:lid-a')).toBeNull()
        expect(readShareSession('lid-b')).toBe('token-b')
    })

    it('reads sec from the fragment and immediately replaceState-clears it', () => {
        setLocation('/s/lid-a#sec-secret')
        expect(window.location.hash).toBe('#sec-secret')

        const sec = consumeShareSecret('lid-a')

        expect(sec).toBe('sec-secret')
        expect(window.location.hash).toBe('')
        expect(window.location.href).not.toContain('sec-secret')
        expect(window.location.href).not.toContain('#')
        expect(readShareSecretFromFragment()).toBe('')
        expect(JSON.stringify(sessionStorage)).not.toContain('sec-secret')
    })

    it('clears a leftover hash even when capture runs twice', () => {
        setLocation('/s/lid-a#once')
        expect(captureShareSecret('lid-a')).toBe('once')
        expect(window.location.hash).toBe('')
        expect(takeShareSecret('lid-a')).toBe('once')
        expect(takeShareSecret('lid-a')).toBe('')
        clearShareFragment()
        expect(window.location.href).not.toContain('#')
    })
})

// T-26 · Idempotency-Key 的客户端归属地。它不是凭据,是「这一次建会话」的去重标签,
// 所以生成、落盘、清除都归 session.js 一处(AC-SESS-10)。
describe('share establish key', () => {
    beforeEach(() => {
        sessionStorage.clear()
    })

    afterEach(() => {
        sessionStorage.clear()
    })

    it('namespaces the establish key by lid under its own prefix', () => {
        expect(SHARE_ESTABLISH_KEY_PREFIX).toBe('share:est-key:')
        expect(shareEstablishKey('lid-a')).toBe('share:est-key:lid-a')
    })

    it('writes the key before the request and hands the same one back to a retry', () => {
        const first = ensureEstablishKey('lid-a')

        expect(first).toMatch(/^[0-9a-f]{32}$/)
        expect(sessionStorage.getItem('share:est-key:lid-a')).toBe(first)
        expect(ensureEstablishKey('lid-a')).toBe(first)
        expect(ensureEstablishKey('lid-a')).toBe(first)
    })

    it('gives a different lid its own key', () => {
        const a = ensureEstablishKey('lid-a')
        const b = ensureEstablishKey('lid-b')

        expect(b).not.toBe(a)
        expect(sessionStorage.getItem('share:est-key:lid-a')).toBe(a)
        expect(sessionStorage.getItem('share:est-key:lid-b')).toBe(b)
    })

    it('clears only the requested lid establish key', () => {
        const a = ensureEstablishKey('lid-a')
        const b = ensureEstablishKey('lid-b')

        clearEstablishKey('lid-a')

        expect(sessionStorage.getItem('share:est-key:lid-a')).toBeNull()
        expect(sessionStorage.getItem('share:est-key:lid-b')).toBe(b)
        expect(ensureEstablishKey('lid-a')).not.toBe(a)
    })

    // 三个前缀共用一个 sessionStorage:est-key 的读写清除都不得碰 token,更不得碰
    // T-25 的已读水位(它是进度不是凭据,清掉就丢跨会话未读)。
    it('leaves share:session: and share:status: untouched', () => {
        writeShareSession('lid-a', 'token-a')
        sessionStorage.setItem('share:status:lid-a', '{"0":7}')

        const key = ensureEstablishKey('lid-a')
        clearEstablishKey('lid-a')
        clearShareSession('lid-a')

        expect(key).toBeTruthy()
        expect(sessionStorage.getItem('share:est-key:lid-a')).toBeNull()
        expect(sessionStorage.getItem('share:session:lid-a')).toBeNull()
        expect(sessionStorage.getItem('share:status:lid-a')).toBe('{"0":7}')
    })

    it('does not let clearOtherShareSessions reach the establish key or the watermark', () => {
        writeShareSession('lid-a', 'token-a')
        ensureEstablishKey('lid-a')
        sessionStorage.setItem('share:status:lid-a', '{"0":7}')

        clearOtherShareSessions('lid-b')

        expect(sessionStorage.getItem('share:session:lid-a')).toBeNull()
        expect(sessionStorage.getItem('share:est-key:lid-a')).not.toBeNull()
        expect(sessionStorage.getItem('share:status:lid-a')).toBe('{"0":7}')
    })

    // P4:第一眼 gone 打标并要求 reload(生产会落到 worker 文档拦截的原生 404);
    // 第二眼(reload 又回到 SPA = vite 直出)则要求清空文档,绝不循环。
    it('marks a gone lid for one reload, then answers blank forever after', () => {
        expect(shareGoneKey('lid-a')).toBe('share:gone:lid-a')
        expect(SHARE_GONE_KEY_PREFIX).toBe('share:gone:')

        expect(markShareGone('lid-a')).toBe('reload')
        expect(sessionStorage.getItem('share:gone:lid-a')).toBe('1')
        expect(markShareGone('lid-a')).toBe('blank')
        expect(markShareGone('lid-a')).toBe('blank')
        // 不同 lid 各自记账,一条销毁不连坐别的分享。
        expect(markShareGone('lid-b')).toBe('reload')
    })

    it('clears the gone flag so a later live session can reload once again', () => {
        expect(markShareGone('lid-a')).toBe('reload')
        clearShareGone('lid-a')
        expect(sessionStorage.getItem('share:gone:lid-a')).toBeNull()
        expect(markShareGone('lid-a')).toBe('reload')
    })
})
