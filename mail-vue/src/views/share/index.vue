<template>
  <div
    class="share-shell"
    data-share-shell="cloud-mail-share-shell"
    :data-share-state="state"
  >
    <header class="share-top">
      <p v-if="state === 'loading'">{{ tx('shareVisitLoading', 'Opening shared mailbox...') }}</p>
      <p v-else-if="state === 'authRequired'">{{ tx('shareVisitAuthTitle', 'This share needs an access key.') }}</p>
      <p v-else-if="state === 'ready'">{{ tx('shareVisitReady', 'Shared mailbox') }}{{ readyMailboxLabel }}</p>
      <p v-else-if="state === 'unavailable'">{{ tx('shareVisitUnavailable', 'This link is no longer available.') }}</p>
      <p v-else-if="state === 'timedout'">{{ tx('shareVisitTimedOut', 'Your session timed out. Open your original link again.') }}</p>
      <p v-else-if="state === 'limited'">{{ tx('shareVisitLimited', 'Too many attempts. Please wait a moment and try again.') }}</p>
      <p v-else-if="state === 'exited'">{{ tx('shareVisitExited', 'You have left this share.') }}</p>
      <!-- No aria-live: a countdown that re-announces every second is a screen-reader
           denial of service. The datetime attribute carries the machine-readable value. -->
      <time
        v-if="expiresLabel"
        class="share-expires"
        data-share-expires
        :datetime="expiresIso"
      >{{ expiresLabel }}</time>
      <button
        v-if="state === 'ready'"
        type="button"
        data-share-exit
        @click="exitShare"
      >
        {{ tx('shareVisitExit', 'Leave') }}
      </button>
    </header>

    <p
      v-if="showWait"
      class="share-wait"
      data-share-wait
    >{{ tx('shareVisitWait', 'Please wait a moment, then try again.') }}</p>

    <form
      v-if="state === 'authRequired'"
      class="share-auth"
      data-share-auth
      @submit.prevent="submitAuthKey"
    >
      <label
        class="share-auth-label"
        for="share-auth-key"
      >{{ tx('shareVisitAuthLabel', 'Access key') }}</label>
      <div class="share-auth-row">
        <input
          id="share-auth-key"
          v-model="authKeyInput"
          class="share-auth-input"
          data-share-auth-input
          type="text"
          autocomplete="off"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
          :aria-invalid="authError ? 'true' : undefined"
          :aria-describedby="authError ? 'share-auth-error' : undefined"
        >
        <button
          type="submit"
          class="share-auth-submit"
          data-share-auth-submit
          :disabled="authSubmitting || !authKeyInput.trim()"
        >{{ authSubmitting ? tx('shareVisitAuthChecking', 'Checking...') : tx('shareVisitAuthSubmit', 'Open') }}</button>
      </div>
      <p
        v-if="authError"
        id="share-auth-error"
        class="share-auth-error"
        data-share-auth-error
        role="alert"
      >{{ tx('shareVisitAuthRetry', 'That key did not work. Check it and try again.') }}</p>
    </form>

    <div v-if="state === 'ready'" data-share-body>
      <nav
        v-if="isMulti"
        class="share-tabs"
        data-share-tabs
        role="tablist"
        :aria-label="tx('shareVisitMailboxes', 'Mailboxes')"
      >
        <button
          v-for="(box, index) in mailboxes"
          :key="box.bindingId"
          type="button"
          role="tab"
          class="share-tab"
          :id="tabId(box.bindingId)"
          :data-share-tab="box.bindingId"
          aria-controls="share-tabpanel"
          :aria-selected="box.bindingId === activeBinding ? 'true' : 'false'"
          :tabindex="box.bindingId === activeBinding ? 0 : -1"
          @click="selectTab(box.bindingId)"
          @keydown="onTabKeydown($event, index)"
        >
          <span>{{ box.address || MASKED_ADDRESS }}</span>
          <span
            v-if="tabHasNew(box)"
            class="share-tab-dot"
            data-share-tab-badge
            role="img"
            :aria-label="tx('shareVisitNewMail', 'New mail')"
          ></span>
        </button>
      </nav>

      <!-- Refreshes the whole page, not one Tab, so it sits outside the tabpanel. -->
      <button
        v-if="!autoRefresh"
        type="button"
        class="share-refresh"
        data-share-refresh
        :disabled="refreshing"
        :aria-busy="refreshing ? 'true' : undefined"
        @click="manualRefresh"
      >{{ refreshing ? tx('shareVisitRefreshing', 'Checking...') : tx('shareVisitRefresh', 'Check for new mail') }}</button>

      <div
        id="share-tabpanel"
        :role="isMulti ? 'tabpanel' : undefined"
        :aria-labelledby="isMulti ? tabId(activeBinding) : undefined"
      >
        <!-- Keyed by Binding: the copy confirmation belongs to one mailbox's code, so it
             must not survive a Tab switch. -->
        <ShareOtpCard
          :key="activeBinding"
          :mails="visibleMails"
          :selected="selectedMail"
          :enabled="otpEnabled"
        />

        <p
          v-if="!visibleMails.length"
          class="share-empty"
          data-share-empty
        >{{ tx('shareVisitEmpty', 'No mail yet. New messages will appear here.') }}</p>

        <ul
          v-else
          class="share-list"
          data-share-mail-list
        >
          <li
            v-for="item in listMails"
            :key="mailKey(item)"
          >
            <button
              type="button"
              :data-share-mail="mailKey(item)"
              :aria-current="isSelected(item) ? 'true' : undefined"
              @click="selectedId = mailKey(item)"
            >
              <span>{{ item.subject || tx('shareVisitNoSubject', '(no subject)') }}</span>
              <span class="share-list-from">{{ senderLine(item) }}</span>
            </button>
          </li>
        </ul>

        <article
          v-if="selectedMail"
          class="share-detail"
        >
          <p class="share-from">{{ tx('shareVisitFrom', 'From') }} {{ senderLine(selectedMail) }}</p>
          <h2>{{ selectedMail.subject || tx('shareVisitNoSubject', '(no subject)') }}</h2>
          <SafeMailRenderer
            :text="selectedMail.text || ''"
            :html="selectedMail.content || ''"
            default-mode="text"
          />
          <p
            v-if="hasHtml(selectedMail)"
            class="share-remote-hint"
          >{{ tx('shareVisitRemoteHint', 'Opening HTML may load images from the sender, which can reveal that you opened this mail.') }}</p>
          <ul
            v-if="selectedMail.attachments && selectedMail.attachments.length"
            class="share-atts"
          >
            <li
              v-for="att in selectedMail.attachments"
              :key="att.attachmentId"
            >
              <button
                type="button"
                data-share-attachment
                @click="downloadAttachment(selectedMail, att)"
              >
                {{ tx('shareVisitDownload', 'Download') }} {{ att.filename || 'attachment' }}
              </button>
            </li>
          </ul>
        </article>
      </div>
    </div>
    <div v-else data-share-body></div>
  </div>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import SafeMailRenderer from '@/components/safe-mail/index.vue'
import { POLL_INTERVAL_MS, useSharePolling } from '@/composables/useSharePolling.js'
import {
    createShareSession,
    getShareAttachment,
    getShareMailboxesStatus,
    isShareAuthRequired,
    isShareRateLimited,
    isShareUnavailable,
    listShareMails
} from '@/request/share.js'
import {
    clearEstablishKey,
    clearOtherShareSessions,
    clearShareSession,
    consumeShareSecret,
    ensureEstablishKey,
    readShareSession,
    writeShareSession
} from './session.js'
import { senderLine } from './mail-fields.js'
import {
    advance,
    hasNew,
    readWatermarks,
    reconcile,
    writeWatermarks
} from './status-watermark.js'
import ShareOtpCard from './ShareOtpCard.vue'

defineOptions({
    name: 'share'
})

const PAGE_LIMIT = 50
const MAX_CATCHUP_PAGES = 40
// Same placeholder the projection uses for an address it cannot parse, so a Binding that
// only the status frame knows about still gets a label instead of a bare dot.
const MASKED_ADDRESS = '***'

const route = useRoute()
const { t, te, locale } = useI18n()

const state = ref('loading')
const mailbox = ref('')
const sessionToken = ref('')
const pageSecret = ref('')
const mails = ref([])
const selectedId = ref('')
const rateLimited = ref(false)
const otpEnabled = ref(true)
const shareType = ref('single')
const mailboxes = ref([])
const activeBinding = ref(null)
const watermarks = ref({})
const autoRefresh = ref(true)
const refreshIntervalMs = ref(POLL_INTERVAL_MS)
const refreshing = ref(false)
const expiresAt = ref('')
const nowMs = ref(Date.now())
// Memory only: an access key must never reach sessionStorage, the URL or a log line.
const authKeyInput = ref('')
// A boolean, not a counter — a counter is the first brick of a lockout UI, and the edge
// rate limit is the only throttle this page is allowed to have (AC-AUTH-06).
const authError = ref(false)
const authSubmitting = ref(false)
let justRecovered = false
// useRoute() no longer answers once teardown starts, and by then the router may already
// have moved on, so the lid this page owns is remembered while it is still alive.
let ownedLid = ''

function mailKey(item) {
    return item && item.mailId != null ? String(item.mailId) : ''
}

function hasHtml(item) {
    return Boolean(item && item.content && String(item.content).trim())
}

function tx(key, fallback) {
    return te(key) ? t(key) : fallback
}

function applyShareLocale() {
    const lang = String(navigator.language || 'en').split('-')[0] === 'zh' ? 'zh' : 'en'
    document.documentElement.lang = lang
    locale.value = lang
}

function currentLid() {
    return String(route.params.lid || '')
}

function mergeMails(incoming) {
    const byId = new Map(mails.value.map((item) => [mailKey(item), item]))
    for (const item of incoming || []) {
        const key = mailKey(item)
        if (key) {
            byId.set(key, item)
        }
    }
    mails.value = [...byId.values()].sort((a, b) => Number(a.mailId) - Number(b.mailId))
}

async function fetchMails(args) {
    try {
        const result = await listShareMails(args)
        rateLimited.value = false
        justRecovered = false
        return result
    } catch (err) {
        if (isShareRateLimited(err)) {
            rateLimited.value = true
        }
        throw err
    }
}

async function fetchStatus(args) {
    try {
        const result = await getShareMailboxesStatus(args)
        rateLimited.value = false
        return result
    } catch (err) {
        if (isShareRateLimited(err)) {
            rateLimited.value = true
        }
        throw err
    }
}

function onPolledMails(list) {
    rateLimited.value = false
    mergeMails(list)
}

function saveWatermarks(next) {
    watermarks.value = next
    writeWatermarks(currentLid(), next)
}

// The Binding whose mail this page just showed has been consumed up to the largest id the
// page actually carried — not to the status head, which may already be ahead of the page
// (design.md:348). An empty page advances nothing and the next tick retries.
function advanceFromPage(bindingId, list) {
    if (bindingId == null) {
        const groups = new Map()
        for (const item of list || []) {
            if (!item || item.bindingId == null) {
                continue
            }
            const rows = groups.get(item.bindingId) || []
            rows.push(item)
            groups.set(item.bindingId, rows)
        }
        for (const [id, rows] of groups) {
            advanceFromPage(id, rows)
        }
        return
    }
    const ids = (list || [])
        .filter((item) => item && item.bindingId === bindingId)
        .map((item) => Number(item.mailId))
        .filter((id) => Number.isFinite(id))
    if (!ids.length) {
        return
    }
    saveWatermarks(advance(watermarks.value, bindingId, Math.max(...ids)))
}

/**
 * One poll tick is one status read plus one mails read for the Tab in front of the
 * visitor — never one request per Binding (AC-OTP-07). The watermarks it writes drive
 * badges only: skipping the mails call when nothing looks new would lose the mail that
 * lands between the seeding frame and the first real one.
 * Errors are deliberately not caught: 429 backoff and SHARE_UNAVAILABLE belong to
 * useSharePolling, which can only see them if they propagate.
 */
async function pollTick({ sessionToken: token, limit, signal }) {
    const data = await fetchStatus({ sessionToken: token, signal })
    const list = Array.isArray(data && data.mailboxes) ? data.mailboxes : []
    saveWatermarks(reconcile(watermarks.value, list).map)
    syncMailboxesFromStatus(list)

    const bindingId = activeBinding.value
    const page = await fetchMails({ sessionToken: token, bindingId, limit, signal })
    advanceFromPage(bindingId, page && page.list)
    return page
}

const polling = useSharePolling({
    sessionToken,
    limit: PAGE_LIMIT,
    intervalMs: refreshIntervalMs,
    listShareMails: pollTick,
    onMails: onPolledMails,
    onUnavailable: (err) => {
        void noteShareFailure(err)
    }
})
polling.stop()

// The manual button runs the same tick the poller runs, so one click costs exactly one
// status plus one mails call and advances the watermarks identically. A second fetch path
// here would mean a second set of watermark semantics. pollTick deliberately does not
// catch, so this caller has to.
async function manualRefresh() {
    if (refreshing.value) {
        return
    }
    refreshing.value = true
    try {
        const page = await pollTick({ sessionToken: sessionToken.value, limit: PAGE_LIMIT })
        onPolledMails(page && page.list)
    } catch (err) {
        await noteShareFailure(err)
    } finally {
        refreshing.value = false
    }
}

// Binding count is the shareType SSOT (AC-CAP-02). A stored-token refresh never sees
// session.shareType, so tabs must appear once status hydrates two or more boxes.
const isMulti = computed(() => mailboxes.value.length > 1)

const readyMailboxLabel = computed(() => {
    if (isMulti.value || !mailbox.value) {
        return ''
    }
    return `: ${mailbox.value}`
})

// A row whose bindingId the projection could not resolve belongs to no Tab, but it is
// still the whole list on a single-mailbox page.
const visibleMails = computed(() => {
    if (!isMulti.value || activeBinding.value == null) {
        return mails.value
    }
    return mails.value.filter((item) => item.bindingId === activeBinding.value)
})

const listMails = computed(() => [...visibleMails.value].reverse())

const selectedMail = computed(() => {
    const visible = visibleMails.value
    if (!selectedId.value) {
        return visible.length ? visible[visible.length - 1] : null
    }
    return visible.find((item) => mailKey(item) === selectedId.value) || null
})

function tabId(bindingId) {
    return `share-tab-${bindingId}`
}

function tabHasNew(box) {
    return box.bindingId !== activeBinding.value
        && hasNew(watermarks.value, box.bindingId, box.latestEmailId)
}

function setActiveBinding(bindingId) {
    if (activeBinding.value === bindingId) {
        return
    }
    activeBinding.value = bindingId
    // No per-Tab memory: coming back selects that Tab's newest mail, same as first paint.
    selectedId.value = ''
}

function pickActiveBinding() {
    const list = mailboxes.value
    if (!list.length) {
        setActiveBinding(null)
        return
    }
    if (!list.some((box) => box.bindingId === activeBinding.value)) {
        setActiveBinding(list[0].bindingId)
    }
}

function setMailboxes(list) {
    mailboxes.value = (Array.isArray(list) ? list : []).filter((box) => box && box.bindingId != null)
    shareType.value = mailboxes.value.length > 1 ? 'multi' : 'single'
    pickActiveBinding()
}

// The status frame is the live set of Bindings: one that disappeared loses its Tab, its
// mail and its watermark, and the active Tab falls back to the first (AC-EDGE-04). The
// masked address only ever arrives with the session response, so it is carried over.
function syncMailboxesFromStatus(list) {
    const rows = list.filter((item) => item && item.bindingId != null)
    if (!rows.length) {
        return
    }
    const known = new Map(mailboxes.value.map((box) => [box.bindingId, box]))
    mailboxes.value = rows.map((item) => ({
        address: '',
        ...known.get(item.bindingId),
        bindingId: item.bindingId,
        latestEmailId: item.latestEmailId
    }))
    const live = rows.map((item) => item.bindingId)
    mails.value = mails.value.filter((item) => item.bindingId == null || live.includes(item.bindingId))
    shareType.value = mailboxes.value.length > 1 ? 'multi' : 'single'
    pickActiveBinding()
}

async function selectTab(bindingId) {
    if (bindingId == null) {
        return
    }
    const box = mailboxes.value.find((item) => item.bindingId === bindingId)
    const unread = Boolean(box && hasNew(watermarks.value, box.bindingId, box.latestEmailId))
    setActiveBinding(bindingId)
    const cached = mails.value.filter((item) => item.bindingId === bindingId)
    if (cached.length && !unread) {
        advanceFromPage(bindingId, cached)
        return
    }
    try {
        const page = await fetchMails({
            sessionToken: sessionToken.value,
            bindingId,
            limit: PAGE_LIMIT
        })
        const list = page && Array.isArray(page.list) ? page.list : []
        mergeMails(list)
        advanceFromPage(bindingId, list)
    } catch (err) {
        await noteShareFailure(err)
    }
}

function onTabKeydown(event, index) {
    const step = event.key === 'ArrowRight' ? 1 : (event.key === 'ArrowLeft' ? -1 : 0)
    if (!step) {
        return
    }
    event.preventDefault()
    const list = mailboxes.value
    const nextIndex = (index + step + list.length) % list.length
    void selectTab(list[nextIndex].bindingId)
    const tabs = event.currentTarget.parentNode.querySelectorAll('[data-share-tab]')
    if (tabs[nextIndex]) {
        tabs[nextIndex].focus()
    }
}

const showWait = computed(() => rateLimited.value || state.value === 'limited')

// expires_at is a bare 'YYYY-MM-DD HH:mm:ss' the worker wrote in UTC and compares as a
// string, with no zone marker on it. Left to the browser it would be read as local time,
// which hands a UTC+8 visitor eight free hours.
const expiresMs = computed(() => {
    const raw = String(expiresAt.value || '').trim()
    if (!raw) {
        return NaN
    }
    return Date.parse(`${raw.replace(' ', 'T')}Z`)
})

const expiresIso = computed(() => (
    Number.isFinite(expiresMs.value) ? new Date(expiresMs.value).toISOString() : ''
))

const expiresLabel = computed(() => {
    const left = expiresMs.value - nowMs.value
    if (!Number.isFinite(left) || left <= 0) {
        return ''
    }
    const minutes = Math.ceil(left / 60000)
    const shown = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`
    return `${tx('shareVisitExpiresIn', 'Link expires in')} ${shown}`
})

function isSelected(item) {
    const current = selectedMail.value
    return Boolean(current && mailKey(current) === mailKey(item))
}

// A downstream interval below the poll floor would have the visitor's own browser firing
// two requests every few milliseconds, so the client clamps as well as the worker does.
function clampInterval(value) {
    const ms = Number(value)
    return Number.isFinite(ms) && ms > POLL_INTERVAL_MS ? Math.floor(ms) : POLL_INTERVAL_MS
}

// The single reader of the /share/session response body. T-26 extends this one helper for
// autoRefresh / refreshIntervalMs / expiresAt rather than opening a second read point.
function applyShareConfig(data) {
    otpEnabled.value = !(data && data.config && data.config.otpExtractionEnabled === false)
    shareType.value = data && data.shareType === 'multi' ? 'multi' : 'single'
    setMailboxes(data && data.mailboxes)
    autoRefresh.value = !(data && data.config && data.config.autoRefresh === false)
    refreshIntervalMs.value = clampInterval(data && data.config && data.config.refreshIntervalMs)
    expiresAt.value = (data && data.expiresAt) || ''
}

function logShareFailure(err) {
    const status = (err && ((err.response && err.response.status) || err.status)) || null
    let code = 'SHARE_REQUEST_FAILED'
    if (err && (err.code === 'SHARE_UNAVAILABLE' || err.message === 'SHARE_UNAVAILABLE')) {
        code = 'SHARE_UNAVAILABLE'
    } else if (isShareRateLimited(err)) {
        code = 'RATE_LIMITED'
    } else if (status) {
        code = `SHARE_HTTP_${status}`
    }
    console.error('[share]', code, status)
}

function hadWorkingSession() {
    return Boolean(sessionToken.value || (currentLid() && readShareSession(currentLid())))
}

// Only a request that never came back may be replayed. A rejected business envelope, a
// 429 and anything carrying err.response all mean the worker already answered, so
// resending would spend a second session slot and more rate-limit budget for nothing.
function isLostResponse(err) {
    return Boolean(err)
        && !err.response
        && !isShareRateLimited(err)
        && !isShareUnavailable(err)
        && !isShareAuthRequired(err)
        && (err instanceof Error || !Object.prototype.hasOwnProperty.call(err, 'code'))
}

// The only POST /share/session in this page. The key is written before the request goes
// out, so a wrong AuthKey, a retry and a lost response all replay under the same one
// (AC-SESS-10). One replay, not a backoff ladder: backoff belongs to the poller.
async function postSession(lid, sec, authKey) {
    const idempotencyKey = ensureEstablishKey(lid)
    try {
        return await createShareSession(lid, sec, { authKey, idempotencyKey })
    } catch (err) {
        if (!isLostResponse(err)) {
            throw err
        }
        return await createShareSession(lid, sec, { authKey, idempotencyKey })
    }
}

// Everything that happens once a token exists. reestablishSession stays out of this: it
// deliberately leaves state alone and lets noteShareFailure drive the recovery.
function enterReady(lid, data) {
    writeShareSession(lid, data.sessionToken)
    clearEstablishKey(lid)
    sessionToken.value = data.sessionToken
    applyShareConfig(data)
    mailbox.value = (data && data.mailbox) || ''
    state.value = 'ready'
}

function clearMailboxView() {
    const lid = currentLid()
    if (lid) {
        clearShareSession(lid)
        clearEstablishKey(lid)
    }
    sessionToken.value = ''
    mailbox.value = ''
    mails.value = []
    selectedId.value = ''
    rateLimited.value = false
}

function showDeadShare(err) {
    polling.stop()
    clearMailboxView()
    state.value = 'unavailable'
    if (err) {
        logShareFailure(err)
    }
}

function showTimedOut(err) {
    polling.stop()
    clearMailboxView()
    state.value = 'timedout'
    if (err) {
        logShareFailure(err)
    }
}

async function reestablishSession() {
    const lid = currentLid()
    const sec = pageSecret.value
    if (!lid || !sec) {
        return false
    }
    const data = await postSession(lid, sec, '')
    const token = data && data.sessionToken
    if (!token) {
        return false
    }
    writeShareSession(lid, token)
    clearEstablishKey(lid)
    sessionToken.value = token
    applyShareConfig(data)
    if (data.mailbox) {
        mailbox.value = data.mailbox
    }
    return true
}

async function recoverFromUnavailable(err, fromSession = false) {
    if (isShareRateLimited(err)) {
        rateLimited.value = true
        if (state.value !== 'ready') {
            state.value = 'limited'
        }
        return false
    }
    if (!(fromSession || isShareUnavailable(err) || !err)) {
        rateLimited.value = true
        logShareFailure(err)
        return false
    }
    if (fromSession) {
        showDeadShare(err)
        return false
    }
    if (justRecovered) {
        justRecovered = false
        showDeadShare(err)
        return false
    }
    if (pageSecret.value) {
        try {
            const ok = await reestablishSession()
            if (!ok) {
                showDeadShare(err)
                return false
            }
            justRecovered = true
            polling.unavailable.value = false
            state.value = 'ready'
            return true
        } catch (reErr) {
            if (isShareRateLimited(reErr)) {
                rateLimited.value = true
                if (state.value !== 'ready') {
                    state.value = 'limited'
                }
                return false
            }
            showDeadShare(reErr)
            return false
        }
    }
    if (hadWorkingSession()) {
        showTimedOut(err)
        return false
    }
    showDeadShare(err)
    return false
}

async function noteShareFailure(err, fromSession = false) {
    const recovered = await recoverFromUnavailable(err, fromSession)
    if (recovered) {
        await beginMailbox()
    }
}

// A wrong key costs no quota and writes no cache on the worker, which is why the visitor
// may keep trying and why the same idempotency key stays valid across attempts.
async function submitAuthKey() {
    const lid = currentLid()
    const sec = pageSecret.value
    const key = authKeyInput.value.trim()
    if (!key || authSubmitting.value || !lid || !sec) {
        return
    }
    authSubmitting.value = true
    authError.value = false
    // A fresh attempt makes the previous "please wait" notice stale.
    rateLimited.value = false
    try {
        const data = await postSession(lid, sec, key)
        if (!data || !data.sessionToken) {
            authError.value = true
            return
        }
        authKeyInput.value = ''
        enterReady(lid, data)
        await beginMailbox()
    } catch (err) {
        if (isShareAuthRequired(err)) {
            authError.value = true
            return
        }
        // 429 is the edge throttling the route, not a verdict on the key.
        if (isShareRateLimited(err)) {
            rateLimited.value = true
            return
        }
        await noteShareFailure(err, true)
    } finally {
        authSubmitting.value = false
    }
}

function exitShare() {
    polling.stop()
    pageSecret.value = ''
    justRecovered = false
    const lid = currentLid()
    if (lid) {
        clearShareSession(lid)
        clearEstablishKey(lid)
    }
    sessionToken.value = ''
    mailbox.value = ''
    mails.value = []
    selectedId.value = ''
    rateLimited.value = false
    state.value = 'exited'
}

function resetMailbox() {
    polling.stop()
    polling.unavailable.value = false
    mails.value = []
    selectedId.value = ''
    rateLimited.value = false
}

async function beginMailbox() {
    polling.unavailable.value = false
    try {
        let cursor = null
        let pages = 0
        while (pages < MAX_CATCHUP_PAGES) {
            // The cursor is "older than", so it belongs to this catch-up loop only. The poll
            // path asks for the newest page instead, and mergeMails deduplicates by mailId.
            const result = await listShareMails({
                sessionToken: sessionToken.value,
                cursor,
                bindingId: activeBinding.value,
                limit: PAGE_LIMIT
            })
            const list = result && Array.isArray(result.list) ? result.list : []
            mergeMails(list)
            advanceFromPage(activeBinding.value, list)
            const next = result && result.nextCursor
            if (!next || !list.length || list.length < PAGE_LIMIT) {
                break
            }
            cursor = next
            pages += 1
        }
        if (!selectedId.value && mails.value.length) {
            selectedId.value = mailKey(mails.value[mails.value.length - 1])
        }
        justRecovered = false
        rateLimited.value = false
        if (autoRefresh.value) {
            polling.start()
        }
    } catch (err) {
        if (isShareRateLimited(err)) {
            rateLimited.value = true
            // Both gates, not just the happy path: a share with auto refresh off must not
            // start polling merely because it walked into a 429.
            if (autoRefresh.value) {
                polling.start()
            }
            return
        }
        await noteShareFailure(err)
    }
}

async function downloadAttachment(item, attachment) {
    try {
        const blob = await getShareAttachment({
            sessionToken: sessionToken.value,
            mailId: item.mailId,
            attachmentId: attachment.attachmentId
        })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = attachment.filename || 'attachment'
        link.rel = 'noopener'
        document.body.appendChild(link)
        link.click()
        link.remove()
        URL.revokeObjectURL(url)
    } catch (err) {
        await noteShareFailure(err)
    }
}

async function bootstrap() {
    applyShareLocale()
    resetMailbox()
    otpEnabled.value = true
    autoRefresh.value = true
    refreshIntervalMs.value = POLL_INTERVAL_MS
    expiresAt.value = ''
    authKeyInput.value = ''
    authError.value = false
    authSubmitting.value = false
    const lid = currentLid()
    ownedLid = lid
    shareType.value = 'single'
    mailboxes.value = []
    activeBinding.value = null
    // Read progress is per lid and survives a reload; a different lid must never inherit it.
    watermarks.value = readWatermarks(lid)
    state.value = 'loading'
    mailbox.value = ''
    if (!lid) {
        state.value = 'unavailable'
        return
    }
    clearOtherShareSessions(lid)
    pageSecret.value = ''
    justRecovered = false
    const sec = consumeShareSecret(lid)
    if (sec) {
        pageSecret.value = sec
        try {
            const data = await postSession(lid, sec, '')
            if (!data || !data.sessionToken) {
                clearShareSession(lid)
                state.value = 'unavailable'
                return
            }
            enterReady(lid, data)
            await beginMailbox()
        } catch (err) {
            // Diverted before noteShareFailure, whose fromSession=true reads every session
            // error as a dead link. recoverFromUnavailable keeps its meaning untouched.
            if (isShareAuthRequired(err)) {
                state.value = 'authRequired'
                return
            }
            await noteShareFailure(err, true)
        }
        return
    }
    const existing = readShareSession(lid)
    if (existing) {
        sessionToken.value = existing
        state.value = 'ready'
        await beginMailbox()
        return
    }
    state.value = 'unavailable'
}

watch(() => route.params.lid, bootstrap, { immediate: true })

// The countdown is minute-level, so the local clock is accurate enough; aligning to the
// status frame's serverTime would buy a second ref and no visible correctness.
const clockTimer = setInterval(() => {
    nowMs.value = Date.now()
}, 1000)

onUnmounted(() => {
    clearInterval(clockTimer)
    pageSecret.value = ''
    justRecovered = false
    // The router already drops share:session on a real navigation; doing both here keeps
    // AC-SEC-07 testable at component level. share:status is read progress, not a
    // credential, and stays.
    if (ownedLid) {
        clearShareSession(ownedLid)
        clearEstablishKey(ownedLid)
    }
})

defineExpose({
    noteShareFailure,
    exitShare
})
</script>

<style scoped>
.share-shell {
    min-height: 100%;
    padding: 24px;
    box-sizing: border-box;
    max-width: 720px;
    margin: 0 auto;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #1f2328;
    line-height: 1.5;
}

.share-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
}

.share-top p {
    margin: 0;
}

.share-top button,
.share-list button,
.share-atts button {
    font: inherit;
    cursor: pointer;
}

.share-wait,
.share-empty,
.share-remote-hint {
    color: #4b5563;
}

/* Pushed to the right so the countdown sits with the Leave button, not between it and
   the title. Tabular figures keep the row from twitching as the digits change. */
.share-expires {
    margin-left: auto;
    color: #4b5563;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}

.share-auth {
    margin: 16px 0 0;
}

.share-auth-label {
    display: block;
    margin-bottom: 6px;
    font-size: 13px;
    color: #4b5563;
}

.share-auth-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.share-auth-input {
    flex: 1 1 12rem;
    min-width: 0;
    padding: 10px 12px;
    font: inherit;
    color: #1f2328;
    background: #fff;
    border: 1px solid #d0d7de;
    border-radius: 6px;
}

.share-auth-input[aria-invalid="true"] {
    border-color: #cf222e;
}

.share-auth-submit,
.share-refresh {
    padding: 10px 12px;
    font: inherit;
    color: #1f2328;
    background: #f6f8fa;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    cursor: pointer;
}

.share-auth-submit:disabled,
.share-refresh:disabled {
    color: #8c959f;
    cursor: default;
}

.share-auth-input:focus-visible,
.share-auth-submit:focus-visible,
.share-refresh:focus-visible {
    outline: 2px solid #0969da;
    outline-offset: -2px;
}

/* Beside the field it belongs to, not in a banner at the top of the page. */
.share-auth-error {
    margin: 8px 0 0;
    color: #cf222e;
    font-size: 13px;
}

.share-refresh {
    margin: 16px 0 0;
}

.share-tabs {
    display: flex;
    flex-wrap: wrap;
    margin: 16px 0 0;
    border-bottom: 1px solid #d0d7de;
}

.share-tab {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-bottom: -1px;
    padding: 10px 12px;
    font: inherit;
    color: #4b5563;
    background: none;
    border: 0;
    border-bottom: 2px solid transparent;
    border-radius: 6px 6px 0 0;
    cursor: pointer;
}

.share-tab:hover {
    color: #1f2328;
    background: #f6f8fa;
}

/* Selection is weight plus a rule, not colour alone. */
.share-tab[aria-selected="true"] {
    color: #1f2328;
    font-weight: 600;
    border-bottom-color: #0969da;
}

.share-tab:focus-visible {
    outline: 2px solid #0969da;
    outline-offset: -2px;
}

.share-tab-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #0969da;
}

.share-list {
    list-style: none;
    margin: 0 0 24px;
    padding: 0;
}

.share-list button {
    display: flex;
    flex-direction: column;
    width: 100%;
    margin: 0 0 8px;
    padding: 10px 12px;
    text-align: left;
    background: #fff;
    border: 1px solid #d0d7de;
    border-radius: 6px;
}

.share-list button[aria-current="true"] {
    border-color: #0969da;
}

.share-list-from,
.share-from {
    color: #4b5563;
    font-size: 13px;
}

.share-detail h2 {
    margin: 4px 0 16px;
    font-size: 20px;
}

.share-atts {
    list-style: none;
    margin: 16px 0 0;
    padding: 0;
}

.share-atts button {
    padding: 6px 10px;
    background: #fff;
    border: 1px solid #d0d7de;
    border-radius: 6px;
}
</style>
