import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { ShareRateLimitedError, isShareUnavailable } from '@/request/share.js'
import { POLL_INTERVAL_MS, useSharePolling } from './useSharePolling.js'

const SESSION = 'share-session-token'

function setDocumentHidden(hidden) {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    enumerable: true,
    get() {
      return hidden
    }
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

function runPolling(options) {
  const scope = effectScope()
  const api = scope.run(() => useSharePolling({
    sessionToken: SESSION,
    intervalMs: POLL_INTERVAL_MS,
    ...options
  }))
  return {
    api,
    stop() {
      scope.stop()
    }
  }
}

describe('useSharePolling', () => {
  let session
  let hiddenDescriptor

  beforeEach(() => {
    session = null
    hiddenDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')
      || Object.getOwnPropertyDescriptor(document, 'hidden')
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      enumerable: true,
      get() {
        return false
      }
    })
    vi.useFakeTimers()
  })

  afterEach(() => {
    if (session) session.stop()
    session = null
    vi.clearAllTimers()
    vi.useRealTimers()
    if (hiddenDescriptor) {
      Object.defineProperty(document, 'hidden', hiddenDescriptor)
    } else {
      delete document.hidden
    }
  })

  it('does not poll again after the calling scope is disposed (AC-RT-14 unmount)', async () => {
    const listShareMails = vi.fn(async () => ({ list: [], nextCursor: null }))
    session = runPolling({ listShareMails })

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    assert.equal(listShareMails.mock.calls.length, 1)

    session.stop()
    session = null
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    assert.equal(listShareMails.mock.calls.length, 1)
  })

  it('does not poll while the page is hidden (AC-RT-05)', async () => {
    const listShareMails = vi.fn(async () => ({ list: [], nextCursor: null }))
    session = runPolling({ listShareMails })

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    assert.equal(listShareMails.mock.calls.length, 1)

    setDocumentHidden(true)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    assert.equal(listShareMails.mock.calls.length, 1)
  })

  it('waits Retry-After on 429 instead of retrying immediately (AC-RT-15)', async () => {
    const listShareMails = vi.fn()
      .mockRejectedValueOnce(new ShareRateLimitedError(10, '10'))
      .mockResolvedValue({ list: [], nextCursor: null })
    const onUnavailable = vi.fn()
    session = runPolling({ listShareMails, onUnavailable })

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    assert.equal(listShareMails.mock.calls.length, 1)
    assert.equal(session.api.unavailable.value, false)
    assert.equal(onUnavailable.mock.calls.length, 0)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    assert.equal(listShareMails.mock.calls.length, 1)

    await vi.advanceTimersByTimeAsync(7000)
    assert.equal(listShareMails.mock.calls.length, 2)
    assert.equal(session.api.unavailable.value, false)
    assert.equal(isShareUnavailable(new ShareRateLimitedError(10, '10')), false)
  })

  it('stops polling after SHARE_UNAVAILABLE (AC-RT-16)', async () => {
    const listShareMails = vi.fn(async () => {
      throw { code: 501, message: 'SHARE_UNAVAILABLE' }
    })
    const onUnavailable = vi.fn()
    session = runPolling({ listShareMails, onUnavailable })

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    assert.equal(listShareMails.mock.calls.length, 1)
    assert.equal(session.api.unavailable.value, true)
    assert.equal(onUnavailable.mock.calls.length, 1)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    assert.equal(listShareMails.mock.calls.length, 1)
  })

  it('advances the cursor from newly returned mail ids and passes sessionToken plus signal', async () => {
    const listShareMails = vi.fn()
      .mockResolvedValueOnce({
        list: [{ mailId: 4 }, { mailId: 9 }],
        nextCursor: null
      })
      .mockResolvedValue({ list: [], nextCursor: null })
    const onMails = vi.fn()
    session = runPolling({
      listShareMails,
      initialCursor: '1',
      onMails
    })

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    assert.equal(session.api.cursor.value, '9')
    assert.deepEqual(onMails.mock.calls[0][0].map((row) => row.mailId), [4, 9])
    assert.equal(listShareMails.mock.calls[0][0].sessionToken, SESSION)
    assert.equal(listShareMails.mock.calls[0][0].cursor, '1')
    assert.ok(listShareMails.mock.calls[0][0].signal)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    assert.equal(listShareMails.mock.calls[1][0].cursor, '9')
  })

  it('aborts an in-flight request on dispose and when the page is hidden', async () => {
    const signals = []
    const listShareMails = vi.fn(({ signal }) => {
      signals.push(signal)
      return new Promise(() => {})
    })
    session = runPolling({ listShareMails })

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    assert.equal(signals.length, 1)
    assert.equal(signals[0].aborted, false)

    setDocumentHidden(true)
    assert.equal(signals[0].aborted, true)

    setDocumentHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(signals.length, 2)
    assert.equal(signals[1].aborted, false)

    session.stop()
    session = null
    assert.equal(signals[1].aborted, true)
  })
})
