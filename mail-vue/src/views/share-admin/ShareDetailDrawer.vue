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
              :type="statusMeta(detail.effectiveStatus).tone"
              data-test="detail-status"
              :data-status="detail.effectiveStatus"
          >
            {{ statusText(detail.effectiveStatus) }}
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
          <dd class="field-value" data-test="detail-created">{{ detail.createTime || '-' }}</dd>
        </div>
        <div class="field">
          <dt class="field-label">{{ $t('shareExpiresAt') }}</dt>
          <dd class="field-value" data-test="detail-expires">{{ detail.expiresAt || '-' }}</dd>
        </div>
        <div class="field">
          <dt class="field-label">{{ $t('shareLastAccess') }}</dt>
          <dd class="field-value" data-test="detail-last-access">{{ detail.lastAccessAt || '-' }}</dd>
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
  resetMailShareAuthKey,
  updateMailShare,
  updateMailShareBindings
} from "@/request/mail-share.js"
import {bindingLabels, isMutableStatus, quotaText, shareTypeLabelKey, statusMeta} from "./status.js"

defineOptions({
  name: 'share-detail-drawer'
})

const props = defineProps({
  shareId: {type: Number, default: 0}
})
const emit = defineEmits(['update:shareId', 'changed'])

const {t, te} = useI18n()
const {copy, selectableRef} = useCopyWithFallback()

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
  shareConfigRejected: '这项配置未被接受：可能超出了当前允许的取值，或这项能力尚未开放。请调整后重试。',
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
  shareAuthKeyFailed: '无法完成：可能是这项能力尚未开放，或分享状态刚刚变化。请刷新后重试。'
}

function tf(key) {
  return te(key) ? t(key) : (PENDING_COPY[key] || key)
}

// Mirrors of backend constants that the browser has to enforce before the request leaves:
// SHARE_BINDING_LIMIT, account/list's hard size cap, and MIN_REFRESH_INTERVAL_MS.
const BINDING_LIMIT = 50
const ACCOUNT_PAGE_SIZE = 30
const MIN_REFRESH_INTERVAL_MS = 3000

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
  showFullAddress: false
})

const open = computed(() => props.shareId > 0)
const writable = computed(() => Boolean(detail.value) && isMutableStatus(detail.value.effectiveStatus))

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
}

function close() {
  bumpGen()
  authKeyOnce.value = ''
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
    if (err && err.message === 'SHARE_INVALID_CONFIG') {
      configError.value = tf('shareConfigRejected')
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
    // SHARE_INVALID_CONFIG here is ambiguous by design: either the capability is not open yet
    // or another tab already moved the state. Offer both readings plus a refresh, and do not
    // claim to know which one happened.
    authKeyError.value = tf('shareAuthKeyFailed')
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
  accounts.value = []
  accountsDone.value = false
  addAccountId.value = null
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
