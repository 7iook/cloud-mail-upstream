/**
 * SafeMailRenderer document builder.
 *
 * Sandbox choice (AC-SEC-07 / AC-SEC-09):
 *   allow-popups — target=_blank can open a tab
 *   allow-popups-to-escape-sandbox — that tab is a normal page
 *   never allow-scripts / allow-same-origin
 *
 * Remote images load by default (AC-SEC-23). The sender can see
 * visitor IP, time, and User-Agent. Accepted product trade-off.
 * Auto-height is out of scope: it would need scripts in the frame.
 * Over-wide tables: there is no script-free equivalent of the old
 * host `zoom`. A 600px table in a narrower pane scrolls horizontally.
 */

export const IFRAME_SANDBOX =
    'allow-popups allow-popups-to-escape-sandbox'

export const INNER_CSP = "script-src 'none'"

export const DEFAULT_FRAME_HEIGHT = '72vh'
export const EXPANDED_FRAME_HEIGHT = '90vh'

const CSP_META =
    `<meta http-equiv="Content-Security-Policy" content="${INNER_CSP}">`

const VIEWPORT_META =
    '<meta name="viewport" content="width=device-width, initial-scale=1">'

const FRAME_STYLE =
    '<style>html,body{margin:0;padding:8px;overflow:auto}img{max-width:100%;height:auto}</style>'

export function hasMeaningfulText(text) {
    return typeof text === 'string' && text.trim().length > 0
}

export function hasMeaningfulHtml(html) {
    return typeof html === 'string' && html.trim().length > 0
}

export function resolveView({ text, html, mode, preferredDefault = 'text' } = {}) {
    const hasText = hasMeaningfulText(text)
    const hasHtml = hasMeaningfulHtml(html)
    const wanted = preferredDefault === 'html' ? 'html' : 'text'
    if (!hasText && !hasHtml) {
        return { view: 'empty', notice: null, defaultMode: wanted }
    }
    if (!hasText && hasHtml) {
        return { view: 'html', notice: 'noPlainText', defaultMode: 'html' }
    }
    const effective = (mode === 'html' || mode === 'text') ? mode : wanted
    if (effective === 'html' && hasHtml) {
        return { view: 'html', notice: null, defaultMode: wanted }
    }
    return { view: 'text', notice: null, defaultMode: wanted }
}

function readAttr(attrs, name) {
    const quoted = attrs.match(
        new RegExp(`\\b${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, 'i')
    )
    if (quoted) return { raw: quoted[0], value: quoted[2] }
    const bare = attrs.match(
        new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, 'i')
    )
    if (bare) {
        return { raw: bare[0], value: bare[1].replace(/['"]/g, '') }
    }
    return null
}

function writeAttr(attrs, name, value, existing) {
    const assignment = `${name}="${value}"`
    if (existing) return attrs.replace(existing.raw, assignment)
    return `${attrs} ${assignment}`
}

function rewriteAnchorAttrs(raw) {
    let attrs = raw || ''
    const target = readAttr(attrs, 'target')
    attrs = writeAttr(attrs, 'target', '_blank', target)
    const rel = readAttr(attrs, 'rel')
    const tokens = new Set(
        (rel ? rel.value : '')
            .split(/\s+/)
            .filter(Boolean)
            .map((token) => token.toLowerCase())
    )
    tokens.add('noopener')
    tokens.add('noreferrer')
    attrs = writeAttr(attrs, 'rel', [...tokens].join(' '), rel)
    return attrs
}

export function rewriteAnchors(html) {
    if (typeof html !== 'string' || !html) return html || ''
    return html.replace(/<a\b([^>]*?)>/gi, (_full, attrs) => {
        return `<a${rewriteAnchorAttrs(attrs)}>`
    })
}

export function buildSrcdoc(html) {
    if (typeof html !== 'string') {
        throw new Error('SAFE_MAIL_SRCDOC_INVALID')
    }
    const rewritten = rewriteAnchors(html)
    if (/<head[\s>]/i.test(rewritten)) {
        return rewritten.replace(/<head([^>]*)>/i, `<head$1>${CSP_META}${VIEWPORT_META}${FRAME_STYLE}`)
    }
    if (/<html[\s>]/i.test(rewritten)) {
        return rewritten.replace(
            /<html([^>]*)>/i,
            `<html$1><head>${CSP_META}${VIEWPORT_META}${FRAME_STYLE}</head>`
        )
    }
    return `<!DOCTYPE html><html><head><meta charset="utf-8">${CSP_META}${VIEWPORT_META}${FRAME_STYLE}</head><body>${rewritten}</body></html>`
}

export function tryBuildSrcdoc(html) {
    try {
        return { ok: true, srcdoc: buildSrcdoc(html) }
    } catch (err) {
        console.error('[SafeMailRenderer] srcdoc build failed', err)
        return { ok: false, srcdoc: '', error: err }
    }
}

export function isSafeSandbox(sandbox) {
    const tokens = String(sandbox || '').trim().split(/\s+/).filter(Boolean)
    return !tokens.includes('allow-scripts')
        && !tokens.includes('allow-same-origin')
}

export function supportsSrcdoc() {
    if (typeof document === 'undefined') return true
    return 'srcdoc' in document.createElement('iframe')
}
