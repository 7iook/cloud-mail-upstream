import { onScopeDispose, ref, toValue } from 'vue'
import {
  isShareGone,
  isShareRateLimited,
  isShareUnavailable,
  listShareMails as defaultListShareMails,
  parseRetryAfter
} from '@/request/share.js'

export const POLL_INTERVAL_MS = 3000

function isAbortError(err) {
  return Boolean(
    err &&
    (err.name === 'AbortError' || err.name === 'CanceledError' || err.code === 'ERR_CANCELED')
  )
}

function normalizeCursor(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }
  return String(value)
}

function readRetryAfterHeader(err) {
  const headers = err && err.response && err.response.headers
  if (!headers) {
    return err && err.retryAfterRaw
  }
  if (typeof headers.get === 'function') {
    return headers.get('retry-after')
  }
  return headers['retry-after'] ?? headers['Retry-After'] ?? err.retryAfterRaw
}

function retryAfterMs(err, fallbackMs) {
  if (typeof err.retryAfter === 'number' && Number.isFinite(err.retryAfter) && err.retryAfter >= 0) {
    return Math.round(err.retryAfter * 1000)
  }
  const parsed = parseRetryAfter(readRetryAfterHeader(err))
  if (parsed != null) {
    return Math.round(parsed * 1000)
  }
  return fallbackMs
}

function isPageHidden() {
  return typeof document !== 'undefined' && document.hidden === true
}

/**
 * Incremental GET /share/mails polling for the anonymous share page.
 * Depends on T-14 `listShareMails({ sessionToken, cursor, limit, signal })`.
 * 429 is ShareRateLimitedError (wait Retry-After). Dead share is SHARE_UNAVAILABLE (stop).
 */
export function useSharePolling(options = {}) {
  const fetchMails = options.listShareMails || defaultListShareMails
  // Read at every schedule, never snapshotted: the share config that carries the interval
  // arrives one await after this composable is constructed.
  const readInterval = () => {
    const raw = toValue(options.intervalMs)
    return Number.isFinite(raw) && raw > 0 ? raw : POLL_INTERVAL_MS
  }
  const cursor = ref(normalizeCursor(options.initialCursor))
  const unavailable = ref(false)

  let timer = null
  let controller = null
  let stopped = false
  let listening = false

  function clearTimer() {
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function abortInFlight() {
    if (!controller) {
      return
    }
    controller.abort()
    controller = null
  }

  function detachVisibility() {
    if (!listening || typeof document === 'undefined') {
      return
    }
    document.removeEventListener('visibilitychange', onVisibility)
    listening = false
  }

  function attachVisibility() {
    if (listening || typeof document === 'undefined') {
      return
    }
    document.addEventListener('visibilitychange', onVisibility)
    listening = true
  }

  function stop() {
    stopped = true
    clearTimer()
    abortInFlight()
    detachVisibility()
  }

  function schedule(delayMs) {
    clearTimer()
    if (stopped || unavailable.value || isPageHidden()) {
      return
    }
    timer = setTimeout(() => {
      timer = null
      tick()
    }, delayMs)
  }

  function notifyUnavailable(err) {
    if (unavailable.value) {
      return
    }
    unavailable.value = true
    clearTimer()
    abortInFlight()
    detachVisibility()
    try {
      options.onUnavailable?.(err)
    } catch (cbErr) {
      console.error('[useSharePolling] onUnavailable failed', cbErr)
    }
  }

  async function tick() {
    if (stopped || unavailable.value || isPageHidden()) {
      return
    }

    abortInFlight()
    controller = new AbortController()
    const signal = controller.signal

    try {
      const result = await fetchMails({
        sessionToken: toValue(options.sessionToken),
        cursor: cursor.value,
        limit: toValue(options.limit),
        signal
      })
      if (stopped || signal.aborted) {
        return
      }

      const list = Array.isArray(result && result.list) ? result.list : []
      if (list.length) {
        const last = list[list.length - 1]
        if (last && last.mailId != null) {
          cursor.value = String(last.mailId)
        }
        try {
          options.onMails?.(list)
        } catch (cbErr) {
          console.error('[useSharePolling] onMails failed', cbErr)
        }
      }
      schedule(readInterval())
    } catch (err) {
      if (stopped || isAbortError(err) || signal.aborted) {
        return
      }
      if (isShareRateLimited(err)) {
        schedule(retryAfterMs(err, readInterval()))
        return
      }
      // gone(P4 裸 404)与 SHARE_UNAVAILABLE 同一个终局出口:停表并上报。
      // 404 是终态不是抖动,重试只会空转;reload 还是清空文档由页面决定。
      if (isShareUnavailable(err) || isShareGone(err)) {
        notifyUnavailable(err)
        return
      }
      console.error('[useSharePolling] poll failed', err)
      schedule(readInterval())
    }
  }

  function onVisibility() {
    if (stopped || unavailable.value) {
      return
    }
    if (isPageHidden()) {
      clearTimer()
      abortInFlight()
      return
    }
    schedule(0)
  }

  function start() {
    if (unavailable.value) {
      return
    }
    stopped = false
    attachVisibility()
    if (isPageHidden()) {
      return
    }
    schedule(readInterval())
  }

  start()
  onScopeDispose(stop)

  return {
    cursor,
    unavailable,
    start,
    stop
  }
}
