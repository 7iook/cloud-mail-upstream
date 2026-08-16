import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    IFRAME_SANDBOX,
    INNER_CSP,
    hasMeaningfulText,
    hasMeaningfulHtml,
    resolveView,
    rewriteAnchors,
    buildSrcdoc,
    tryBuildSrcdoc,
    isSafeSandbox
} from './srcdoc.js'

describe('sandbox tokens (AC-SEC-09, AC-SEC-07 popups)', () => {
    it('omits allow-scripts and allow-same-origin',
        () => {
            assert.equal(isSafeSandbox(IFRAME_SANDBOX), true)
            const tokens = IFRAME_SANDBOX.trim().split(/\s+/)
            assert.ok(!tokens.includes('allow-scripts'))
            assert.ok(!tokens.includes('allow-same-origin'))
        })

    it('includes allow-popups and allow-popups-to-escape-sandbox',
        () => {
            const tokens = IFRAME_SANDBOX.trim().split(/\s+/)
            assert.ok(tokens.includes('allow-popups'))
            assert.ok(tokens.includes('allow-popups-to-escape-sandbox'))
        })
})

describe('resolveView (AC-SEC-01, AC-SEC-24)', () => {
    it('defaults to text when both text and html exist',
        () => {
            const view = resolveView({
                text: 'hello',
                html: '<p>hi</p>'
            })
            assert.equal(view.view, 'text')
            assert.equal(view.defaultMode, 'text')
            assert.equal(view.notice, null)
        })

    it('switches to html when the user asks and html exists',
        () => {
            const view = resolveView({
                text: 'hello',
                html: '<p>hi</p>',
                mode: 'html'
            })
            assert.equal(view.view, 'html')
        })

    it('uses sandboxed html plus notice when text is missing',
        () => {
            const view = resolveView({
                text: '   ',
                html: '<p>only html</p>'
            })
            assert.equal(view.view, 'html')
            assert.equal(view.defaultMode, 'html')
            assert.equal(view.notice, 'noPlainText')
        })

    it('keeps html plus notice if user flips to text on html-only mail',
        () => {
            const view = resolveView({
                text: '',
                html: '<p>only html</p>',
                mode: 'text'
            })
            assert.equal(view.view, 'html')
            assert.equal(view.notice, 'noPlainText')
        })

    it('stays on text when html is missing even if mode is html',
        () => {
            const view = resolveView({
                text: 'plain',
                html: '',
                mode: 'html'
            })
            assert.equal(view.view, 'text')
        })

    it('defaults to html when preferredDefault is html and both parts exist',
        () => {
            const view = resolveView({
                text: 'Weekly digest',
                html: '<table><tr><td>Acme Weekly</td></tr></table>',
                preferredDefault: 'html'
            })
            assert.equal(view.view, 'html')
            assert.equal(view.defaultMode, 'html')
            assert.equal(view.notice, null)
        })

    it('keeps share-style text default when preferredDefault is omitted',
        () => {
            const view = resolveView({
                text: 'Weekly digest',
                html: '<table><tr><td>Acme Weekly</td></tr></table>'
            })
            assert.equal(view.view, 'text')
            assert.equal(view.defaultMode, 'text')
        })

    it('still forces html plus notice when text is missing even if preferredDefault is text',
        () => {
            const view = resolveView({
                text: '',
                html: '<p>OTP 482917</p>',
                preferredDefault: 'text'
            })
            assert.equal(view.view, 'html')
            assert.equal(view.defaultMode, 'html')
            assert.equal(view.notice, 'noPlainText')
        })
})

describe('rewriteAnchors (AC-SEC-07)', () => {
    it('adds target and rel on a bare anchor',
        () => {
            const out = rewriteAnchors('<a href="https://ex.test">x</a>')
            assert.match(out, /target="_blank"/)
            assert.match(out, /rel="[^"]*noopener[^"]*noreferrer[^"]*"/)
        })

    it('replaces an existing target and merges rel',
        () => {
            const out = rewriteAnchors(
                '<a href="https://ex.test" target="_self" rel="nofollow">x</a>'
            )
            assert.match(out, /target="_blank"/)
            assert.ok(!out.includes('target="_self"'))
            assert.match(out, /nofollow/)
            assert.match(out, /noopener/)
            assert.match(out, /noreferrer/)
        })

    it('does not rewrite non-anchor tags',
        () => {
            const src = '<abbr title="a">A</abbr><article>x</article>'
            assert.equal(rewriteAnchors(src), src)
        })
})

describe('buildSrcdoc (AC-SEC-15, AC-SEC-16)', () => {
    it('wraps a fragment with CSP script-src none',
        () => {
            const doc = buildSrcdoc('<p onclick="alert(1)">hi</p>')
            assert.match(doc, /http-equiv="Content-Security-Policy"/i)
            assert.match(doc, /script-src 'none'/)
            assert.match(doc, /<p onclick="alert\(1\)">hi<\/p>/)
            assert.ok(!doc.includes('<script>'))
        })

    it('injects CSP into an existing document head',
        () => {
            const doc = buildSrcdoc(
                '<!DOCTYPE html><html><head><title>t</title></head><body>x</body></html>'
            )
            assert.match(doc, /<head[^>]*>[\s\S]*script-src 'none'/)
        })

    it('keeps sender script tags as-is while still setting CSP',
        () => {
            const doc = buildSrcdoc('<script>window.pwned=1</script><p>x</p>')
            assert.match(doc, /<script>window\.pwned=1<\/script>/)
            assert.match(doc, /script-src 'none'/)
        })
})

describe('tryBuildSrcdoc (AC-SEC-14)', () => {
    it('returns ok false instead of throwing on invalid input',
        () => {
            const result = tryBuildSrcdoc(null)
            assert.equal(result.ok, false)
            assert.equal(result.srcdoc, '')
        })
})

describe('meaningful fields',
    () => {
        it('treats whitespace-only as empty',
            () => {
                assert.equal(hasMeaningfulText('  \n'), false)
                assert.equal(hasMeaningfulHtml('   '), false)
                assert.equal(hasMeaningfulText('hi'), true)
                assert.equal(hasMeaningfulHtml('<p>x</p>'), true)
            })
    })
