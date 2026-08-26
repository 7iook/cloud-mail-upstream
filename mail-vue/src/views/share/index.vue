<template>
  <div
    class="share-shell"
    data-share-shell="cloud-mail-share-shell"
    :data-share-state="state"
  >
    <!-- P5 视觉包裹:桌面居中白卡片(max-width 640px),移动去浮层全宽。
         data-share-* 钩子零改,逻辑零改。 -->
    <div class="share-card">
    <header class="share-top">
      <p v-if="state === 'loading'" class="share-loading"><span class="share-spinner" aria-hidden="true"></span>{{ tx('shareVisitLoading', 'Opening shared mailbox...') }}</p>
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

      <!-- Refreshes the whole page, not one Tab, so it sits outside the tabpanel. Shown
           even while auto refresh runs: a visitor waiting on a code wants to ask now
           rather than sit out the rest of the poll interval. -->
      <button
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
          <!-- The code is not always the whole point: activation steps and account names
               live in the body too, and dragging a selection inside the sandboxed iframe
               is the only alternative the visitor has. -->
          <div class="share-copy-all">
            <button
              type="button"
              data-share-copy-all
              :disabled="!fullMailText"
              @click="copyFullMail"
            >{{ tx('shareVisitCopyAll', 'Copy full email') }}</button>
            <textarea
              class="share-copy-all-select"
              :class="{ 'is-visible': copyAllResult === 'manual' }"
              :ref="bindBodySelectable"
              readonly
              rows="4"
              :value="fullMailText"
              :aria-label="tx('shareVisitCopyAll', 'Copy full email')"
            ></textarea>
            <p
              v-if="copyAllResult"
              :data-share-copy-all-result="copyAllResult"
            >{{ copyAllResult === 'copied' ? tx('shareVisitCopiedAll', 'Full email copied') : tx('shareVisitCopyManual', 'Select the code and copy it yourself') }}</p>
          </div>
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
  </div>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import SafeMailRenderer from '@/components/safe-mail/index.vue'
import { useCopyWithFallback } from '@/composables/useCopyWithFallback.js'
import { POLL_INTERVAL_MS, useSharePolling } from '@/composables/useSharePolling.js'
import {
    createShareSession,
    getShareAttachment,
    getShareMailboxesStatus,
    isShareAuthRequired,
    isShareGone,
    isShareRateLimited,
    isShareUnavailable,
    listShareMails
} from '@/request/share.js'
import {
    blankShareDocument,
    clearEstablishKey,
    clearOtherShareSessions,
    clearShareSession,
    consumeShareSecret,
    ensureEstablishKey,
    markShareGone,
    readShareSession,
    reloadShareDocument,
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
const { copy: copyBody, selectableRef: bodySelectableRef } = useCopyWithFallback()

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
// The watermarks drive Tab badges, which are deliberately blind to the Tab in front of
// the visitor. This flag is the other half: it arms the toast for that Tab only after the
// first page has landed, so the initial load is not announced as an arrival.
let newMailToastArmed = false
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

function maxVisibleMailId() {
    const ids = visibleMails.value
        .map((item) => Number(item.mailId))
        .filter((id) => Number.isFinite(id))
    return ids.length ? Math.max(...ids) : -1
}

// One toast per arrival, not per mail: a catch-up tick can bring back several at once and
// a stack of identical notices tells the visitor nothing the list does not already show.
// Only armed once the first page has settled, so opening a full mailbox stays quiet.
function onPolledMails(list) {
    rateLimited.value = false
    const before = maxVisibleMailId()
    mergeMails(list)
    if (newMailToastArmed && maxVisibleMailId() > before && typeof ElMessage === 'function') {
        ElMessage({
            message: tx('shareVisitNewMailToast', 'New mail received'),
            type: 'info'
        })
    }
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

// text is the plain body the projection already sends in full; content is the fallback for
// an HTML-only mail, where the raw markup is still closer to "everything in this mail"
// than the empty string is.
const fullMailText = computed(() => {
    const item = selectedMail.value
    if (!item) {
        return ''
    }
    return String(item.text || item.content || '')
})

const copyAllResult = ref('')

function bindBodySelectable(el) {
    bodySelectableRef.value = el
}

async function copyFullMail() {
    if (!fullMailText.value) {
        return
    }
    const result = await copyBody(fullMailText.value)
    copyAllResult.value = result.copied ? 'copied' : 'manual'
    if (result.copied && typeof ElMessage === 'function') {
        ElMessage({
            message: tx('shareVisitCopiedAll', 'Full email copied'),
            type: 'success'
        })
    }
}

// The confirmation belongs to one mail's body, exactly as the code card's does.
watch(selectedMail, () => {
    copyAllResult.value = ''
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
    // Mail this Tab was already holding is not news to the visitor who just asked to see
    // it. Only a visitor-driven switch disarms: the status frame reassigning the active
    // Binding is bookkeeping, and silencing the toast for it would lose real arrivals.
    newMailToastArmed = false
    setActiveBinding(bindingId)
    const cached = mails.value.filter((item) => item.bindingId === bindingId)
    if (cached.length && !unread) {
        advanceFromPage(bindingId, cached)
        newMailToastArmed = true
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
        // Whatever this Tab was carrying is now on screen; the next arrival is real news.
        newMailToastArmed = true
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
    } else if (isShareGone(err)) {
        code = 'SHARE_DESTROYED'
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
// 429, a gone 404 and anything carrying err.response all mean the worker already
// answered, so resending would spend a second session slot and more rate-limit budget
// for nothing.
function isLostResponse(err) {
    return Boolean(err)
        && !err.response
        && !isShareRateLimited(err)
        && !isShareUnavailable(err)
        && !isShareAuthRequired(err)
        && !isShareGone(err)
        && (err instanceof Error || !Object.prototype.hasOwnProperty.call(err, 'code'))
}

// The only POST /share/session in this page. The key is written before the request goes
// out, so a wrong AuthKey, a retry and a lost response all replay under the same one
// (AC-SESS-10). One replay, not a backoff ladder: backoff belongs to the poller.
async function postSession(lid, sec, authKey, previousSessionToken = '') {
    const idempotencyKey = ensureEstablishKey(lid)
    try {
        return await createShareSession(lid, sec, { authKey, idempotencyKey, previousSessionToken })
    } catch (err) {
        if (!isLostResponse(err)) {
            throw err
        }
        return await createShareSession(lid, sec, { authKey, idempotencyKey, previousSessionToken })
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
    expiresAt.value = ''
}

function showDeadShare(err) {
    polling.stop()
    clearMailboxView()
    state.value = 'unavailable'
    if (err) {
        logShareFailure(err)
    }
}

// P4:销毁(HTTP 404)不许画任何业务页。第一眼 reload —— 生产环境 reload 会落到
// worker 的文档拦截,访客看到浏览器原生 404;若 reload 又回到了 SPA(vite 直出、
// 不经 worker),记账识破循环,清空文档兜底。死链接的 token 在离开前清干净,
// 不留给 reload 之后的页面。
function handleShareGone(err) {
    polling.stop()
    logShareFailure(err)
    clearMailboxView()
    if (markShareGone(currentLid()) === 'reload') {
        reloadShareDocument()
        return
    }
    blankShareDocument()
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
    // The token being replaced is still in hand here: only showDeadShare / showTimedOut /
    // exitShare clear it, and every one of them runs after this call, never before it. It is
    // what lets the worker recognise the same visitor and renew without spending a second
    // access slot; a blank one would have the renewal counted as a fresh arrival.
    const data = await postSession(lid, sec, '', sessionToken.value)
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
    // gone 先于一切恢复逻辑:它不是「暂时不可用」,重建会话/重放都救不回一条
    // 已销毁的链接,唯一出路是把访客交还给浏览器原生 404。
    if (isShareGone(err)) {
        handleShareGone(err)
        return false
    }
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
    newMailToastArmed = false
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
    expiresAt.value = ''
    state.value = 'exited'
}

function resetMailbox() {
    polling.stop()
    polling.unavailable.value = false
    newMailToastArmed = false
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
        newMailToastArmed = true
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
/* P5 · UI 设计卡 token 挂 .share-shell;桌面居中白卡片,移动全宽。 */
.share-shell {
    --sh-bg: #f4f5f7;
    --sh-surface: #ffffff;
    --sh-accent: #3b5bdb;
    --sh-accent-soft: #edf2ff;
    --sh-text: #1b1f3b;
    --sh-muted: #5c5f77;
    --sh-warn: #f08c00;
    --sh-danger: #c92a2a;
    --sh-radius: 16px;

    min-height: 100%;
    padding: 32px 16px 48px;
    box-sizing: border-box;
    background: var(--sh-bg);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    color: var(--sh-text);
    line-height: 1.5;
}

.share-card {
    max-width: 640px;
    margin: 0 auto;
    padding: 24px;
    box-sizing: border-box;
    background: var(--sh-surface);
    border-radius: var(--sh-radius);
    box-shadow: 0 12px 32px rgba(27, 31, 59, 0.08);
}

/* authRequired:窄卡,只留输入 + 提交。 */
.share-shell[data-share-state="authRequired"] .share-card {
    max-width: 420px;
}

/* unavailable / timedout / exited:居中终态卡。销毁态不经过这里(P4 原生 404),
   所以本页不设计 gone 插画。 */
.share-shell[data-share-state="unavailable"] .share-card,
.share-shell[data-share-state="timedout"] .share-card,
.share-shell[data-share-state="exited"] .share-card {
    max-width: 480px;
    text-align: center;
}

.share-shell[data-share-state="unavailable"] .share-top,
.share-shell[data-share-state="timedout"] .share-top,
.share-shell[data-share-state="exited"] .share-top {
    justify-content: center;
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

/* loading:卡片内 spinner,文案保留。动画包在 prefers-reduced-motion 里。 */
.share-spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    margin-right: 8px;
    vertical-align: -3px;
    border: 2px solid var(--sh-accent-soft);
    border-top-color: var(--sh-accent);
    border-radius: 50%;
}

@media (prefers-reduced-motion: no-preference) {
    .share-spinner {
        animation: share-spin 0.8s linear infinite;
    }

    @keyframes share-spin {
        to {
            transform: rotate(360deg);
        }
    }
}

.share-empty,
.share-remote-hint {
    color: var(--sh-muted);
}

/* limited:警告横幅,不抢 OTP 的位置。 */
.share-wait {
    margin: 16px 0 0;
    padding: 10px 14px;
    color: var(--sh-text);
    background: rgba(240, 140, 0, 0.12);
    border: 1px solid var(--sh-warn);
    border-radius: calc(var(--sh-radius) - 8px);
}

/* ready + 空收件箱:一等等待卡,不是冰冷 empty。 */
.share-empty {
    margin: 20px 0 24px;
    padding: 28px 20px;
    text-align: center;
    background: var(--sh-bg);
    border: 1px dashed rgba(92, 95, 119, 0.4);
    border-radius: calc(var(--sh-radius) - 4px);
}

.share-empty::before {
    content: '';
    display: block;
    width: 10px;
    height: 10px;
    margin: 0 auto 10px;
    border-radius: 50%;
    background: var(--sh-accent);
}

@media (prefers-reduced-motion: no-preference) {
    .share-empty::before {
        animation: share-breathe 2s ease-in-out infinite;
    }

    @keyframes share-breathe {
        0%,
        100% {
            opacity: 0.35;
        }

        50% {
            opacity: 1;
        }
    }
}

/* Pushed to the right so the countdown sits with the Leave button, not between it and
   the title. Tabular figures keep the row from twitching as the digits change.
   No aria-live, by design (P1 信息层级 + 读屏防洪)。 */
.share-expires {
    margin-left: auto;
    color: var(--sh-muted);
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
    color: var(--sh-muted);
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
    color: var(--sh-text);
    background: var(--sh-surface);
    border: 1px solid rgba(92, 95, 119, 0.35);
    border-radius: calc(var(--sh-radius) - 8px);
}

.share-auth-input[aria-invalid="true"] {
    border-color: var(--sh-danger);
}

.share-auth-submit {
    padding: 10px 16px;
    font: inherit;
    color: #fff;
    background: var(--sh-accent);
    border: 1px solid var(--sh-accent);
    border-radius: calc(var(--sh-radius) - 8px);
    cursor: pointer;
}

.share-refresh,
.share-top button {
    padding: 10px 14px;
    font: inherit;
    color: var(--sh-text);
    background: var(--sh-surface);
    border: 1px solid rgba(92, 95, 119, 0.35);
    border-radius: calc(var(--sh-radius) - 8px);
    cursor: pointer;
}

.share-auth-submit:disabled,
.share-refresh:disabled {
    opacity: 0.55;
    cursor: default;
}

.share-auth-input:focus-visible,
.share-auth-submit:focus-visible,
.share-refresh:focus-visible {
    outline: 2px solid var(--sh-accent);
    outline-offset: -2px;
}

/* Beside the field it belongs to, not in a banner at the top of the page. */
.share-auth-error {
    margin: 8px 0 0;
    color: var(--sh-danger);
    font-size: 13px;
}

.share-refresh {
    margin: 16px 0 0;
}

.share-tabs {
    display: flex;
    flex-wrap: wrap;
    margin: 16px 0 0;
    border-bottom: 1px solid rgba(92, 95, 119, 0.25);
}

.share-tab {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-bottom: -1px;
    padding: 10px 12px;
    font: inherit;
    color: var(--sh-muted);
    background: none;
    border: 0;
    border-bottom: 2px solid transparent;
    border-radius: calc(var(--sh-radius) - 8px) calc(var(--sh-radius) - 8px) 0 0;
    cursor: pointer;
    white-space: nowrap;
}

.share-tab:hover {
    color: var(--sh-text);
    background: var(--sh-accent-soft);
}

/* Selection is weight plus a rule, not colour alone. */
.share-tab[aria-selected="true"] {
    color: var(--sh-text);
    font-weight: 600;
    border-bottom-color: var(--sh-accent);
}

.share-tab:focus-visible {
    outline: 2px solid var(--sh-accent);
    outline-offset: -2px;
}

.share-tab-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--sh-accent);
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
    color: var(--sh-text);
    background: var(--sh-surface);
    border: 1px solid rgba(92, 95, 119, 0.3);
    border-radius: calc(var(--sh-radius) - 8px);
}

.share-list button[aria-current="true"] {
    border-color: var(--sh-accent);
    background: var(--sh-accent-soft);
}

.share-list-from,
.share-from {
    color: var(--sh-muted);
    font-size: 13px;
}

.share-detail h2 {
    margin: 4px 0 16px;
    font-size: 20px;
}

.share-copy-all {
    position: relative;
    margin: 12px 0 0;
}

.share-copy-all button {
    padding: 8px 12px;
    font: inherit;
    color: var(--sh-text);
    background: var(--sh-surface);
    border: 1px solid rgba(92, 95, 119, 0.35);
    border-radius: calc(var(--sh-radius) - 8px);
    cursor: pointer;
}

.share-copy-all button:disabled {
    opacity: 0.55;
    cursor: default;
}

.share-copy-all p {
    margin: 8px 0 0;
    color: var(--sh-muted);
    font-size: 13px;
}

/* Offscreen until the clipboard turns out to be unusable, then it becomes the thing the
   visitor selects by hand. */
.share-copy-all-select {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    border: 0;
}

.share-copy-all-select.is-visible {
    position: static;
    width: 100%;
    height: auto;
    margin: 8px 0 0;
    padding: 8px;
    clip: auto;
    overflow: auto;
    box-sizing: border-box;
    border: 1px solid rgba(92, 95, 119, 0.35);
    border-radius: calc(var(--sh-radius) - 8px);
    font: inherit;
}

.share-atts {
    list-style: none;
    margin: 16px 0 0;
    padding: 0;
}

.share-atts button {
    padding: 8px 12px;
    color: var(--sh-text);
    background: var(--sh-surface);
    border: 1px solid rgba(92, 95, 119, 0.35);
    border-radius: calc(var(--sh-radius) - 8px);
}

/* 移动(设计卡):去浮层阴影、复制/操作全宽、Tab 横向滚动、触控 ≥ 44px。 */
@media (max-width: 640px) {
    .share-shell {
        padding: 0 0 32px;
    }

    .share-card {
        max-width: none;
        padding: 20px 16px;
        border-radius: 0;
        box-shadow: none;
    }

    .share-shell[data-share-state="authRequired"] .share-card,
    .share-shell[data-share-state="unavailable"] .share-card,
    .share-shell[data-share-state="timedout"] .share-card,
    .share-shell[data-share-state="exited"] .share-card {
        max-width: none;
    }

    .share-tabs {
        flex-wrap: nowrap;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
    }

    .share-top button,
    .share-auth-submit,
    .share-refresh,
    .share-tab,
    .share-list button,
    .share-copy-all button,
    .share-atts button {
        min-height: 44px;
    }

    .share-refresh,
    .share-copy-all button,
    .share-atts button {
        width: 100%;
    }
}
</style>
