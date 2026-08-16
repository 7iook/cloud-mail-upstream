import { onScopeDispose, ref, shallowRef } from 'vue'

export const COPY_PATH = Object.freeze({
  clipboard: 'clipboard',
  execCommand: 'execCommand',
  manual: 'manual'
})

function toText(value) {
  return value == null ? '' : String(value)
}

function getClipboard() {
  if (typeof navigator === 'undefined') return null
  const clipboard = navigator.clipboard
  if (!clipboard || typeof clipboard.writeText !== 'function') return null
  return clipboard
}

async function tryClipboard(text) {
  const clipboard = getClipboard()
  if (!clipboard) return false
  try {
    await clipboard.writeText(text)
    return true
  } catch (err) {
    console.warn('[useCopyWithFallback] clipboard.writeText failed', err)
    return false
  }
}

function tryExecCommand(text) {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    return false
  }
  if (!document.body || typeof document.createElement !== 'function') {
    return false
  }
  let textarea = null
  try {
    textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.setAttribute('aria-hidden', 'true')
    textarea.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:none;opacity:0;'
    document.body.appendChild(textarea)
    textarea.focus()
    if (typeof textarea.select === 'function') textarea.select()
    if (typeof textarea.setSelectionRange === 'function') {
      textarea.setSelectionRange(0, text.length)
    }
    return !!document.execCommand('copy')
  } catch (err) {
    console.warn('[useCopyWithFallback] execCommand copy failed', err)
    return false
  } finally {
    if (textarea && textarea.parentNode) {
      textarea.parentNode.removeChild(textarea)
    }
  }
}

function selectInElement(el, text) {
  if (!el) return false
  if ('value' in el) {
    el.value = text
    el.readOnly = true
    if (typeof el.focus === 'function') el.focus()
    if (typeof el.select === 'function') el.select()
    if (typeof el.setSelectionRange === 'function') {
      el.setSelectionRange(0, text.length)
    }
    return true
  }
  el.textContent = text
  if (typeof window === 'undefined' || typeof document === 'undefined') return true
  if (typeof window.getSelection !== 'function' || typeof document.createRange !== 'function') {
    return true
  }
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(el)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

function createFallbackHost() {
  if (typeof document === 'undefined' || !document.body) return null
  const host = document.createElement('textarea')
  host.setAttribute('data-copy-fallback', 'true')
  host.setAttribute('readonly', '')
  host.setAttribute('aria-label', 'copy-fallback')
  host.style.cssText = [
    'position:fixed',
    'z-index:2147483646',
    'left:50%',
    'bottom:16px',
    'transform:translateX(-50%)',
    'width:min(90vw,320px)',
    'min-height:2.5em',
    'padding:8px',
    'font:16px/1.4 system-ui,sans-serif',
    'background:#fff',
    'color:#111',
    'border:1px solid #999',
    'border-radius:6px'
  ].join(';')
  document.body.appendChild(host)
  return host
}

/**
 * Copy text with a usable fallback when Clipboard API is missing or rejects.
 * Callers should toast success only when `copied` is true. When `path` is
 * `manual`, show `fallbackText` / the bound `selectableRef` instead of a
 * copy-failed toast (AC-OTP-09). Bind `selectableRef` to an input/textarea
 * to keep the fallback in-page; otherwise a selected textarea is injected.
 */
export function useCopyWithFallback() {
  const lastPath = ref(null)
  const fallbackText = ref('')
  const fallbackActive = ref(false)
  const selectableRef = shallowRef(null)
  let hostEl = null

  function cleanupHost() {
    if (hostEl && hostEl.parentNode) {
      hostEl.parentNode.removeChild(hostEl)
    }
    hostEl = null
  }

  function clearFallback() {
    fallbackActive.value = false
    fallbackText.value = ''
    cleanupHost()
  }

  function activateManual(text) {
    fallbackText.value = text
    fallbackActive.value = true
    lastPath.value = COPY_PATH.manual
    const bound = selectableRef.value
    if (bound) {
      selectInElement(bound, text)
      return {
        copied: false,
        path: COPY_PATH.manual,
        text,
        selectableEl: bound
      }
    }
    cleanupHost()
    hostEl = createFallbackHost()
    if (hostEl) selectInElement(hostEl, text)
    return {
      copied: false,
      path: COPY_PATH.manual,
      text,
      selectableEl: hostEl
    }
  }

  async function copy(raw) {
    const text = toText(raw)
    clearFallback()
    lastPath.value = null

    if (await tryClipboard(text)) {
      lastPath.value = COPY_PATH.clipboard
      return {
        copied: true,
        path: COPY_PATH.clipboard,
        text,
        selectableEl: null
      }
    }

    if (tryExecCommand(text)) {
      lastPath.value = COPY_PATH.execCommand
      return {
        copied: true,
        path: COPY_PATH.execCommand,
        text,
        selectableEl: null
      }
    }

    return activateManual(text)
  }

  function dismissFallback() {
    clearFallback()
  }

  onScopeDispose(() => {
    cleanupHost()
  })

  return {
    copy,
    lastPath,
    fallbackText,
    fallbackActive,
    selectableRef,
    dismissFallback
  }
}
