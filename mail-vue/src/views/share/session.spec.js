import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    SHARE_SESSION_KEY_PREFIX,
    captureShareSecret,
    clearOtherShareSessions,
    clearShareFragment,
    clearShareSession,
    consumeShareSecret,
    readShareSecretFromFragment,
    readShareSession,
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
