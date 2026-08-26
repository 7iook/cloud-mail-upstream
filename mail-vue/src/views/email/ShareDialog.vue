<template>
  <el-dialog
      :model-value="modelValue"
      :title="t('shareDialogTitle')"
      width="680px"
      @update:model-value="onOpenChange"
  >
    <p class="share-warning" data-test="create-warning">{{ t('shareCreateWarning') }}</p>
    <div class="share-form">
      <el-input v-model="form.name" :placeholder="t('shareNamePlaceholder')" maxlength="64"/>
      <el-input v-model="form.remark" :placeholder="t('shareRemarkPlaceholder')" maxlength="200"/>
      <el-select v-model="durationModel" data-test="duration-select">
        <el-option
            v-for="item in SHARE_DURATION_PRESETS"
            :key="item.value"
            :label="t(item.labelKey)"
            :value="item.value"
        />
        <el-option
            :key="DURATION_CUSTOM"
            :label="t('shareDurationCustom')"
            :value="DURATION_CUSTOM"
        />
      </el-select>
      <div v-if="customDurationOpen" class="custom-duration">
        <el-input-number
            v-model="customDurationAmount"
            data-test="duration-amount"
            :min="1"
            :step="1"
            :aria-label="t('shareDurationCustomAmount')"
        />
        <el-select
            v-model="customDurationUnit"
            data-test="duration-unit"
            :aria-label="t('shareDurationCustomUnit')"
        >
          <el-option
              v-for="unit in DURATION_UNITS"
              :key="unit.id"
              :label="t(unit.labelKey)"
              :value="unit.id"
          />
        </el-select>
        <p class="custom-duration-hint" data-test="duration-ceiling">
          {{ t('shareDurationTooLong', { days: MAX_DURATION_DAYS }) }}
        </p>
      </div>
      <el-button type="primary" data-test="create-share" :disabled="creating" @click="submitCreate">
        {{ t('shareCreate') }}
      </el-button>
    </div>

    <div v-if="created" class="share-created">
      <p data-test="secret-once">{{ t('shareSecretOnce') }}</p>
      <p v-if="replayWithoutSecret" data-test="share-replay">{{ t('shareReplayNoSecret') }}</p>
      <div v-if="createdShareUrl" class="share-url-row">
        <input
            ref="selectableRef"
            data-test="share-url"
            class="share-url-input"
            type="text"
            readonly
            :value="createdShareUrl"
        />
        <el-button data-test="copy-share-url" @click="copyCreatedLink">{{ t('shareCopyLink') }}</el-button>
      </div>
    </div>

    <p v-if="listError" class="share-list-error">{{ t('shareListError') }}</p>
    <div v-else-if="shares.length === 0" class="share-empty">{{ t('shareEmpty') }}</div>
    <div v-else class="share-list">
      <div
          v-for="row in shares"
          :key="row.shareId"
          class="share-row"
          data-test="share-row"
          :data-status="liveStatus(row)"
      >
        <div class="share-row-main">
          <div class="share-row-title">{{ row.name || row.mailbox || row.shareId }}</div>
          <div class="share-row-meta">
            <span>{{ t('shareMailbox') }}: {{ row.mailbox }}</span>
            <span data-test="share-status">{{ statusLabel(liveStatus(row)) }}</span>
            <span>{{ t('shareCreatedAt') }}: {{ tzText(row.createTime) }}</span>
            <span>{{ t('shareExpiresAt') }}: {{ tzText(row.expiresAt) }}</span>
          </div>
          <div class="share-row-access">
            <span data-test="access-label">{{ t('shareAccessCount') }}</span>
            <span>{{ row.accessCount }}</span>
            <span>{{ t('shareLastAccess') }}: {{ tzText(row.lastAccessAt) }}</span>
            <span class="share-access-hint">{{ t('shareAccessHint') }}</span>
          </div>
        </div>
        <el-button
            v-if="liveStatus(row) !== 'REVOKED'"
            data-test="revoke-share"
            @click="askRevoke(row)"
        >
          {{ t('shareRevoke') }}
        </el-button>
      </div>
    </div>

    <template #footer>
      <el-button v-if="canManage" data-test="goto-share-admin" @click="goShareAdmin">
        {{ tf('shareGoAdmin') }}
      </el-button>
    </template>
  </el-dialog>
</template>
<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import router from '@/router/index.js'
import { hasPerm } from '@/perm/perm.js'
import { useUserStore } from '@/store/user.js'
import { useCopyWithFallback } from '@/composables/useCopyWithFallback.js'
import { createMailShare, listMailShares, newIdempotencyKey, revokeMailShare } from '@/request/mail-share.js'
import { tzText } from '@/utils/day.js'
import { buildShareUrl } from './build-share-url.js'
// One definition, two entries. This dialog and the share-admin wizard create the same thing,
// and while each held its own literal rung list the 7-day cap could be raised in one and left
// standing in the other (P-03).
import {
  DURATION_CUSTOM,
  DURATION_UNITS,
  MAX_DURATION_DAYS,
  SHARE_DURATION_PRESETS,
  createErrorKey,
  customDurationSeconds,
  durationError
} from '@/views/share-admin/presets.js'
import { useShareClock } from '@/views/share-admin/use-share-clock.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  accountId: { type: Number, default: 0 }
})
const emit = defineEmits(['update:modelValue', 'changed'])
const { t, te } = useI18n()
const { copy, selectableRef } = useCopyWithFallback()
const { liveStatus } = useShareClock()

// T-29 is the only writer of i18n/zh.js and i18n/en.js. Until it lands shareGoAdmin
// (registered in exec-t23-note.md), fall back to the agreed copy instead of painting a raw
// key name on screen; te() flips to the real translation the moment the key exists.
const PENDING_COPY = {
  shareGoAdmin: '前往分享管理'
}

function tf(key) {
  return te(key) ? t(key) : (PENDING_COPY[key] || key)
}

// hasPerm() calls permKeys.includes() unguarded, and share-admin is only addRoute()d for
// share:manage holders; same shape as ShareIndicator.vue so neither can drift alone.
function canManageShare() {
  const keys = useUserStore().user && useUserStore().user.permKeys
  if (!Array.isArray(keys)) {
    return false
  }
  return hasPerm('share:manage')
}

const canManage = computed(() => canManageShare())
const form = reactive({
  name: '',
  remark: '',
  durationSeconds: 3600
})
const customDurationOpen = ref(false)
const customDurationAmount = ref(30)
const customDurationUnit = ref('days')

// The select holds either a rung or the 'custom' sentinel; durationSeconds stays the resolved
// number the request speaks, so the sentinel can never reach the body.
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
const idempotencyKey = ref(newIdempotencyKey())
const creating = ref(false)
const created = ref(null)
const shares = ref([])
const listError = ref(false)

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

const replayWithoutSecret = computed(() => {
  const data = created.value
  return Boolean(data && data.idempotentReplay && !data.sec && !data.shareUrl)
})

function statusLabel(status) {
  const keys = {
    ACTIVE: 'shareStatusActive',
    EXPIRED: 'shareStatusExpired',
    REVOKED: 'shareStatusRevoked'
  }
  return keys[status] ? t(keys[status]) : status
}

function rotateIdempotencyKey() {
  idempotencyKey.value = newIdempotencyKey()
}

async function loadList() {
  listError.value = false
  try {
    const data = await listMailShares()
    shares.value = Array.isArray(data && data.list) ? data.list : []
  } catch (err) {
    listError.value = true
    console.error('mail share list failed', { code: err && err.code })
  }
}

function onOpenChange(value) {
  emit('update:modelValue', value)
  if (value) {
    loadList()
    return
  }
  created.value = null
}

async function submitCreate() {
  if (!props.accountId) {
    ElMessage({ message: t('shareAccountRequired'), type: 'warning', plain: true })
    return
  }
  const durationInvalid = durationError(form.durationSeconds)
  if (durationInvalid) {
    ElMessage({
      message: t(durationInvalid, { days: MAX_DURATION_DAYS }),
      type: 'warning',
      plain: true
    })
    return
  }
  creating.value = true
  try {
    const data = await createMailShare({
      accountId: props.accountId,
      durationSeconds: form.durationSeconds,
      name: form.name,
      remark: form.remark
    }, idempotencyKey.value)
    created.value = data || null
    emit('changed')
    await loadList()
    if (data && !data.idempotentReplay) {
      rotateIdempotencyKey()
    }
  } catch (err) {
    // Was console.error only, so a refused create was indistinguishable from a dead button.
    // Uses the same mapping as the wizard: the two entries are one feature and already drifted
    // apart once on the duration rungs.
    ElMessage({ message: t(createErrorKey(err)), type: 'error', plain: true })
    console.error('mail share create failed', { code: err && err.code })
  } finally {
    creating.value = false
  }
}

function askRevoke(row) {
  ElMessageBox.confirm(t('shareRevokeConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    return revokeMailShare(row.shareId)
  }).then(() => {
    ElMessage({ message: t('shareRevokeSuccess'), type: 'success', plain: true })
    emit('changed')
    return loadList()
  }).catch((err) => {
    if (err === 'cancel' || err === 'close') {
      return
    }
    console.error('mail share revoke failed', { shareId: row.shareId, code: err && err.code })
  })
}

function goShareAdmin() {
  // Close first: the open modal keeps body scroll locked and would flash for a frame while
  // the route swap unmounts this subtree.
  emit('update:modelValue', false)
  router.push({ name: 'share-admin' })
}

async function copyCreatedLink() {
  const result = await copy(createdShareUrl.value)
  if (result.copied) {
    ElMessage({ message: t('copySuccessMsg'), type: 'success', plain: true })
  }
}

watch(() => [form.name, form.remark, form.durationSeconds, props.accountId], () => {
  rotateIdempotencyKey()
})

watch(() => props.modelValue, (open) => {
  if (open) {
    loadList()
  }
}, { immediate: true })
</script>
<style scoped>
.share-warning {
  margin: 0 0 12px;
  color: #b88230;
  line-height: 1.5;
}

.share-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}

.custom-duration {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.custom-duration-hint {
  flex-basis: 100%;
  margin: 0;
  color: #909399;
  font-size: 12px;
  line-height: 1.6;
}

.share-created {
  margin-bottom: 16px;
  padding: 12px;
  background: #fdf6ec;
  border-radius: 6px;
}

.share-url-row {
  display: flex;
  gap: 8px;
}

.share-url-input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
}

.share-list-error,
.share-empty {
  color: #909399;
}

.share-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid #ebeef5;
}

.share-row-title {
  font-weight: 600;
}

.share-row-meta,
.share-row-access {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  color: #606266;
  font-size: 13px;
}

.share-access-hint {
  width: 100%;
  color: #909399;
}
</style>
