<template>
  <div
    class="share-shell"
    data-share-shell="cloud-mail-share-shell"
    :data-share-state="state"
  >
    <header class="share-top">
      <p v-if="state === 'loading'">{{ tx('shareVisitLoading', 'Opening shared mailbox...') }}</p>
      <p v-else-if="state === 'ready'">{{ tx('shareVisitReady', 'Shared mailbox') }}{{ mailbox ? `: ${mailbox}` : '' }}</p>
      <p v-else-if="state === 'unavailable'">{{ tx('shareVisitUnavailable', 'This link is no longer available.') }}</p>
      <p v-else-if="state === 'timedout'">{{ tx('shareVisitTimedOut', 'Your session timed out. Open your original link again.') }}</p>
      <p v-else-if="state === 'limited'">{{ tx('shareVisitLimited', 'Too many attempts. Please wait a moment and try again.') }}</p>
      <p v-else-if="state === 'exited'">{{ tx('shareVisitExited', 'You have left this share.') }}</p>
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

    <div v-if="state === 'ready'" data-share-body>
      <ShareOtpCard
        :mails="mails"
        :selected="selectedMail"
        :enabled="otpEnabled"
      />

      <p
        v-if="!mails.length"
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
    <div v-else data-share-body></div>
  </div>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import SafeMailRenderer from '@/components/safe-mail/index.vue'
import { useSharePolling } from '@/composables/useSharePolling.js'
import {
    createShareSession,
    getShareAttachment,
    isShareRateLimited,
    isShareUnavailable,
    listShareMails
} from '@/request/share.js'
import {
    clearOtherShareSessions,
    clearShareSession,
    consumeShareSecret,
    readShareSession,
    writeShareSession
} from './session.js'
import { senderLine } from './mail-fields.js'
import ShareOtpCard from './ShareOtpCard.vue'

defineOptions({
    name: 'share'
})

const PAGE_LIMIT = 50
const MAX_CATCHUP_PAGES = 40

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
let justRecovered = false

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

function onPolledMails(list) {
    rateLimited.value = false
    mergeMails(list)
}

const polling = useSharePolling({
    sessionToken,
    limit: PAGE_LIMIT,
    listShareMails: fetchMails,
    onMails: onPolledMails,
    onUnavailable: (err) => {
        void noteShareFailure(err)
    }
})
polling.stop()

const listMails = computed(() => [...mails.value].reverse())

const selectedMail = computed(() => {
    if (!selectedId.value) {
        return mails.value.length ? mails.value[mails.value.length - 1] : null
    }
    return mails.value.find((item) => mailKey(item) === selectedId.value) || null
})

const showWait = computed(() => rateLimited.value || state.value === 'limited')

function isSelected(item) {
    const current = selectedMail.value
    return Boolean(current && mailKey(current) === mailKey(item))
}

function applyShareConfig(data) {
    otpEnabled.value = !(data && data.config && data.config.otpExtractionEnabled === false)
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

function clearMailboxView() {
    const lid = currentLid()
    if (lid) {
        clearShareSession(lid)
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
    const data = await createShareSession(lid, sec)
    const token = data && data.sessionToken
    if (!token) {
        return false
    }
    writeShareSession(lid, token)
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

function exitShare() {
    polling.stop()
    pageSecret.value = ''
    justRecovered = false
    const lid = currentLid()
    if (lid) {
        clearShareSession(lid)
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

function rememberCursor(list) {
    if (list.length && list[list.length - 1].mailId != null) {
        polling.cursor.value = String(list[list.length - 1].mailId)
        return
    }
    if (mails.value.length) {
        polling.cursor.value = String(mails.value[mails.value.length - 1].mailId)
    }
}

async function beginMailbox() {
    polling.unavailable.value = false
    try {
        let cursor = null
        let pages = 0
        while (pages < MAX_CATCHUP_PAGES) {
            const result = await listShareMails({
                sessionToken: sessionToken.value,
                cursor,
                limit: PAGE_LIMIT
            })
            const list = result && Array.isArray(result.list) ? result.list : []
            mergeMails(list)
            rememberCursor(list)
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
        polling.start()
    } catch (err) {
        if (isShareRateLimited(err)) {
            rateLimited.value = true
            polling.start()
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
    const lid = currentLid()
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
            const data = await createShareSession(lid, sec)
            const token = data && data.sessionToken
            if (!token) {
                clearShareSession(lid)
                state.value = 'unavailable'
                return
            }
            writeShareSession(lid, token)
            sessionToken.value = token
            applyShareConfig(data)
            mailbox.value = (data && data.mailbox) || ''
            state.value = 'ready'
            await beginMailbox()
        } catch (err) {
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

onUnmounted(() => {
    pageSecret.value = ''
    justRecovered = false
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
