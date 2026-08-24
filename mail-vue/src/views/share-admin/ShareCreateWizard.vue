<template>
  <el-button type="primary" data-test="wizard-open" @click="openDialog">
    {{ tf('shareWizardOpen') }}
  </el-button>

  <el-dialog
      class="share-create-wizard"
      data-test="share-create-wizard"
      :model-value="visible"
      :title="tf('shareWizardTitle')"
      width="min(680px, calc(100vw - 32px))"
      @update:model-value="onOpenChange"
  >
    <div v-if="created" class="result" data-test="wizard-result" aria-live="polite">
      <template v-if="replayWithoutSecret">
        <p class="result-title" data-test="share-replay">{{ $t('shareReplayNoSecret') }}</p>
        <dl class="result-fields">
          <div class="field">
            <dt class="field-label">{{ tf('shareWizardShareId') }}</dt>
            <dd class="field-value field-numeric" data-test="replay-share-id">{{ created.shareId }}</dd>
          </div>
          <div class="field">
            <dt class="field-label">{{ tf('shareWizardLinkId') }}</dt>
            <dd class="field-value" data-test="replay-lid">{{ created.lid }}</dd>
          </div>
        </dl>
        <p class="result-hint" data-test="replay-guidance">{{ tf('shareReplayGuidance') }}</p>
      </template>

      <template v-else>
        <p class="result-title" data-test="secret-once">{{ $t('shareSecretOnce') }}</p>
        <div class="secret">
          <label class="row-label" for="wizard-created-url">{{ tf('shareWizardLinkLabel') }}</label>
          <div class="secret-row">
            <input
                id="wizard-created-url"
                ref="urlSelectableRef"
                class="secret-input"
                data-test="share-url"
                type="text"
                readonly
                :value="createdShareUrl"
            />
            <el-button data-test="copy-share-url" @click="copyCreatedLink">{{ $t('shareCopyLink') }}</el-button>
          </div>
        </div>

        <div v-if="createdAuthKey" class="secret" data-test="authkey-once">
          <label class="row-label" for="wizard-created-authkey">{{ tf('shareAuthKey') }}</label>
          <div class="secret-row">
            <input
                id="wizard-created-authkey"
                ref="keySelectableRef"
                class="secret-input"
                data-test="authkey-value"
                type="text"
                readonly
                :value="createdAuthKey"
            />
            <el-button data-test="copy-authkey" @click="copyCreatedAuthKey">{{ $t('copy') }}</el-button>
          </div>
        </div>

        <el-button type="primary" data-test="created-saved" @click="acknowledgeSecret">
          {{ tf('shareCreatedSaved') }}
        </el-button>
      </template>
    </div>

    <template v-else>
      <p class="warning" data-test="wizard-warning">{{ $t('shareCreateWarning') }}</p>

      <section class="section">
        <h4 :id="presetLabelId" class="section-title">{{ tf('shareWizardPresetStep') }}</h4>
        <div class="preset-grid" role="radiogroup" :aria-labelledby="presetLabelId">
          <button
              v-for="preset in SHARE_PRESETS"
              :key="preset.id"
              class="preset-card"
              :class="{'preset-card-on': form.presetId === preset.id}"
              type="button"
              role="radio"
              :aria-checked="form.presetId === preset.id"
              :disabled="locked"
              :data-test="`preset-${preset.id}`"
              @click="applyPreset(preset.id)"
          >
            <span class="preset-name">
              <Icon
                  class="preset-mark"
                  :icon="form.presetId === preset.id ? 'ion:checkmark-circle' : 'ion:ellipse-outline'"
                  width="16"
                  height="16"
              />
              {{ tf(preset.labelKey) }}
            </span>
            <span class="preset-hint">{{ tf(preset.hintKey) }}</span>
          </button>
        </div>
      </section>

      <section class="section">
        <div class="row">
          <label class="row-label" for="wizard-mailboxes">{{ tf('shareWizardMailboxes') }}</label>
          <el-select
              id="wizard-mailboxes"
              v-model="mailboxModel"
              class="row-control"
              data-test="mailbox-select"
              :multiple="multiEnabled"
              :disabled="locked"
              :placeholder="$t('shareMailbox')"
          >
            <el-option
                v-for="item in accounts"
                :key="item.accountId"
                :label="item.email"
                :value="item.accountId"
            />
          </el-select>
          <el-button
              v-if="!accountsDone"
              text
              data-test="mailbox-load-more"
              :loading="accountsLoading"
              :disabled="locked"
              @click="loadAccounts"
          >
            {{ tf('shareBindingLoadMore') }}
          </el-button>
        </div>
        <p v-if="overBindingLimit" class="notice notice-danger" data-test="binding-limit" role="alert">
          {{ tf('shareBindingLimitReached') }}
        </p>

        <div class="row">
          <label class="row-label" for="wizard-duration">{{ tf('shareWizardDuration') }}</label>
          <el-select
              id="wizard-duration"
              v-model="form.durationSeconds"
              class="row-control"
              data-test="wizard-duration"
              :disabled="locked"
          >
            <el-option
                v-for="item in DURATION_OPTIONS"
                :key="item.value"
                :label="$t(item.labelKey)"
                :value="item.value"
            />
          </el-select>
        </div>

        <div class="row">
          <label class="row-label" for="wizard-name">{{ tf('shareName') }}</label>
          <el-input
              id="wizard-name"
              v-model="form.name"
              class="row-control"
              data-test="wizard-name"
              maxlength="64"
              :disabled="locked"
              :placeholder="$t('shareNamePlaceholder')"
          />
        </div>

        <div class="row">
          <label class="row-label" for="wizard-remark">{{ tf('shareRemark') }}</label>
          <el-input
              id="wizard-remark"
              v-model="form.remark"
              class="row-control"
              data-test="wizard-remark"
              maxlength="200"
              :disabled="locked"
              :placeholder="$t('shareRemarkPlaceholder')"
          />
        </div>
      </section>

      <el-collapse v-model="advancedNames" class="advanced">
        <el-collapse-item name="advanced" :title="tf('shareWizardAdvanced')">
          <div class="row row-inline">
            <label class="row-label" for="wizard-only-after">{{ tf('shareOnlyAfterCreated') }}</label>
            <el-switch
                id="wizard-only-after"
                v-model="form.onlyMessagesAfterCreated"
                data-test="only-after-created"
                :disabled="locked"
            />
          </div>
          <p class="hint" data-test="only-after-created-hint">{{ tf('shareOnlyAfterCreatedHint') }}</p>

          <div class="row row-inline">
            <label class="row-label" for="wizard-otp">{{ tf('shareOtpExtraction') }}</label>
            <el-switch id="wizard-otp" v-model="form.otpExtractionEnabled" data-test="otp-toggle" :disabled="locked"/>
          </div>

          <div class="row row-inline">
            <label class="row-label" for="wizard-auto-refresh">{{ tf('shareAutoRefresh') }}</label>
            <el-switch
                id="wizard-auto-refresh"
                v-model="form.autoRefresh"
                data-test="auto-refresh-toggle"
                :disabled="locked"
            />
          </div>

          <div class="row">
            <label class="row-label" for="wizard-interval">{{ tf('shareRefreshInterval') }}</label>
            <el-input-number
                id="wizard-interval"
                v-model="form.refreshIntervalMs"
                class="row-control"
                data-test="refresh-interval"
                :min="MIN_REFRESH_INTERVAL_MS"
                :step="1000"
                :controls="false"
                :disabled="locked"
            />
          </div>

          <div class="row row-inline">
            <label class="row-label" for="wizard-mask">{{ tf('shareShowFullAddress') }}</label>
            <el-switch id="wizard-mask" v-model="form.showFullAddress" data-test="mask-toggle" :disabled="locked"/>
          </div>
          <p class="hint" data-test="mask-toggle-hint">{{ tf('shareShowFullAddressHint') }}</p>

          <div class="gated">
            <p v-if="gatedDisabled" class="notice notice-muted" data-test="capability-inactive">
              <strong>{{ tf('shareCapabilityInactive') }}</strong>
              {{ tf('shareCapabilityInactiveHint') }}
              <el-button text data-test="capability-recheck" @click="recheck">
                {{ tf('shareCapabilityRecheck') }}
              </el-button>
            </p>
            <p v-else class="hint" data-test="capability-unknown-hint">{{ tf('shareCapabilityUnknownHint') }}</p>

            <div class="row row-inline">
              <label class="row-label" for="wizard-authkey">{{ tf('shareAuthKey') }}</label>
              <el-switch
                  id="wizard-authkey"
                  v-model="form.authKeyEnabled"
                  data-test="authkey-toggle"
                  :disabled="locked || gatedDisabled"
              />
            </div>

            <div class="row">
              <label class="row-label" for="wizard-max-sessions">{{ tf('shareMaxSessions') }}</label>
              <el-input-number
                  id="wizard-max-sessions"
                  v-model="form.maxSessions"
                  class="row-control"
                  data-test="max-sessions"
                  :min="1"
                  :controls="false"
                  :disabled="locked || gatedDisabled"
                  :placeholder="tf('shareQuotaUnlimited')"
              />
            </div>

            <div class="row">
              <label class="row-label" for="wizard-message-limit">{{ tf('shareMessageLimit') }}</label>
              <el-input-number
                  id="wizard-message-limit"
                  v-model="form.messageLimit"
                  class="row-control"
                  data-test="message-limit"
                  :min="1"
                  :controls="false"
                  :disabled="locked || gatedDisabled"
                  :placeholder="tf('shareQuotaUnlimited')"
              />
            </div>
          </div>
        </el-collapse-item>
      </el-collapse>

      <div v-if="locked" class="notice notice-warning" data-test="wizard-unknown" role="alert">
        <strong>{{ tf('shareCreateUnknownTitle') }}</strong>
        {{ tf('shareCreateUnknownHint') }}
      </div>

      <p v-else-if="formError" class="notice notice-danger" data-test="wizard-error" role="alert">
        {{ formError }}
      </p>
    </template>

    <template #footer>
      <el-button data-test="wizard-close" @click="onOpenChange(false)">{{ $t('cancel') }}</el-button>
      <el-button
          v-if="!created && locked"
          type="primary"
          data-test="wizard-retry"
          :loading="submitting"
          :disabled="submitting"
          @click="submit"
      >
        {{ tf('shareCreateRetrySameKey') }}
      </el-button>
      <el-button
          v-else-if="!created"
          type="primary"
          data-test="wizard-submit"
          :loading="submitting"
          :disabled="submitting || overBindingLimit"
          @click="submit"
      >
        {{ $t('shareCreate') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import {computed, reactive, ref, watch} from "vue"
import {Icon} from "@iconify/vue"
import {useI18n} from "vue-i18n"
import {ElMessage, ElMessageBox} from "element-plus"
import {useAccountStore} from "@/store/account.js"
import {useCopyWithFallback} from "@/composables/useCopyWithFallback.js"
import {accountList} from "@/request/account.js"
import {createMailShare, newIdempotencyKey} from "@/request/mail-share.js"
import {buildShareUrl} from "@/views/email/build-share-url.js"
import {
  SHARE_PRESETS,
  capabilityV2,
  findPreset,
  hasFenceIntent,
  markCapabilityInactive,
  presetFormValues,
  recheckCapabilityV2
} from "./presets.js"

defineOptions({
  name: 'share-create-wizard'
})

const emit = defineEmits(['created'])

const {t, te} = useI18n()
// Two one-shot values, so two composable instances: selectableRef is what the manual-copy
// fallback focuses and selects, and one ref cannot hold two inputs.
const {copy: copyUrl, selectableRef: urlSelectableRef} = useCopyWithFallback()
const {copy: copyKey, selectableRef: keySelectableRef} = useCopyWithFallback()

// T-28/T-29 are the only writers of i18n/zh.js and i18n/en.js. Until they land the keys
// registered in exec-t22-note.md, fall back to the agreed copy instead of painting a raw key
// name on screen; te() flips to the real translation the moment they exist.
const PENDING_COPY = {
  shareWizardOpen: '新建分享',
  shareWizardTitle: '新建分享',
  shareWizardPresetStep: '选一个用途',
  sharePresetSingleOtp: '单邮箱验证码',
  sharePresetSingleOtpHint: '把一个邮箱的验证码分给同事，1 小时后自动失效。',
  sharePresetTempMailbox: '临时邮箱',
  sharePresetTempMailboxHint: '对方需要看到完整地址去别处注册，有效期 24 小时。',
  sharePresetMultiOtp: '多邮箱验证码池',
  sharePresetMultiOtpHint: '一个链接汇总多个邮箱的验证码，需平台已激活该能力。',
  sharePresetCustom: '自定义',
  sharePresetCustomHint: '全部选项展开，自己配。',
  shareWizardAdvanced: '高级选项',
  shareWizardMailboxes: '分享的邮箱',
  shareWizardDuration: '有效期',
  shareWizardLinkLabel: '分享链接',
  shareWizardShareId: '分享 ID',
  shareWizardLinkId: '链接 ID',
  shareOnlyAfterCreated: '只显示创建之后收到的邮件',
  shareOnlyAfterCreatedHint: '创建后无法更改这一项。',
  shareCapabilityInactive: '能力未激活',
  shareCapabilityInactiveHint: '平台尚未开放多邮箱、访问密钥与用量上限。已为你关掉这几项，其余设置可以照常提交。',
  shareCapabilityUnknownHint: '若平台尚未开放该能力，带这几项的提交会被拒绝。',
  shareCapabilityRecheck: '重新检测',
  shareCreateUnknownTitle: '没收到服务器的回应',
  shareCreateUnknownHint: '分享可能已经建好了。请用同一把钥匙重试 —— 换一把会建出第二个分享。表单已锁定，以免重试时改动了内容。',
  shareCreateRetrySameKey: '用同一把钥匙重试',
  shareReplayGuidance: '这次提交命中了之前的同一请求，链接明文不会再发放。请撤销或删除这个分享，然后重新创建一个新链接。',
  shareWizardCloseConfirm: '关闭后将无法再看到这个链接（和密钥）。确认已经保存好了吗？',
  shareCreatedSaved: '我已保存',
  shareWizardCountTooSmall: '上限至少是 1；留空表示不限。',
  shareName: '名称',
  shareRemark: '备注',
  shareMaxSessions: '会话上限',
  shareMessageLimit: '邮件条数上限',
  shareOtpExtraction: '提取验证码',
  shareAutoRefresh: '自动刷新',
  shareRefreshInterval: '刷新间隔（毫秒，最小 3000）',
  shareRefreshIntervalTooSmall: '刷新间隔不能小于 3000 毫秒。',
  shareShowFullAddress: '显示完整地址（展示选项）',
  shareShowFullAddressHint: '只影响分享页上邮箱地址的显示方式。关闭它不会改变邮件正文、主题或发件人里出现的地址。',
  shareAuthKey: '访问密钥',
  shareBindingLoadMore: '加载更多邮箱',
  shareBindingLimitReached: '一个分享最多绑定 50 个邮箱。',
  shareQuotaUnlimited: '不限'
}

function tf(key) {
  return te(key) ? t(key) : (PENDING_COPY[key] || key)
}

// Mirrors of backend constants the browser has to enforce before the request leaves:
// SHARE_BINDING_LIMIT, account/list's hard size cap, and MIN_REFRESH_INTERVAL_MS.
const BINDING_LIMIT = 50
const ACCOUNT_PAGE_SIZE = 30
const MIN_REFRESH_INTERVAL_MS = 3000

const DURATION_OPTIONS = [
  {value: 3600, labelKey: 'shareDuration1h'},
  {value: 21600, labelKey: 'shareDuration6h'},
  {value: 86400, labelKey: 'shareDuration1d'},
  {value: 604800, labelKey: 'shareDuration7d'}
]

const presetLabelId = 'share-wizard-preset-label'
const accountStore = useAccountStore()

const visible = ref(false)
const submitting = ref(false)
// The response never arrived, so the share may or may not exist. Locking the form is what
// makes "retry with the same key" reachable: the key may only rotate when the fingerprint
// changes, and the fingerprint can only change if the owner can edit.
const unknownResult = ref(false)
const formError = ref('')
// The only place the plaintext link and auth key ever live. Not storage, not pinia, not the
// URL: the list and the detail drawer never return them again.
const created = ref(null)
const advancedNames = ref([])
const accounts = ref([])
const accountsDone = ref(false)
const accountsLoading = ref(false)
const idempotencyKey = ref(newIdempotencyKey())

const form = reactive({
  presetId: SHARE_PRESETS[0].id,
  accountIds: [],
  name: '',
  remark: '',
  ...presetFormValues(SHARE_PRESETS[0].id)
})

const locked = computed(() => unknownResult.value)
const gatedDisabled = computed(() => capabilityV2.value === 'inactive')
const activePreset = computed(() => findPreset(form.presetId))
const multiEnabled = computed(() => activePreset.value.multi && !gatedDisabled.value)
const overBindingLimit = computed(() => form.accountIds.length > BINDING_LIMIT)

// The request always speaks accountIds, but a non-multiple el-select cannot render an array
// and silently falls back to its placeholder — the owner sees "no mailbox chosen" over a
// mailbox that is in fact chosen. One list inside, whichever shape the picker is in.
const mailboxModel = computed({
  get() {
    if (multiEnabled.value) {
      return form.accountIds
    }
    return form.accountIds.length > 0 ? form.accountIds[0] : null
  },
  set(value) {
    if (Array.isArray(value)) {
      form.accountIds = value
      return
    }
    form.accountIds = value == null || value === '' ? [] : [value]
  }
})

const createdShareUrl = computed(() => {
  const data = created.value
  if (!data) {
    return ''
  }
  if (data.shareUrl) {
    return data.shareUrl
  }
  if (data.lid && data.sec && typeof window !== 'undefined') {
    return buildShareUrl(window.location.origin, data.lid, data.sec)
  }
  return ''
})

const createdAuthKey = computed(() => (created.value && created.value.authKey) || '')

const replayWithoutSecret = computed(() => {
  const data = created.value
  return Boolean(data && data.idempotentReplay && !data.sec && !data.shareUrl)
})

const hasUnsavedSecret = computed(() => Boolean(createdShareUrl.value || createdAuthKey.value))

function rotateIdempotencyKey() {
  idempotencyKey.value = newIdempotencyKey()
}

function applyPreset(presetId, resetMailboxes = false) {
  const preset = findPreset(presetId)
  Object.assign(form, preset.form)
  form.presetId = presetId
  if (resetMailboxes) {
    const current = Number(accountStore.currentAccountId) || 0
    form.accountIds = current > 0 ? [current] : []
  }
  if (!(preset.multi && !gatedDisabled.value)) {
    form.accountIds = form.accountIds.slice(0, 1)
  }
  advancedNames.value = preset.advancedOpen ? ['advanced'] : []
  formError.value = ''
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

function openDialog() {
  visible.value = true
  created.value = null
  unknownResult.value = false
  formError.value = ''
  form.name = ''
  form.remark = ''
  accounts.value = []
  accountsDone.value = false
  applyPreset(form.presetId, true)
  rotateIdempotencyKey()
  loadAccounts()
}

function closeNow() {
  visible.value = false
  created.value = null
  unknownResult.value = false
  formError.value = ''
}

function onOpenChange(value) {
  if (value) {
    return
  }
  // Losing a form costs a minute of retyping; losing the plaintext costs the share. Only the
  // second one is worth a confirm.
  if (hasUnsavedSecret.value) {
    ElMessageBox.confirm(tf('shareWizardCloseConfirm'), {
      confirmButtonText: t('confirm'),
      cancelButtonText: t('cancel'),
      type: 'warning'
    }).then(closeNow).catch(() => {})
    return
  }
  closeNow()
}

function acknowledgeSecret() {
  created.value = null
}

function isCount(value) {
  if (value == null || value === '') {
    return true
  }
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 1
}

// Every range the backend enforces, checked before the request leaves. This is not polish:
// SHARE_INVALID_CONFIG covers both a bad range and the capability fence, so an unchecked
// range error would be read as "the platform disabled this" and grey four groups over a typo.
function localError() {
  if (form.accountIds.length === 0) {
    return 'shareAccountRequired'
  }
  if (form.accountIds.length > BINDING_LIMIT) {
    return 'shareBindingLimitReached'
  }
  if (!(Number(form.durationSeconds) > 0)) {
    return 'shareDurationRequired'
  }
  if (form.refreshIntervalMs != null && form.refreshIntervalMs !== ''
      && Number(form.refreshIntervalMs) < MIN_REFRESH_INTERVAL_MS) {
    return 'shareRefreshIntervalTooSmall'
  }
  if (!isCount(form.maxSessions) || !isCount(form.messageLimit)) {
    return 'shareWizardCountTooSmall'
  }
  return ''
}

// Explicit defaults are safe: the fingerprint is taken after normalizeCreateBody, where a
// missing key and its default collapse to the same value. Absent keys are the ones the owner
// left blank, which is not the same statement as "set this to zero".
function buildBody() {
  const body = {
    accountIds: [...form.accountIds],
    durationSeconds: Number(form.durationSeconds),
    name: form.name,
    remark: form.remark,
    onlyMessagesAfterCreated: form.onlyMessagesAfterCreated,
    otpExtractionEnabled: form.otpExtractionEnabled,
    autoRefresh: form.autoRefresh,
    showFullAddress: form.showFullAddress,
    authKeyEnabled: form.authKeyEnabled
  }
  if (form.refreshIntervalMs != null && form.refreshIntervalMs !== '') {
    body.refreshIntervalMs = Number(form.refreshIntervalMs)
  }
  if (form.maxSessions != null && form.maxSessions !== '') {
    body.maxSessions = Number(form.maxSessions)
  }
  if (form.messageLimit != null && form.messageLimit !== '') {
    body.messageLimit = Number(form.messageLimit)
  }
  return body
}

// A business code means the server decided; anything else (AxiosError, a 5xx with someone
// else's envelope, a thrown null) means the write may already have landed.
function isBusinessError(err) {
  return Boolean(err) && Number.isInteger(err.code) && typeof err.message === 'string'
}

function degradeToInactive() {
  markCapabilityInactive()
  form.accountIds = form.accountIds.slice(0, 1)
  form.authKeyEnabled = false
  form.maxSessions = null
  form.messageLimit = null
}

function recheck() {
  recheckCapabilityV2()
}

async function submit() {
  if (submitting.value) {
    return
  }
  formError.value = ''
  const invalid = localError()
  if (invalid) {
    formError.value = tf(invalid)
    return
  }
  created.value = null
  const body = buildBody()
  // Read before the request: degrading is only honest when this submission actually asked for
  // something the fence guards.
  const fenceIntent = hasFenceIntent(body)
  submitting.value = true
  try {
    const data = await createMailShare(body, idempotencyKey.value)
    unknownResult.value = false
    created.value = data || null
    // A replay means the row exists too, and the guidance sends the owner to the list to
    // revoke or delete it; refreshing behind that is the difference between advice and a
    // dead end.
    emit('created')
    if (!(data && data.idempotentReplay)) {
      rotateIdempotencyKey()
    }
  } catch (err) {
    if (isBusinessError(err)) {
      unknownResult.value = false
      // SHARE_INVALID_CONFIG is the same code for a bad range and a disabled capability, and
      // assertCreateBody runs domain and limit checks first. So the fence is only a sound
      // reading when this body asked for a gated write and every local range already passed.
      if (fenceIntent && err.message === 'SHARE_INVALID_CONFIG') {
        degradeToInactive()
      }
    } else {
      unknownResult.value = true
    }
    console.error('mail share create failed', {code: err && err.code, message: err && err.message})
  } finally {
    submitting.value = false
  }
}

async function copyCreatedLink() {
  const result = await copyUrl(createdShareUrl.value)
  if (result.copied) {
    ElMessage({message: t('copySuccessMsg'), type: 'success', plain: true})
  }
}

async function copyCreatedAuthKey() {
  const result = await copyKey(createdAuthKey.value)
  if (result.copied) {
    ElMessage({message: t('copySuccessMsg'), type: 'success', plain: true})
  }
}

// ShareDialog rotates on every form edit so a changed body cannot collide with a stored
// fingerprint. The wizard needs the same reflex plus one gate: while the result is unknown the
// key must survive, and it does because an unknown result also freezes the form.
watch(form, () => {
  if (!unknownResult.value) {
    rotateIdempotencyKey()
  }
})
</script>

<style lang="scss" scoped>
.warning {
  margin: 0 0 14px;
  line-height: 1.6;
  color: var(--el-color-warning-dark-2);
}

.section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: 16px;
}

.section-title {
  margin: 0;
  font-size: 14px;
  font-weight: bold;
  color: var(--regular-text-color);
}

.preset-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

// A real button, not a div with a click handler: the preset row is the first thing keyboard
// and screen reader users land on.
.preset-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-height: 66px;
  padding: 10px 12px;
  text-align: left;
  cursor: pointer;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  background: var(--el-bg-color);
  color: var(--regular-text-color);
  transition: border-color 200ms, background-color 200ms;

  &:hover:not(:disabled) {
    border-color: var(--el-color-primary-light-5);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
}

// Selection is carried by the border, the fill and the check mark together, so it survives
// both dark mode and colour-blind vision.
.preset-card-on {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.preset-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: bold;
}

.preset-mark {
  flex: none;
  color: var(--el-color-primary);
}

.preset-hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--secondary-text-color);
}

.row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.row-inline {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.row-label {
  font-size: 13px;
  color: var(--secondary-text-color);
}

.row-control {
  width: 100%;
}

.advanced {
  margin-bottom: 12px;

  .row {
    padding-top: 10px;
  }
}

.gated {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px dashed var(--el-border-color);
  border-radius: 8px;
}

.hint {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--secondary-text-color);
}

.notice {
  margin: 10px 0 0;
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

.notice-warning {
  padding: 10px 12px;
  border: 1px solid var(--el-color-warning-light-5);
  border-radius: 6px;
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
}

.notice-danger {
  color: var(--el-color-danger);
}

.result {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--el-color-warning-light-5);
  border-radius: 8px;
  background: var(--el-color-warning-light-9);
}

.result-title {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-color-warning-dark-2);
}

.result-hint {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--regular-text-color);
}

.result-fields {
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
    width: 72px;
    color: var(--secondary-text-color);
  }

  .field-value {
    margin: 0;
    min-width: 0;
    word-break: break-all;
    color: var(--regular-text-color);
  }

  .field-numeric {
    font-variant-numeric: tabular-nums;
  }
}

.secret {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.secret-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.secret-input {
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

@media (max-width: 767px) {
  .preset-grid {
    grid-template-columns: 1fr;
  }

  .row-inline {
    align-items: flex-start;
  }

  // 44px touch targets on the phone breakpoint; element-plus defaults to 32px.
  .secret-row :deep(.el-button),
  .result :deep(.el-button) {
    min-height: 44px;
  }
}
</style>
