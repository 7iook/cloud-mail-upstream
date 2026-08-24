import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
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

  // T-25:多邮箱取数是「注入的组合函数」,不是 composable 的分支。
  // 一拍 = 1 次 status + 1 次当前 Binding 的 mails,与 Binding 数无关(AC-OTP-07)。
  it('runs a composed status-then-mails fetcher exactly once per tick, whatever the binding count', async () => {
    const getStatus = vi.fn(async () => ({
      mailboxes: [
        { bindingId: 0, latestEmailId: 11 },
        { bindingId: 8002, latestEmailId: 52 },
        { bindingId: 8003, latestEmailId: 71 }
      ]
    }))
    const getMails = vi.fn(async () => ({ list: [], nextCursor: null }))
    const listShareMails = vi.fn(async ({ sessionToken, limit, signal }) => {
      const status = await getStatus({ sessionToken, signal })
      const active = status.mailboxes[0]
      return getMails({ sessionToken, bindingId: active.bindingId, limit, signal })
    })
    session = runPolling({ listShareMails, limit: 50 })

    for (const tick of [1, 2, 3]) {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      assert.equal(listShareMails.mock.calls.length, tick)
      assert.equal(getStatus.mock.calls.length, tick)
      assert.equal(getMails.mock.calls.length, tick)
    }

    const askedBindings = new Set(getMails.mock.calls.map(([args]) => args.bindingId))
    assert.deepEqual([...askedBindings], [0])
    assert.equal(getMails.mock.calls[0][0].limit, 50)
    assert.ok(getStatus.mock.calls[0][0].signal)
    assert.equal(getStatus.mock.calls[0][0].signal, getMails.mock.calls[0][0].signal)
  })

  // T-26:下发的 refreshIntervalMs 是 bootstrap 里 await 回来的,永远晚于 setup。
  // setup 期快照会把它整个吃掉,所以每次排程都要重新读。
  it('reads intervalMs at each schedule, so a value that lands after setup takes effect', async () => {
    const listShareMails = vi.fn(async () => ({ list: [], nextCursor: null }))
    const intervalMs = ref(POLL_INTERVAL_MS)
    session = runPolling({ listShareMails, intervalMs })

    intervalMs.value = 8000

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    assert.equal(listShareMails.mock.calls.length, 1)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    assert.equal(listShareMails.mock.calls.length, 1)

    await vi.advanceTimersByTimeAsync(5000)
    assert.equal(listShareMails.mock.calls.length, 2)
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
