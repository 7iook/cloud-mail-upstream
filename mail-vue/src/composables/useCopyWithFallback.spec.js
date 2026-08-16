import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { effectScope } from 'vue'
import { COPY_PATH, useCopyWithFallback } from './useCopyWithFallback.js'

function createDom({ execCommandResult = false } = {}) {
  const bodyChildren = []
  const body = {
    children: bodyChildren,
    appendChild(el) {
      bodyChildren.push(el)
      el.parentNode = body
      el.isConnected = true
      return el
    },
    removeChild(el) {
      const index = bodyChildren.indexOf(el)
      if (index >= 0) bodyChildren.splice(index, 1)
      el.parentNode = null
      el.isConnected = false
      return el
    }
  }

  function createElement(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      value: '',
      textContent: '',
      style: { cssText: '' },
      parentNode: null,
      isConnected: false,
      readOnly: false,
      _focused: false,
      _selected: false,
      _selectionStart: 0,
      _selectionEnd: 0,
      setAttribute() {},
      focus() {
        this._focused = true
      },
      select() {
        this._selected = true
        this._selectionStart = 0
        this._selectionEnd = String(this.value).length
      },
      setSelectionRange(start, end) {
        this._selectionStart = start
        this._selectionEnd = end
        this._selected = true
      }
    }
  }

  return {
    body,
    createElement,
    execCommand(command) {
      return command === 'copy' ? execCommandResult : false
    },
    createRange() {
      return {
        selectNodeContents(node) {
          this._node = node
        }
      }
    }
  }
}

const originalDocument = globalThis.document
const originalWindow = globalThis.window
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

function setNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    enumerable: true,
    writable: true,
    value
  })
}

function restoreNavigator() {
  if (originalNavigator) {
    Object.defineProperty(globalThis, 'navigator', originalNavigator)
    return
  }
  delete globalThis.navigator
}

function installBrowser({ clipboard, execCommandResult = false } = {}) {
  const document = createDom({ execCommandResult })
  globalThis.document = document
  globalThis.window = globalThis
  globalThis.window.getSelection = () => ({
    removeAllRanges() {},
    addRange() {}
  })
  setNavigator(clipboard === undefined ? {} : { clipboard })
  return document
}

function runComposable() {
  const scope = effectScope()
  const api = scope.run(() => useCopyWithFallback())
  return {
    api,
    stop() {
      scope.stop()
    }
  }
}

describe('useCopyWithFallback', () => {
  let session

  beforeEach(() => {
    session = null
  })

  afterEach(() => {
    if (session) session.stop()
    globalThis.document = originalDocument
    if (originalWindow) globalThis.window = originalWindow
    restoreNavigator()
  })

  it('writes via Clipboard API and reports path clipboard when writeText succeeds', async () => {
    let stored = ''
    installBrowser({
      clipboard: {
        writeText: async (text) => {
          stored = text
        }
      }
    })
    session = runComposable()
    const result = await session.api.copy('482917')

    assert.equal(result.copied, true)
    assert.equal(result.path, COPY_PATH.clipboard)
    assert.equal(result.text, '482917')
    assert.equal(stored, '482917')
    assert.equal(session.api.lastPath.value, COPY_PATH.clipboard)
    assert.equal(session.api.fallbackActive.value, false)
    assert.equal(result.selectableEl, null)
  })

  it('falls back to execCommand and reports that path when clipboard is missing', async () => {
    const document = installBrowser({
      clipboard: undefined,
      execCommandResult: true
    })
    session = runComposable()
    const result = await session.api.copy('482917')

    assert.equal(result.copied, true)
    assert.equal(result.path, COPY_PATH.execCommand)
    assert.equal(session.api.lastPath.value, COPY_PATH.execCommand)
    assert.equal(session.api.fallbackActive.value, false)
    assert.equal(
      document.body.children.some((el) => el.getAttribute && el.getAttribute('data-copy-fallback') === 'true'),
      false
    )
  })

  it('exposes selected fallback text when clipboard is undefined and execCommand fails', async () => {
    const document = installBrowser({
      clipboard: undefined,
      execCommandResult: false
    })
    session = runComposable()
    const result = await session.api.copy('482917')

    assert.equal(result.copied, false)
    assert.equal(result.path, COPY_PATH.manual)
    assert.equal(session.api.lastPath.value, COPY_PATH.manual)
    assert.equal(session.api.fallbackActive.value, true)
    assert.equal(session.api.fallbackText.value, '482917')
    assert.ok(result.selectableEl)
    assert.equal(result.selectableEl.value, '482917')
    assert.equal(result.selectableEl._selected, true)
    assert.equal(result.selectableEl.isConnected, true)
    assert.ok(document.body.children.includes(result.selectableEl))
  })

  it('exposes selected fallback text when clipboard.writeText rejects', async () => {
    installBrowser({
      clipboard: {
        writeText: async () => {
          throw new Error('NotAllowedError')
        }
      },
      execCommandResult: false
    })
    session = runComposable()
    const result = await session.api.copy('654321')

    assert.equal(result.copied, false)
    assert.equal(result.path, COPY_PATH.manual)
    assert.equal(session.api.fallbackActive.value, true)
    assert.equal(session.api.fallbackText.value, '654321')
    assert.ok(result.selectableEl)
    assert.equal(result.selectableEl.value, '654321')
    assert.equal(result.selectableEl._selected, true)
  })

  it('selects a caller-bound element on the manual path instead of injecting a host', async () => {
    const document = installBrowser({
      clipboard: undefined,
      execCommandResult: false
    })
    session = runComposable()
    const bound = document.createElement('textarea')
    document.body.appendChild(bound)
    session.api.selectableRef.value = bound

    const result = await session.api.copy('778899')

    assert.equal(result.path, COPY_PATH.manual)
    assert.equal(result.selectableEl, bound)
    assert.equal(bound.value, '778899')
    assert.equal(bound._selected, true)
    assert.equal(
      document.body.children.filter((el) => el !== bound).length,
      0
    )
  })
})
