<template>
  <el-drawer
      class="share-detail-drawer"
      :model-value="open"
      :title="tf('shareDetailTitle')"
      direction="rtl"
      size="min(560px, 100vw)"
      :destroy-on-close="true"
      @update:model-value="onOpenChange"
  >
    <div v-if="loadError" class="detail-panel" data-test="detail-load-error">
      {{ tf('shareDetailLoadError') }}
    </div>

    <div v-else-if="detail" class="detail" data-test="share-detail">
      <header class="detail-head">
        <h3 class="detail-name" data-test="detail-name">
          {{ detail.name || detail.mailbox || detail.shareId }}
        </h3>
        <div class="detail-badges">
          <el-tag type="info" data-test="detail-type">{{ tf(shareTypeLabelKey(detail.shareType)) }}</el-tag>
          <el-tag
              :type="statusMeta(liveStatus(detail)).tone"
              data-test="detail-status"
              :data-status="liveStatus(detail)"
          >
            {{ statusText(liveStatus(detail)) }}
          </el-tag>
        </div>
      </header>

      <p v-if="!writable" class="notice notice-muted" data-test="detail-readonly">
        {{ tf('shareDetailReadonly') }}
      </p>

      <dl class="detail-fields">
        <div class="field">
          <dt class="field-label">{{ tf('shareSessionQuota') }}</dt>
          <dd class="field-value field-numeric" data-test="detail-quota">
            {{ quotaText(detail, tf('shareQuotaUnlimited')) }}
          </dd>
        </div>
        <div class="field">
          <dt class="field-label">{{ $t('shareCreatedAt') }}</dt>
          <dd class="field-value" data-test="detail-created">{{ tzText(detail.createTime) }}</dd>
        </div>
        <div class="field">
          <dt class="field-label">{{ $t('shareExpiresAt') }}</dt>
          <dd class="field-value" data-test="detail-expires">{{ tzText(detail.expiresAt) }}</dd>
        </div>
        <div class="field">
          <dt class="field-label">{{ $t('shareLastAccess') }}</dt>
          <dd class="field-value" data-test="detail-last-access">{{ tzText(detail.lastAccessAt) }}</dd>
        </div>
      </dl>

      <section class="panel">
        <h4 class="panel-title">{{ tf('shareBoundMailboxes') }}</h4>
        <ul class="binding-list">
          <li v-for="item in bindingRows" :key="item.bindingId" class="binding-row" data-test="binding-row">
            <span class="binding-mailbox">{{ item.label }}</span>
            <el-button
                text
                size="small"
                type="danger"
                data-test="binding-remove"
                :disabled="!writable || bindingBusy"
                @click="askRemove(item)"
            >
              {{ tf('shareBindingRemove') }}
            </el-button>
          </li>
        </ul>

        <div class="binding-add">
          <el-select
              v-model="addAccountId"
              class="binding-select"
              data-test="binding-add-select"
              :disabled="!writable || atBindingLimit"
              :placeholder="tf('shareBindingAdd')"
          >
            <el-option
                v-for="item in addableAccounts"
                :key="item.accountId"
                :label="item.email"
                :value="item.accountId"
            />
          </el-select>
          <el-button
              data-test="binding-add"
              :disabled="!writable || atBindingLimit || bindingBusy"
              :loading="bindingBusy"
              @click="submitAdd"
          >
            {{ tf('shareBindingAdd') }}
          </el-button>
          <el-button
              v-if="writable && !atBindingLimit && !accountsDone"
              text
              data-test="binding-load-more"
              :loading="accountsLoading"
              @click="loadAccounts"
          >
            {{ tf('shareBindingLoadMore') }}
          </el-button>
        </div>

        <p v-if="bindingError" class="notice notice-danger" data-test="binding-error" role="alert">
          {{ bindingError }}
        </p>
        <p v-if="atBindingLimit" class="notice" data-test="binding-limit">{{ tf('shareBindingLimitReached') }}</p>
        <p
            v-else-if="writable && accountsDone && addableAccounts.length === 0"
            class="notice"
            data-test="binding-none"
        >
          {{ tf('shareBindingNoneAvailable') }}
        </p>
      </section>

      <section class="panel">
        <h4 class="panel-title">{{ tf('shareConfigTitle') }}</h4>

        <div class="config-row">
          <label class="config-label" for="share-config-name">{{ tf('shareName') }}</label>
          <el-input
              id="share-config-name"
              v-model="form.name"
              data-test="config-name"
              maxlength="64"
              :disabled="!writable"
              :placeholder="$t('shareNamePlaceholder')"
          />
        </div>

        <div class="config-row">
          <label class="config-label" for="share-config-remark">{{ tf('shareRemark') }}</label>
          <el-input
              id="share-config-remark"
              v-model="form.remark"
              data-test="config-remark"
              maxlength="200"
              :disabled="!writable"
              :placeholder="$t('shareRemarkPlaceholder')"
          />
        </div>

        <div class="config-row">
          <label class="config-label" for="share-config-renew">{{ tf('shareRenewLabel') }}</label>
          <el-select
              id="share-config-renew"
              v-model="renewChoice"
              data-test="renew-choice"
              :disabled="!writable"
          >
            <el-option :key="RENEW_KEEP" :label="tf('shareRenewKeep')" :value="RENEW_KEEP" />
            <el-option
                v-for="item in SHARE_DURATION_PRESETS"
                :key="item.value"
                :label="tf('shareRenewBy', {duration: $t(item.labelKey)})"
                :value="item.value"
            />
            <el-option :key="DURATION_CUSTOM" :label="tf('shareRenewExact')" :value="DURATION_CUSTOM" />
          </el-select>
        </div>

        <div v-if="renewExactOpen" class="config-row">
          <label class="config-label" for="share-config-expires">{{ tf('shareRenewExact') }}</label>
          <el-date-picker
              id="share-config-expires"
              v-model="form.expiresAtLocal"
              data-test="renew-exact"
              type="datetime"
              value-format="YYYY-MM-DD HH:mm:ss"
              :disabled="!writable"
          />
        </div>

        <p v-if="writable" class="config-hint" data-test="renew-target">
          {{ tf('shareRenewTarget', {time: form.expiresAtLocal || '-'}) }}
        </p>
        <p v-if="writable" class="config-hint" data-test="renew-ceiling">
          {{ tf('shareRenewCeiling', {time: renewCeilingText, days: MAX_DURATION_DAYS}) }}
        </p>

        <div class="config-row">
          <label class="config-label" for="share-config-max-sessions">{{ tf('shareMaxSessions') }}</label>
          <div class="config-limit">
            <el-input-number
                id="share-config-max-sessions"
                v-model="form.maxSessions"
                data-test="max-sessions"
                :min="1"
                :controls="false"
                :disabled="!writable || form.maxSessionsUnlimited"
            />
            <el-checkbox
                v-model="form.maxSessionsUnlimited"
                data-test="max-sessions-unlimited"
                :disabled="!writable"
            >
              {{ tf('shareQuotaUnlimited') }}
            </el-checkbox>
          </div>
        </div>

        <div class="config-row">
          <label class="config-label" for="share-config-message-limit">{{ tf('shareMessageLimit') }}</label>
          <div class="config-limit">
            <el-input-number
                id="share-config-message-limit"
                v-model="form.messageLimit"
                data-test="message-limit"
                :min="1"
                :controls="false"
                :disabled="!writable || form.messageLimitUnlimited"
            />
            <el-checkbox
                v-model="form.messageLimitUnlimited"
                data-test="message-limit-unlimited"
                :disabled="!writable"
            >
              {{ tf('shareQuotaUnlimited') }}
            </el-checkbox>
          </div>
        </div>

        <div class="config-row config-row-inline">
          <label class="config-label" for="share-config-otp">{{ tf('shareOtpExtraction') }}</label>
          <el-switch
              id="share-config-otp"
              v-model="form.otpExtractionEnabled"
              data-test="otp-toggle"
              :disabled="!writable"
          />
        </div>

        <div class="config-row config-row-inline">
          <label class="config-label" for="share-config-auto-refresh">{{ tf('shareAutoRefresh') }}</label>
          <el-switch
              id="share-config-auto-refresh"
              v-model="form.autoRefresh"
              data-test="auto-refresh-toggle"
              :disabled="!writable"
          />
        </div>

        <div class="config-row">
          <label class="config-label" for="share-config-interval">{{ tf('shareRefreshInterval') }}</label>
          <el-input-number
              id="share-config-interval"
              v-model="form.refreshIntervalMs"
              data-test="refresh-interval"
              :min="MIN_REFRESH_INTERVAL_MS"
              :step="1000"
              :controls="false"
              :disabled="!writable"
          />
        </div>

        <div class="config-row config-row-inline">
          <label class="config-label" for="share-config-mask" data-test="mask-toggle-label">
            {{ tf('shareShowFullAddress') }}
          </label>
          <el-switch
              id="share-config-mask"
              v-model="form.showFullAddress"
              data-test="mask-toggle"
              :disabled="!writable"
          />
        </div>
        <p class="config-hint" data-test="mask-toggle-hint">{{ tf('shareShowFullAddressHint') }}</p>

        <p v-if="configError" class="notice notice-danger" data-test="config-error" role="alert">
          {{ configError }}
        </p>

        <div class="config-actions">
          <el-button
              type="primary"
              data-test="config-save"
              :disabled="!writable || saving"
              :loading="saving"
              @click="submitSave"
          >
            {{ $t('save') }}
          </el-button>
        </div>
      </section>

      <section class="panel">
        <h4 class="panel-title">{{ tf('shareLinkTitle') }}</h4>

        <p class="config-hint" data-test="link-hint">{{ tf('shareLinkHint') }}</p>

        <div class="authkey-state">
          <!-- 刻意不看 writable:那个计算属性说的是「可编辑」。已过期 / 已撤销的行恰恰是
               管理员要排查「当初发出去的是哪条」的地方,后端也为此没给这条路加状态门。 -->
          <el-button
              data-test="link-reveal"
              :disabled="revealBusy"
              :loading="revealBusy"
              @click="submitReveal"
          >
            {{ tf('shareLinkReveal') }}
          </el-button>
          <el-button
              data-test="link-regenerate"
              :disabled="!writable || linkBusy"
              :loading="linkBusy"
              @click="askRegenerate"
          >
            {{ tf('shareLinkRegenerate') }}
          </el-button>
        </div>

        <p v-if="linkError" class="notice notice-danger" data-test="link-error" role="alert">
          {{ linkError }}
        </p>

        <p v-if="revealError" class="notice notice-danger" data-test="link-reveal-error" role="alert">
          {{ revealError }}
        </p>

        <div v-if="revealedLink" class="authkey-once" data-test="link-reveal-once">
          <p class="authkey-once-warning">{{ tf('shareLinkRevealed') }}</p>
          <div class="authkey-once-row">
            <input
                ref="revealSelectableRef"
                class="authkey-input"
                data-test="link-reveal-url"
                type="text"
                readonly
                :aria-label="tf('shareLinkTitle')"
                :value="revealedLink"
            />
            <el-button data-test="link-reveal-copy" @click="copyRevealedLink">{{ $t('copy') }}</el-button>
            <el-button data-test="link-reveal-hide" @click="revealedLink = ''">
              {{ tf('shareLinkRevealHide') }}
            </el-button>
          </div>
        </div>

        <div v-if="linkOnce" class="authkey-once" data-test="link-once">
          <p class="authkey-once-warning">{{ tf('shareLinkOnce') }}</p>
          <div class="authkey-once-row">
            <input
                ref="linkSelectableRef"
                class="authkey-input"
                data-test="link-url"
                type="text"
                readonly
                :aria-label="tf('shareLinkTitle')"
                :value="linkOnce"
            />
            <el-button data-test="link-copy" @click="copyLink">{{ $t('copy') }}</el-button>
            <el-button type="primary" data-test="link-ack" @click="linkOnce = ''">
              {{ tf('shareLinkSaved') }}
            </el-button>
          </div>
        </div>
      </section>

      <section class="panel">
        <h4 class="panel-title">{{ tf('shareAuthKey') }}</h4>

        <div class="authkey-state">
          <el-tag :type="detail.authKeyEnabled ? 'success' : 'info'" data-test="authkey-state">
            {{ detail.authKeyEnabled ? tf('shareAuthKeyOn') : tf('shareAuthKeyOff') }}
          </el-tag>
          <template v-if="detail.authKeyEnabled">
            <el-button
                data-test="authkey-reset"
                :disabled="!writable || authKeyBusy"
                :loading="authKeyBusy"
                @click="askAuthKey('reset')"
            >
              {{ tf('shareAuthKeyReset') }}
            </el-button>
            <el-button
                type="danger"
                data-test="authkey-disable"
                :disabled="!writable || authKeyBusy"
                :loading="authKeyBusy"
                @click="askAuthKey('disable')"
            >
              {{ tf('shareAuthKeyDisable') }}
            </el-button>
          </template>
          <el-button
              v-else
              type="primary"
              data-test="authkey-enable"
              :disabled="!writable || authKeyBusy"
              :loading="authKeyBusy"
              @click="submitAuthKey('enable')"
          >
            {{ tf('shareAuthKeyEnable') }}
          </el-button>
        </div>

        <p v-if="!detail.authKeyEnabled" class="config-hint" data-test="authkey-enable-hint">
          {{ tf('shareAuthKeyEnableHint') }}
        </p>

        <p v-if="authKeyError" class="notice notice-danger" data-test="authkey-error" role="alert">
          {{ authKeyError }}
        </p>

        <div v-if="authKeyOnce" class="authkey-once" data-test="authkey-once">
          <p class="authkey-once-warning">{{ tf('shareAuthKeyOnce') }}</p>
          <div class="authkey-once-row">
            <input
                ref="selectableRef"
                class="authkey-input"
                data-test="authkey-value"
                type="text"
                readonly
                :aria-label="tf('shareAuthKey')"
                :value="authKeyOnce"
            />
            <el-button data-test="authkey-copy" @click="copyAuthKey">{{ $t('copy') }}</el-button>
            <el-button type="primary" data-test="authkey-ack" @click="authKeyOnce = ''">
              {{ tf('shareAuthKeySaved') }}
            </el-button>
          </div>
        </div>
      </section>
    </div>
  </el-drawer>
</template>

<script setup>
import {computed, reactive, ref, watch} from "vue"
import {useI18n} from "vue-i18n"
import {ElMessage, ElMessageBox} from "element-plus"
import {useCopyWithFallback} from "@/composables/useCopyWithFallback.js"
import {accountList} from "@/request/account.js"
import {
  getMailShare,
  regenerateMailShare,
  resetMailShareAuthKey,
  revealMailShareSec,
  updateMailShare,
  updateMailShareBindings
} from "@/request/mail-share.js"
import {bindingLabels, isMutableStatus, quotaText, shareTypeLabelKey, statusMeta} from "./status.js"
import {useShareClock} from "./use-share-clock.js"
import {
  DURATION_CUSTOM,
  MAX_DURATION_DAYS,
  MAX_DURATION_SECONDS,
  SHARE_DURATION_PRESETS
} from "./presets.js"
import {toUtc, tzDayjs, tzText} from "@/utils/day.js"

defineOptions({
  name: 'share-detail-drawer'
})

const props = defineProps({
  shareId: {type: Number, default: 0}
})
const emit = defineEmits(['update:shareId', 'changed'])

const {t, te} = useI18n()
// P1: badge and write predicate follow the live clock, so a drawer left open across
// expiresAt turns read-only on its own instead of trusting the load-time snapshot.
const {liveStatus} = useShareClock()
const {copy, selectableRef} = useCopyWithFallback()
// A second instance rather than a shared one: the two one-shot blocks can be on screen at the
// same time, and one selectableRef cannot point at both inputs.
const {copy: copyLinkText, selectableRef: linkSelectableRef} = useCopyWithFallback()
// A third instance for the same reason: the revealed link lives in its own input, and one
// selectableRef cannot point at two of them.
const {copy: copyRevealText, selectableRef: revealSelectableRef} = useCopyWithFallback()

// T-28/T-29 are the only writers of i18n/zh.js and i18n/en.js. Until they land the keys
// registered in exec-t21-note.md, fall back to the agreed copy instead of painting a raw key
// name on screen; te() flips to the real translation the moment they exist.
const PENDING_COPY = {
  shareDetailTitle: '分享详情',
  shareDetailLoadError: '详情加载失败，请刷新重试。',
  shareDetailReadonly: '这个分享已不可修改（已过期或已销毁），仅供查阅。',
  shareDetailGone: '这个分享已不存在，已为你刷新列表。',
  shareStatusLimitReached: '已达访问上限',
  shareTypeSingle: '单邮箱',
  shareTypeMulti: '多邮箱',
  shareBoundMailboxes: '绑定邮箱',
  shareSessionQuota: '会话用量',
  shareQuotaUnlimited: '不限',
  shareBindingAdd: '添加邮箱',
  shareBindingRemove: '移除',
  shareBindingRemoveConfirm: '移除后，这个邮箱的邮件会立刻从分享页消失。',
  shareBindingRemoveLastConfirm: '这是最后一个邮箱，移除它会同时销毁整个分享。',
  shareBindingLimitReached: '一个分享最多绑定 50 个邮箱。',
  shareBindingConflict: '绑定关系刚被改动过，已为你刷新，请重新确认。',
  shareBindingLoadMore: '加载更多邮箱',
  shareBindingNoneAvailable: '没有可添加的邮箱了。',
  shareConfigTitle: '配置',
  shareConfigSaved: '已保存',
  shareConfigNoChange: '没有需要保存的改动。',
  shareConfigRejected: '这项配置未被接受：超出了当前允许的取值。请调整后重试。',
  shareCapabilityNotEnabled: '该能力尚未开放，请联系管理员开启。',
  shareName: '名称',
  shareRemark: '备注',
  shareMaxSessions: '会话上限',
  shareMessageLimit: '邮件条数上限',
  shareOtpExtraction: '提取验证码',
  shareAutoRefresh: '自动刷新',
  shareRefreshInterval: '刷新间隔（毫秒，最小 3000）',
  shareRefreshIntervalTooSmall: '刷新间隔不能小于 3000 毫秒。',
  shareResetUsedSessionsTitle: '是否把已用会话数清零？',
  shareResetUsedSessionsHint: '这是这个分享第一次设置会话上限。清零后按新上限重新计数；保留计数可能让它立刻触顶。',
  shareResetUsedSessionsYes: '清零并保存',
  shareResetUsedSessionsNo: '保留计数并保存',
  shareShowFullAddress: '显示完整地址（展示选项）',
  shareShowFullAddressHint: '只影响分享页上邮箱地址的显示方式。关闭它不会隐藏邮件正文、主题或发件人里出现的地址。',
  shareAuthKey: '访问密钥',
  shareAuthKeyOn: '已启用',
  shareAuthKeyOff: '未启用',
  shareAuthKeyEnable: '启用',
  shareAuthKeyReset: '重置',
  shareAuthKeyDisable: '关闭',
  shareAuthKeyEnableHint: '启用后，新的访问需要这把密钥；已经打开的访问不受影响。',
  shareAuthKeyKillConfirm: '这会立刻让所有已打开的访问失效，访客需要用新密钥重新打开。',
  shareAuthKeyDisableConfirm: '关闭后不再需要密钥，同时立刻让所有已打开的访问失效。',
  shareAuthKeyOnce: '新密钥只显示这一次，关闭后无法再查看。请立即复制并妥善保存。',
  shareAuthKeySaved: '我已保存',
  shareAuthKeyFailed: '无法完成：分享状态可能刚刚变化。请刷新后重试。'
}

function tf(key, params) {
  return te(key) ? t(key, params || {}) : (PENDING_COPY[key] || key)
}

// Mirrors of backend constants that the browser has to enforce before the request leaves:
// SHARE_BINDING_LIMIT, account/list's hard size cap, and MIN_REFRESH_INTERVAL_MS.
const BINDING_LIMIT = 50
const ACCOUNT_PAGE_SIZE = 30
const MIN_REFRESH_INTERVAL_MS = 3000

// A string, like DURATION_CUSTOM, so it can never collide with a rung's seconds. "Leave the
// expiry alone" has to be an explicit rung rather than the absence of a choice: the select is
// the only control here whose neutral state must round-trip back to the saved instant.
const RENEW_KEEP = 'keep'

const detail = ref(null)
const loadError = ref(false)
const saving = ref(false)
const bindingBusy = ref(false)
const authKeyBusy = ref(false)
const configError = ref('')
const bindingError = ref('')
const authKeyError = ref('')
// The only place the new key ever exists in this app. Not storage, not pinia, not the URL:
// the detail endpoint never returns it again, so persisting it would void "shown once".
const authKeyOnce = ref('')
const linkBusy = ref(false)
const linkError = ref('')
// Same discipline as authKeyOnce: the sec half of the URL is never stored server-side and the
// detail endpoint never returns it, so keeping it anywhere but this ref would void "shown once".
const linkOnce = ref('')
const revealBusy = ref(false)
const revealError = ref('')
// Same discipline as authKeyOnce / linkOnce. This one *can* be fetched again, but that is the
// server's business: on this side it still never reaches storage, pinia or the URL.
const revealedLink = ref('')
// Drop stale reads/writes after the owner switches shares. Same idea as the list page reqSeq.
let reqGen = 0
function bumpGen() {
  reqGen += 1
  return reqGen
}
function isCurrent(gen, shareId) {
  return gen === reqGen && Number(props.shareId) === Number(shareId)
}
const accounts = ref([])
const accountsDone = ref(false)
const accountsLoading = ref(false)
const addAccountId = ref(null)

const form = reactive({
  name: '',
  remark: '',
  maxSessions: null,
  maxSessionsUnlimited: false,
  messageLimit: null,
  messageLimitUnlimited: false,
  otpExtractionEnabled: false,
  autoRefresh: false,
  refreshIntervalMs: null,
  showFullAddress: false,
  // The browser's wall clock, same reading as the three read-only instants above. The request
  // speaks the backend's UTC bare string, and buildPatch is the single place that converts.
  expiresAtLocal: ''
})

const renewChoice = ref(RENEW_KEEP)

const open = computed(() => props.shareId > 0)
const writable = computed(() => Boolean(detail.value) && isMutableStatus(liveStatus(detail.value)))

const bindingRows = computed(() => {
  const rows = detail.value && Array.isArray(detail.value.bindings) ? detail.value.bindings : []
  // bindingLabels owns the "account was hard deleted" fallback; a second `mailbox || '-'`
  // here would render the same binding differently from the list page.
  return rows.map((binding) => ({
    bindingId: binding.bindingId,
    accountId: binding.accountId,
    label: bindingLabels({bindings: [binding]})[0] || '-'
  }))
})

const atBindingLimit = computed(() => bindingRows.value.length >= BINDING_LIMIT)

const renewExactOpen = computed(() => renewChoice.value === DURATION_CUSTOM)

// The ceiling is measured from create_time, not from now: the backend judges
// `new expires_at − create_time <= max`, so that rolling renewals cannot turn a share into a
// permanent one. Showing "now + 90 days" here would promise headroom the server will refuse.
const renewCeiling = computed(() => {
  const base = detail.value
  return base && base.createTime
      ? tzDayjs(base.createTime).add(MAX_DURATION_SECONDS, 'second')
      : null
})

const renewCeilingText = computed(() => (
  renewCeiling.value ? renewCeiling.value.format('YYYY-MM-DD HH:mm:ss') : '-'
))

// Empty means "the drawer never had a value" — the same "no opinion" reading the refresh
// interval gets — and an unchanged wall clock is not a renewal, so neither reaches the patch.
function isRenewDirty() {
  const base = detail.value
  if (!base || !form.expiresAtLocal) {
    return false
  }
  return form.expiresAtLocal !== tzText(base.expiresAt, '')
}

// Both server-side judgements, mirrored so a refusal reads here instead of arriving as
// SHARE_INVALID_CONFIG / SHARE_DURATION_EXCEEDED after the round trip. Landing in the past is
// the one that cannot be undone: the row turns EXPIRED, and an EXPIRED row is not updatable.
function renewErrorKey() {
  const base = detail.value
  if (!base || !isRenewDirty()) {
    return ''
  }
  const target = toUtc(form.expiresAtLocal)
  if (!target.isValid()) {
    return 'shareRenewInvalid'
  }
  if (!target.isAfter(toUtc())) {
    return 'shareRenewPast'
  }
  const created = tzDayjs(base.createTime)
  if (!created.isValid() || target.diff(created, 'second') > MAX_DURATION_SECONDS) {
    return 'shareRenewTooLong'
  }
  return ''
}

// Every rung is measured from the saved expiry rather than from the previous pick, so choosing
// 24h twice lands on the same instant instead of quietly compounding to 48.
watch(renewChoice, (choice) => {
  const base = detail.value
  if (!base) {
    return
  }
  if (choice === DURATION_CUSTOM) {
    return
  }
  if (choice === RENEW_KEEP) {
    form.expiresAtLocal = tzText(base.expiresAt, '')
    return
  }
  const seconds = Number(choice)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return
  }
  form.expiresAtLocal = tzDayjs(base.expiresAt).add(seconds, 'second').format('YYYY-MM-DD HH:mm:ss')
})

const addableAccounts = computed(() => {
  const bound = new Set(bindingRows.value.map((item) => item.accountId))
  return accounts.value.filter((item) => item && !bound.has(item.accountId))
})

function statusText(value) {
  const {labelKey} = statusMeta(value)
  return labelKey ? tf(labelKey) : value
}

function isGone(err) {
  return Boolean(err) && err.message === 'SHARE_NOT_FOUND'
}

function isDismissal(err) {
  return err === 'cancel' || err === 'close'
}

function applyDetail(data) {
  detail.value = data
  form.name = data.name || ''
  form.remark = data.remark || ''
  form.maxSessionsUnlimited = data.maxSessions == null
  form.maxSessions = data.maxSessions == null ? null : Number(data.maxSessions)
  form.messageLimitUnlimited = data.messageLimit == null
  form.messageLimit = data.messageLimit == null ? null : Number(data.messageLimit)
  form.otpExtractionEnabled = Boolean(data.otpExtractionEnabled)
  form.autoRefresh = Boolean(data.autoRefresh)
  form.refreshIntervalMs = data.refreshIntervalMs == null ? null : Number(data.refreshIntervalMs)
  form.showFullAddress = Boolean(data.showFullAddress)
  // Assigned here as well as by the watch: the watch only runs when the choice actually
  // changes, and after a successful save it is already back on RENEW_KEEP.
  form.expiresAtLocal = tzText(data.expiresAt, '')
  renewChoice.value = RENEW_KEEP
}

function close() {
  bumpGen()
  authKeyOnce.value = ''
  linkOnce.value = ''
  revealedLink.value = ''
  emit('update:shareId', 0)
}

// The drawer disappearing on its own needs a reason, or the owner reads it as a lost click.
function closeGone() {
  ElMessage({message: tf('shareDetailGone'), type: 'warning', plain: true})
  emit('changed')
  close()
}

function onOpenChange(value) {
  if (!value) {
    close()
  }
}

async function load(shareId) {
  const gen = reqGen
  try {
    const data = await getMailShare(shareId)
    if (!isCurrent(gen, shareId)) {
      return
    }
    applyDetail(data)
    loadError.value = false
  } catch (err) {
    if (!isCurrent(gen, shareId)) {
      return
    }
    if (isGone(err)) {
      // Someone else already deleted or revoked it; a half-drawn form would be a lie.
      closeGone()
      return
    }
    loadError.value = true
    console.error('mail share detail failed', {shareId, code: err && err.code})
    return
  }
  if (isCurrent(gen, shareId) && writable.value && !atBindingLimit.value && accounts.value.length === 0) {
    await loadAccounts()
  }
}

async function loadAccounts() {
  if (accountsLoading.value || accountsDone.value) {
    return
  }
  accountsLoading.value = true
  try {
    const last = accounts.value[accounts.value.length - 1]
    const page = await accountList(
        last ? last.accountId : 0,
        ACCOUNT_PAGE_SIZE,
        last ? last.sort : null
    )
    const rows = Array.isArray(page) ? page : []
    accounts.value = accounts.value.concat(rows)
    if (rows.length < ACCOUNT_PAGE_SIZE) {
      accountsDone.value = true
    }
  } catch (err) {
    accountsDone.value = true
    console.error('account list failed', {code: err && err.code})
  } finally {
    accountsLoading.value = false
  }
}

async function runBindingChange(body) {
  const opened = props.shareId
  const gen = reqGen
  bindingBusy.value = true
  bindingError.value = ''
  try {
    await updateMailShareBindings(body)
    if (!isCurrent(gen, opened)) {
      return
    }
    emit('changed')
  } catch (err) {
    if (!isCurrent(gen, opened)) {
      return
    }
    if (isGone(err)) {
      closeGone()
      return
    }
    // SHARE_BINDING_CONFLICT / SHARE_*_FORBIDDEN all mean the set moved under us. Replaying
    // the same bindingIds would be a different command against a different set, so re-read
    // and let the owner decide again on the new one.
    bindingError.value = tf('shareBindingConflict')
    console.error('mail share bindings failed', {code: err && err.code, message: err && err.message})
  } finally {
    bindingBusy.value = false
  }
  // The bindings response carries {bindingId, accountId} with no mailbox, so feeding it back
  // into the drawer would blank every address. The detail endpoint is the only shape with one.
  await load(props.shareId)
}

function submitAdd() {
  const accountId = Number(addAccountId.value)
  if (!writable.value || atBindingLimit.value || !accountId) {
    return
  }
  addAccountId.value = null
  runBindingChange({shareId: props.shareId, add: [accountId]})
}

function askRemove(item) {
  if (!writable.value) {
    return
  }
  const last = bindingRows.value.length <= 1
  ElMessageBox.confirm(
      last ? tf('shareBindingRemoveLastConfirm') : tf('shareBindingRemoveConfirm'),
      {
        confirmButtonText: t('confirm'),
        cancelButtonText: t('cancel'),
        type: 'warning'
      }
  ).then(() => runBindingChange({shareId: props.shareId, remove: [item.bindingId]}))
      .catch((err) => {
        if (isDismissal(err)) {
          return
        }
        console.error('mail share binding remove failed', {bindingId: item.bindingId, err})
      })
}

function nullableNumber(value) {
  return value == null ? null : Number(value)
}

// undefined means "the owner expressed no opinion, leave the key out"; null means "clear the
// limit". The backend tells the two apart with hasOwnProperty, so they must not collapse.
function pickCount(unlimited, value) {
  if (unlimited) {
    return null
  }
  if (value == null || value === '') {
    return undefined
  }
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 1 ? count : undefined
}

// Only dirty keys travel. A full form would resend maxSessions / messageLimit at their
// current finite values, and assertUpdatePatch trips on "key present and not null" rather
// than on "value changed" — renaming a share would fail with SHARE_INVALID_CONFIG.
function buildPatch() {
  const base = detail.value
  const patch = {}
  if (form.name !== (base.name || '')) {
    patch.name = form.name
  }
  if (form.remark !== (base.remark || '')) {
    patch.remark = form.remark
  }
  const maxSessions = pickCount(form.maxSessionsUnlimited, form.maxSessions)
  if (maxSessions !== undefined && maxSessions !== nullableNumber(base.maxSessions)) {
    patch.maxSessions = maxSessions
  }
  const messageLimit = pickCount(form.messageLimitUnlimited, form.messageLimit)
  if (messageLimit !== undefined && messageLimit !== nullableNumber(base.messageLimit)) {
    patch.messageLimit = messageLimit
  }
  if (form.otpExtractionEnabled !== Boolean(base.otpExtractionEnabled)) {
    patch.otpExtractionEnabled = form.otpExtractionEnabled
  }
  if (form.autoRefresh !== Boolean(base.autoRefresh)) {
    patch.autoRefresh = form.autoRefresh
  }
  if (form.showFullAddress !== Boolean(base.showFullAddress)) {
    patch.showFullAddress = form.showFullAddress
  }
  // An emptied number box gives null, and Number(null) is 0, which the 3000ms floor rejects.
  // "No interval typed" is not "set the interval to zero".
  if (form.refreshIntervalMs != null && form.refreshIntervalMs !== '') {
    const ms = Number(form.refreshIntervalMs)
    if (ms !== nullableNumber(base.refreshIntervalMs)) {
      patch.refreshIntervalMs = ms
    }
  }
  // The one conversion point between the drawer's wall clock and the column's UTC bare string.
  if (isRenewDirty()) {
    patch.expiresAt = toUtc(form.expiresAtLocal).format('YYYY-MM-DD HH:mm:ss')
  }
  return patch
}

// Three answers, not two: confirm resets the count, cancel keeps it, and X / ESC means the
// owner wants to go back to the form rather than save either way.
function askResetUsedSessions() {
  return ElMessageBox.confirm(tf('shareResetUsedSessionsHint'), tf('shareResetUsedSessionsTitle'), {
    confirmButtonText: tf('shareResetUsedSessionsYes'),
    cancelButtonText: tf('shareResetUsedSessionsNo'),
    distinguishCancelAndClose: true,
    type: 'warning'
  }).then(() => 'reset').catch((err) => (err === 'cancel' ? 'keep' : 'abort'))
}

async function submitSave() {
  if (!writable.value || saving.value) {
    return
  }
  configError.value = ''
  if (form.refreshIntervalMs != null && form.refreshIntervalMs !== ''
      && Number(form.refreshIntervalMs) < MIN_REFRESH_INTERVAL_MS) {
    configError.value = tf('shareRefreshIntervalTooSmall')
    return
  }
  const renewInvalid = renewErrorKey()
  if (renewInvalid) {
    configError.value = tf(renewInvalid, {days: MAX_DURATION_DAYS, time: renewCeilingText.value})
    return
  }
  const patch = buildPatch()
  if (Object.keys(patch).length === 0) {
    ElMessage({message: tf('shareConfigNoChange'), type: 'info', plain: true})
    return
  }
  const opened = props.shareId
  const gen = reqGen
  const body = {shareId: opened, ...patch}
  // The SQL guard is `CASE WHEN max_sessions IS NULL`, so this check only decides whether to
  // ask; it is not the correctness boundary.
  if (detail.value.maxSessions == null && patch.maxSessions != null) {
    const answer = await askResetUsedSessions()
    if (answer === 'abort' || !isCurrent(gen, opened)) {
      return
    }
    if (answer === 'keep') {
      body.resetUsedSessions = false
    }
  }
  saving.value = true
  try {
    // The update response is a full detail, so there is nothing left to re-read.
    const data = await updateMailShare(body)
    if (!isCurrent(gen, opened)) {
      return
    }
    applyDetail(data)
    ElMessage({message: tf('shareConfigSaved'), type: 'success', plain: true})
    emit('changed')
  } catch (err) {
    if (!isCurrent(gen, opened)) {
      return
    }
    if (isGone(err)) {
      closeGone()
      return
    }
    // 两个码指向两种自助动作:越域要改自己填的值,栅栏要找管理员。共用一个码时只能给
    // 一句「可能…或…」,把判断推回给管理员。
    if (err && err.message === 'SHARE_CAPABILITY_NOT_ENABLED') {
      configError.value = tf('shareCapabilityNotEnabled')
    } else if (err && err.message === 'SHARE_DURATION_EXCEEDED') {
      // MAX_DURATION_SECONDS is a mirror of the Worker's fallback; a deployment configuring a
      // lower ceiling refuses a renewal the browser allowed. Quoting our own 90 days back at
      // the owner when the server enforced a different number is worse than saying nothing.
      configError.value = tf('shareDurationServerRejected')
    } else if (err && err.message === 'SHARE_INVALID_CONFIG') {
      configError.value = tf('shareConfigRejected')
    } else if (err && err.message === 'SHARE_UPDATE_CONFLICT') {
      // The row moved between the read and the write -- someone rotated the AuthKey or saved
      // their own edit. Re-reading is the owner's action here, not retrying blind.
      configError.value = tf('shareUpdateConflict')
    } else {
      // Every remaining business rejection still has to reach the screen. Without this branch a
      // newly added error code silently does nothing, which the owner cannot tell apart from a
      // dead Save button -- the exact defect just fixed on both create entries.
      configError.value = tf('shareUpdateFailed')
    }
    console.error('mail share update failed', {code: err && err.code, message: err && err.message})
  } finally {
    saving.value = false
  }
}

async function submitAuthKey(action) {
  if (!writable.value || authKeyBusy.value) {
    return
  }
  const opened = props.shareId
  const gen = reqGen
  authKeyError.value = ''
  authKeyBusy.value = true
  try {
    const data = await resetMailShareAuthKey({shareId: opened, action}) || {}
    if (!isCurrent(gen, opened)) {
      return
    }
    const {authKey, ...rest} = data
    if (rest.shareId != null) {
      applyDetail(rest)
    }
    // enable/reset mint a key; disable has no such property and must clear the last one.
    authKeyOnce.value = authKey || ''
    emit('changed')
  } catch (err) {
    if (!isCurrent(gen, opened)) {
      return
    }
    if (isGone(err)) {
      closeGone()
      return
    }
    // 栅栏有了自己的码,这里不再需要「可能…或…」:后端明确说能力未开放时就直说,
    // 其余(状态刚被另一个页签改过)仍保留那句不声称知道原因的兜底。
    authKeyError.value = err && err.message === 'SHARE_CAPABILITY_NOT_ENABLED'
      ? tf('shareCapabilityNotEnabled')
      : tf('shareAuthKeyFailed')
    console.error('mail share auth key failed', {action, code: err && err.code, message: err && err.message})
  } finally {
    authKeyBusy.value = false
  }
}

function askAuthKey(action) {
  if (!writable.value) {
    return
  }
  ElMessageBox.confirm(
      action === 'reset' ? tf('shareAuthKeyKillConfirm') : tf('shareAuthKeyDisableConfirm'),
      {
        confirmButtonText: t('confirm'),
        cancelButtonText: t('cancel'),
        type: 'warning'
      }
  ).then(() => submitAuthKey(action)).catch((err) => {
    if (isDismissal(err)) {
      return
    }
    console.error('mail share auth key confirm failed', {action, err})
  })
}

// AC-LIFE-05:链接外泄或丢失时的「换一条继续用」。有效期与绑定邮箱不动,只轮换凭据。
async function submitRegenerate() {
  if (!writable.value || linkBusy.value) {
    return
  }
  const opened = props.shareId
  const gen = reqGen
  linkError.value = ''
  linkBusy.value = true
  try {
    const data = await regenerateMailShare(opened) || {}
    if (!isCurrent(gen, opened)) {
      return
    }
    linkOnce.value = data.shareUrl || ''
    // 这次轮换刚把取回的那条作废。继续挂着它,管理员会把一条死链接复制出去。
    revealedLink.value = ''
    revealError.value = ''
    ElMessage({message: tf('shareLinkRegenerated'), type: 'success', plain: true})
    emit('changed')
  } catch (err) {
    if (!isCurrent(gen, opened)) {
      return
    }
    if (isGone(err)) {
      closeGone()
      return
    }
    // 与 submitSave 的末支同一条理由:没有兜底时,服务端新加的码在界面上什么都不会发生,
    // 管理员分辨不出「被拒了」和「按钮是死的」。
    linkError.value = err && err.message === 'SHARE_CAPABILITY_NOT_ENABLED'
      ? tf('shareCapabilityNotEnabled')
      : tf('shareLinkRegenerateFailed')
    console.error('mail share regenerate failed', {code: err && err.code, message: err && err.message})
    return
  } finally {
    linkBusy.value = false
  }
  // regenerate 回的是 create 形状(没有 name / effectiveStatus / authKeyEnabled),灌进 applyDetail
  // 会把表头清空。详情接口是唯一带这些字段的形状,而库里的 lid 已经换了,必须重读。
  await load(opened)
}

function askRegenerate() {
  if (!writable.value) {
    return
  }
  // 踢掉在途访客是管理员事后无法撤销、也无法自行发现的副作用:文案必须把它说出来,
  // 而不是只问一句「确定要重新生成吗」。
  ElMessageBox.confirm(
      tf('shareLinkRegenerateConfirm'),
      {
        confirmButtonText: t('confirm'),
        cancelButtonText: t('cancel'),
        type: 'warning'
      }
  ).then(() => submitRegenerate()).catch((err) => {
    if (isDismissal(err)) {
      return
    }
    console.error('mail share regenerate confirm failed', {err})
  })
}

// 后端把取不回来的五种成因收敛成四个码,每个对应一个不同的下一步动作。前两个是
// 「你可以自助解决」(重新生成一条),后两个是「系统有问题」(找管理员/运维)。
// ⛔ 不要把它们折回一句「获取失败」—— 那等于把判断又推回给管理员。
const REVEAL_ERROR_KEYS = {
  SHARE_SEC_ABSENT: 'shareSecAbsent',
  SHARE_SEC_UNAVAILABLE: 'shareSecUnavailable',
  SHARE_SEC_KEY_RETIRED: 'shareSecKeyRetired',
  SHARE_SEC_CORRUPTED: 'shareSecCorrupted'
}

// 轨一的读取端(ADR-share-credential-recoverability):把当初发出去的那条链接原样取回。
// 与 askRegenerate 不同,这里没有确认框 —— 它不改任何状态,而且失败远比成功常见,
// 先弹一个「确定要查看吗」只会让管理员在四种成因面前多点一次。
async function submitReveal() {
  if (revealBusy.value) {
    return
  }
  const opened = props.shareId
  const gen = reqGen
  revealError.value = ''
  revealBusy.value = true
  try {
    const data = await revealMailShareSec(opened) || {}
    if (!isCurrent(gen, opened)) {
      return
    }
    // 两块链接同屏时,管理员没有任何办法看出哪条是现在有效的那条。取回的这条是当前
    // 有效的,刚铸的那条已经被它取代 —— 让位的必须是「只显示这一次」的那块。
    linkOnce.value = ''
    linkError.value = ''
    revealedLink.value = data.shareUrl || ''
  } catch (err) {
    if (!isCurrent(gen, opened)) {
      return
    }
    if (isGone(err)) {
      closeGone()
      return
    }
    // 兜底不可省:没有它时,服务端新加的码在界面上什么都不会发生,管理员分辨不出
    // 「被拒了」和「按钮是死的」。本轮这个缺陷已在三处出现过。
    const key = REVEAL_ERROR_KEYS[err && err.message] || 'shareLinkRevealFailed'
    revealError.value = tf(key)
    console.error('mail share reveal failed', {code: err && err.code, message: err && err.message})
  } finally {
    revealBusy.value = false
  }
}

async function copyRevealedLink() {
  const result = await copyRevealText(revealedLink.value)
  if (result.copied) {
    ElMessage({message: t('copySuccessMsg'), type: 'success', plain: true})
  }
}

async function copyLink() {
  const result = await copyLinkText(linkOnce.value)
  if (result.copied) {
    ElMessage({message: t('copySuccessMsg'), type: 'success', plain: true})
  }
}

async function copyAuthKey() {
  const result = await copy(authKeyOnce.value)
  if (result.copied) {
    ElMessage({message: t('copySuccessMsg'), type: 'success', plain: true})
  }
}

watch(() => props.shareId, (shareId) => {
  bumpGen()
  detail.value = null
  loadError.value = false
  configError.value = ''
  bindingError.value = ''
  authKeyError.value = ''
  authKeyOnce.value = ''
  linkError.value = ''
  linkOnce.value = ''
  revealError.value = ''
  revealedLink.value = ''
  accounts.value = []
  accountsDone.value = false
  addAccountId.value = null
  renewChoice.value = RENEW_KEEP
  form.expiresAtLocal = ''
  if (shareId > 0) {
    load(shareId)
  }
}, {immediate: true})
</script>

<style lang="scss" scoped>
.detail {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.detail-panel {
  padding: 24px 0;
  text-align: center;
  line-height: 1.6;
  color: var(--regular-text-color);
}

.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.detail-name {
  margin: 0;
  min-width: 0;
  font-size: 17px;
  font-weight: bold;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.detail-badges {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}

.detail-fields {
  margin: 0;
  display: grid;
  gap: 6px;

  .field {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 13px;
  }

  .field-label {
    flex: none;
    width: 96px;
    color: var(--secondary-text-color);
  }

  .field-value {
    margin: 0;
    min-width: 0;
    color: var(--regular-text-color);
  }

  .field-numeric {
    font-variant-numeric: tabular-nums;
  }
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 16px;
  border-top: 1px solid var(--light-border);
}

.panel-title {
  margin: 0;
  font-size: 14px;
  font-weight: bold;
  color: var(--regular-text-color);
}

.binding-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.binding-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--extra-light-fill);
}

.binding-mailbox {
  min-width: 0;
  font-size: 13px;
  word-break: break-all;
  color: var(--regular-text-color);
}

.binding-add {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.binding-select {
  flex: 1;
  min-width: 180px;
}

.config-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.config-row-inline {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.config-label {
  font-size: 13px;
  color: var(--secondary-text-color);
}

.config-limit {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.config-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--secondary-text-color);
}

.config-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 4px;
}

.authkey-state {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.authkey-once {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--el-color-warning-light-5);
  border-radius: 6px;
  background: var(--el-color-warning-light-9);
}

.authkey-once-warning {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-color-warning-dark-2);
}

.authkey-once-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.authkey-input {
  flex: 1;
  min-width: 200px;
  padding: 6px 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  background: var(--el-bg-color);
  color: var(--regular-text-color);
  font-family: var(--el-font-family, monospace);
  font-variant-numeric: tabular-nums;
}

.notice {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--regular-text-color);
}

.notice-muted {
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--extra-light-fill);
  color: var(--secondary-text-color);
}

.notice-danger {
  color: var(--el-color-danger);
}

@media (max-width: 767px) {
  .detail {
    gap: 14px;
  }

  .detail-fields .field {
    flex-direction: column;
    gap: 2px;
  }

  .detail-fields .field-label {
    width: auto;
  }

  .config-row-inline {
    align-items: flex-start;
  }

  // 44px touch targets on the phone breakpoint; element-plus defaults to 32px.
  .binding-add :deep(.el-button),
  .config-actions :deep(.el-button),
  .authkey-state :deep(.el-button),
  .authkey-once-row :deep(.el-button) {
    min-height: 44px;
  }
}
</style>
