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
      :close-on-click-modal="!submitting"
      :close-on-press-escape="!submitting"
      :show-close="!submitting"
      @update:model-value="onOpenChange"
  >
    <div v-if="created" class="result" data-test="wizard-result" aria-live="polite">
      <template v-if="replayWithoutSecret">
        <p class="result-title" data-test="share-replay">{{ $t('shareReplayNoSecret') }}</p>
        <!-- 单条与 V2=false 批量共用一个面板：批量重放的 response 是 { shares, idempotentReplay }，
             每条都得列出来 —— 只报第一条会让 Owner 以为其余分享不存在，再建一遍。 -->
        <dl v-for="item in replayShares" :key="item.lid" class="result-fields">
          <div class="field">
            <dt class="field-label">{{ tf('shareWizardShareId') }}</dt>
            <dd class="field-value field-numeric" data-test="replay-share-id">{{ item.shareId }}</dd>
          </div>
          <div class="field">
            <dt class="field-label">{{ tf('shareWizardLinkId') }}</dt>
            <dd class="field-value" data-test="replay-lid">{{ item.lid }}</dd>
          </div>
        </dl>
        <p class="result-hint" data-test="replay-guidance">{{ tf('shareReplayGuidance') }}</p>
      </template>

      <!-- P2 批量分流（DC-P0-1）：V2=false 的多地址响应是 { shares: [...] }，一人一条链接。
           批量分享不可能带 AuthKey —— 它只在 V2=false 下出现，而 authKeyEnabled 在那里
           先被栅栏拒掉了，所以这个面板没有密钥区。 -->
      <template v-else-if="createdShares.length">
        <p class="result-title" data-test="secret-once">{{ tf('shareWizardBatchCreated', {count: createdShares.length}) }}</p>
        <div v-for="item in createdShares" :key="item.lid" class="secret" data-test="share-url-item">
          <label class="row-label" :for="`wizard-created-url-${item.lid}`">{{ item.mailbox || item.lid }}</label>
          <div class="secret-row">
            <input
                :id="`wizard-created-url-${item.lid}`"
                class="secret-input"
                data-test="share-url"
                type="text"
                readonly
                :value="shareItemUrl(item)"
            />
            <el-button data-test="copy-share-url" @click="copyItemLink(item)">{{ $t('shareCopyLink') }}</el-button>
          </div>
        </div>
        <el-button type="primary" data-test="created-saved" @click="acknowledgeSecret">
          {{ tf('shareCreatedSaved') }}
        </el-button>
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
          <!-- The link above is retrievable from the detail drawer, the key is not: it is stored
               as a one-way hash and nothing can bring it back. This warning used to be carried by
               shareSecretOnce, which spoke for both; once that stopped claiming "gone forever"
               the key needed to say it for itself. -->
          <p class="notice notice-warning" data-test="wizard-authkey-once">{{ tf('shareAuthKeyOnce') }}</p>
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
        <!-- P2：完整地址即入口，「先注册账号再从下拉里挑」的前置被整个删除（决策卡标废弃）。
             textarea 收批量粘贴，tag 区回显解析结果 —— 请求里带的就是这些 tag，一字不多。 -->
        <div class="row">
          <label class="row-label" for="wizard-emails">{{ tf('shareWizardEmails') }}</label>
          <el-input
              id="wizard-emails"
              v-model="emailsInput"
              class="row-control"
              data-test="wizard-emails"
              type="textarea"
              :autosize="{minRows: 2, maxRows: 6}"
              :disabled="locked"
              :placeholder="tf('shareWizardEmailsPlaceholder')"
          />
          <p class="hint" data-test="wizard-emails-hint">{{ tf('shareWizardEmailsHint') }}</p>
          <div v-if="emailList.length" class="email-tags" data-test="email-tags">
            <el-tag v-for="email in emailList" :key="email" class="email-tag" data-test="email-tag">{{ email }}</el-tag>
          </div>
          <p v-if="emailList.length > 1" class="hint" data-test="emails-count">
            {{ tf('shareWizardEmailsCount', {count: emailList.length}) }}
          </p>
        </div>
        <p v-if="overEmailLimit" class="notice notice-danger" data-test="binding-limit" role="alert">
          {{ tf('shareWizardEmailsLimit') }}
        </p>

        <div class="row">
          <label class="row-label" for="wizard-duration">{{ tf('shareWizardDuration') }}</label>
          <el-select
              id="wizard-duration"
              v-model="durationModel"
              class="row-control"
              data-test="wizard-duration"
              :disabled="locked"
          >
            <el-option
                v-for="item in SHARE_DURATION_PRESETS"
                :key="item.value"
                :label="$t(item.labelKey)"
                :value="item.value"
            />
            <el-option
                :key="DURATION_CUSTOM"
                :label="tf('shareDurationCustom')"
                :value="DURATION_CUSTOM"
            />
          </el-select>
        </div>

        <div v-if="customDurationOpen" class="row row-custom-duration">
          <label class="row-label" for="wizard-duration-amount">{{ tf('shareDurationCustomAmount') }}</label>
          <div class="row-control custom-duration">
            <el-input-number
                id="wizard-duration-amount"
                v-model="customDurationAmount"
                data-test="wizard-duration-amount"
                :min="1"
                :step="1"
                :disabled="locked"
            />
            <el-select
                v-model="customDurationUnit"
                :aria-label="tf('shareDurationCustomUnit')"
                data-test="wizard-duration-unit"
                :disabled="locked"
            >
              <el-option
                  v-for="unit in DURATION_UNITS"
                  :key="unit.id"
                  :label="tf(unit.labelKey)"
                  :value="unit.id"
              />
            </el-select>
            <p class="hint" data-test="duration-ceiling">
              {{ tf('shareDurationTooLong', {days: MAX_DURATION_DAYS}) }}
            </p>
          </div>
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
                :precision="0"
                :step-strictly="true"
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
      <el-button data-test="wizard-close" :disabled="submitting" @click="onOpenChange(false)">{{ $t('cancel') }}</el-button>
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
          :disabled="submitting || overEmailLimit"
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
import {ElMessage} from "element-plus"
import {useCopyWithFallback} from "@/composables/useCopyWithFallback.js"
import {createMailShare, newIdempotencyKey} from "@/request/mail-share.js"
import {buildShareUrl} from "@/views/email/build-share-url.js"
import {
  DURATION_CUSTOM,
  DURATION_UNITS,
  MAX_DURATION_DAYS,
  SHARE_DURATION_PRESETS,
  SHARE_PRESETS,
  capabilityV2,
  createErrorKey,
  customDurationSeconds,
  durationError,
  findPreset,
  hasFenceIntent,
  markCapabilityInactive,
  parseShareEmails,
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
  shareWizardEmails: '要分享的邮箱地址',
  shareWizardEmailsPlaceholder: '输入完整邮箱地址；可一次粘贴多个，用空格、逗号、分号或换行分隔。',
  shareWizardEmailsHint: '不需要预先注册：还不存在的地址会在创建分享时自动开通。',
  shareWizardEmailsCount: '已识别 {count} 个地址。',
  shareWizardEmailsLimit: '一次最多提交 50 个地址。',
  shareEmailsRequired: '请输入至少一个完整邮箱地址。',
  shareEmailInvalid: '不是完整的邮箱地址：{email}',
  shareWizardBatchCreated: '已创建 {count} 条分享链接，请分别复制发放。日后也可以在分享详情里重新查看。',
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
  shareQuotaUnlimited: '不限'
}

function tf(key, params) {
  return te(key) ? t(key, params || {}) : (PENDING_COPY[key] || key)
}

// Mirrors of backend constants the browser has to enforce before the request leaves:
// SHARE_BINDING_LIMIT (P2 applies it to emails.length on both batch paths) and
// MIN_REFRESH_INTERVAL_MS.
const EMAIL_LIMIT = 50
const MIN_REFRESH_INTERVAL_MS = 3000

const presetLabelId = 'share-wizard-preset-label'

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
// The free-form duration lives beside the rungs rather than replacing them: the presets cover
// the frequent cases, and only the owner who needs 30 days pays the extra two fields.
const customDurationOpen = ref(false)
const customDurationAmount = ref(30)
const customDurationUnit = ref('days')
// The raw pasted text is the source of truth; the request carries its parsed projection.
// Kept outside `form` so the key-rotation watcher below can treat it the same way.
const emailsInput = ref('')
const idempotencyKey = ref(newIdempotencyKey())

const form = reactive({
  presetId: SHARE_PRESETS[0].id,
  name: '',
  remark: '',
  ...presetFormValues(SHARE_PRESETS[0].id)
})

const locked = computed(() => unknownResult.value)
const gatedDisabled = computed(() => capabilityV2.value === 'inactive')
const emailList = computed(() => parseShareEmails(emailsInput.value).emails)
const overEmailLimit = computed(() => emailList.value.length > EMAIL_LIMIT)

// The select carries either a rung's seconds or the 'custom' sentinel, while durationSeconds
// stays the resolved number the request speaks. Keeping the sentinel out of the form is what
// stops it from reaching the body: normalizeCreateBody would drop a string silently, and the
// share would land with the backend's default instead of the duration on screen.
const durationModel = computed({
  get() {
    return customDurationOpen.value ? DURATION_CUSTOM : form.durationSeconds
  },
  set(value) {
    customDurationOpen.value = value === DURATION_CUSTOM
    form.durationSeconds = customDurationOpen.value
        ? customDurationSeconds(customDurationAmount.value, customDurationUnit.value)
        : value
  }
})

watch([customDurationAmount, customDurationUnit], ([amount, unit]) => {
  if (!customDurationOpen.value) {
    return
  }
  form.durationSeconds = customDurationSeconds(amount, unit)
})

// One resolver for the single pane and the batch pane: revealSec later returns the very same
// string, so both panes must derive it the same way or one of them hands out a broken link.
function shareItemUrl(item) {
  if (!item) {
    return ''
  }
  if (item.shareUrl) {
    return item.shareUrl
  }
  if (item.lid && item.sec && typeof window !== 'undefined') {
    return buildShareUrl(window.location.origin, item.lid, item.sec)
  }
  return ''
}

const createdShareUrl = computed(() => shareItemUrl(created.value))

const createdAuthKey = computed(() => (created.value && created.value.authKey) || '')

// P2 批量分流:V2=false 的多地址响应形状是 { shares: [...] }(向导按响应形状渲染,
// 不猜 V2);单地址与 V2=true 的 multi 仍是单对象,走原来的单链接面板。
const createdShares = computed(() => {
  const data = created.value
  return data && Array.isArray(data.shares) ? data.shares : []
})

const replayWithoutSecret = computed(() => {
  const data = created.value
  return Boolean(data && data.idempotentReplay && !data.sec && !data.shareUrl)
})

const replayShares = computed(() => {
  const data = created.value
  if (!data) {
    return []
  }
  return Array.isArray(data.shares) ? data.shares : [data]
})

function rotateIdempotencyKey() {
  idempotencyKey.value = newIdempotencyKey()
}

// Presets are prefill only (AC-CAP-12), and since P2 that includes the address list: every
// preset accepts a pasted batch, because V2=false serves it as N single shares anyway.
function applyPreset(presetId) {
  const preset = findPreset(presetId)
  Object.assign(form, preset.form)
  form.presetId = presetId
  // preset.form carries a rung, so leaving custom mode open would show 'custom' over a
  // durationSeconds the two custom fields no longer describe.
  customDurationOpen.value = false
  advancedNames.value = preset.advancedOpen ? ['advanced'] : []
  formError.value = ''
}

function openDialog() {
  visible.value = true
  if (unknownResult.value) {
    return
  }
  created.value = null
  formError.value = ''
  form.name = ''
  form.remark = ''
  emailsInput.value = ''
  applyPreset(form.presetId)
  rotateIdempotencyKey()
}

function closeNow() {
  visible.value = false
  created.value = null
  formError.value = ''
}

function onOpenChange(value) {
  if (value) {
    return
  }
  // A close here would hide the only place the new link can appear. The worker will not mint
  // shareUrl/authKey again, so a pending create must finish on this dialog.
  if (submitting.value) {
    return
  }
  // No second "shown only once" confirm on close: the link is retrievable from the detail
  // drawer (ADR-share-credential-recoverability), and the auth key already carries its own
  // one-shot warning inside the result pane.
  // unknownResult 必须保留：AC-CAP-14 禁止关窗后换 Idempotency-Key 盲建。
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
// SHARE_INVALID_CONFIG names the offending write no more precisely than "not accepted", so a
// range error that reaches the server comes back as one generic line instead of the field to
// fix — and SHARE_EMAIL_INVALID cannot say which of 20 pasted addresses it meant.
function localError(parsed) {
  if (parsed.invalid) {
    return 'shareEmailInvalid'
  }
  if (parsed.emails.length === 0) {
    return 'shareEmailsRequired'
  }
  if (parsed.emails.length > EMAIL_LIMIT) {
    return 'shareWizardEmailsLimit'
  }
  const duration = durationError(form.durationSeconds)
  if (duration) {
    return duration
  }
  if (form.refreshIntervalMs != null && form.refreshIntervalMs !== '') {
    const interval = Number(form.refreshIntervalMs)
    // assertCreateBody rejects any non-safe-integer before the V2 fence, so 3000.5 never reaches
    // the fence at all — it comes back as SHARE_INVALID_CONFIG with no hint of which field.
    if (!Number.isSafeInteger(interval) || interval < MIN_REFRESH_INTERVAL_MS) {
      return 'shareRefreshIntervalTooSmall'
    }
  }
  if (!isCount(form.maxSessions) || !isCount(form.messageLimit)) {
    return 'shareWizardCountTooSmall'
  }
  return ''
}

// Explicit defaults are safe: the fingerprint is taken after normalizeCreateBody, where a
// missing key and its default collapse to the same value. Absent keys are the ones the owner
// left blank, which is not the same statement as "set this to zero".
// P2: the wizard speaks full addresses only — no accountIds key at all, so the deprecated
// pick-a-registered-account path cannot leak back in as a dead field.
function buildBody(emails) {
  const body = {
    emails: [...emails],
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

// The address list survives the degrade untouched: V2=false still serves a multi-address
// batch as N single shares (DC-P0-1), so the fence has no claim on the emails.
function degradeToInactive() {
  markCapabilityInactive()
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
  const parsed = parseShareEmails(emailsInput.value)
  const invalid = localError(parsed)
  if (invalid) {
    formError.value = tf(invalid, {days: MAX_DURATION_DAYS, email: parsed.invalid})
    return
  }
  created.value = null
  const body = buildBody(parsed.emails)
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
      // 栅栏现在有自己的码,不必再从 SHARE_INVALID_CONFIG 里猜:那个码同时承载「取值越域」,
      // 拿它灰掉四组会把一个写错的值说成「平台没开这项能力」。`fenceIntent` 保留为一致性
      // 校验 —— 它镜像的正是后端 create 侧门控的那四项写入。
      if (fenceIntent && err.message === 'SHARE_CAPABILITY_NOT_ENABLED') {
        degradeToInactive()
      }
      // Every business rejection needs to reach the screen. Without this the owner sees the
      // button settle and nothing else -- indistinguishable from a no-op. Reachable in normal
      // use since custom durations landed: MAX_DURATION_SECONDS is a mirror of the backend
      // default, so a deployment with a lower ceiling refuses a duration the browser allowed.
      formError.value = tf(createErrorKey(err))
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

// Batch pane: same composable instance as the single link, so the manual fallback keeps its
// one selectableRef; with several inputs on screen it falls back to the injected host instead.
async function copyItemLink(item) {
  const result = await copyUrl(shareItemUrl(item))
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
// emailsInput lives outside `form`, so it needs its own watcher — an edited address list is a
// different fingerprint just like an edited name.
watch(form, () => {
  if (!unknownResult.value) {
    rotateIdempotencyKey()
  }
})

watch(emailsInput, () => {
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

.email-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.email-tag {
  max-width: 100%;

  :deep(.el-tag__content) {
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.custom-duration {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;

  .el-input-number {
    flex: 1 1 120px;
    min-width: 0;
  }

  .el-select {
    flex: 0 1 120px;
  }

  .hint {
    flex-basis: 100%;
    margin-top: 0;
  }
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
