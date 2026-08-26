<template>
  <div class="row-actions">
    <el-button text size="small" data-test="row-open-detail" @click="emit('open')">
      {{ tf('shareDetail') }}
    </el-button>
    <el-button
        v-if="canRevoke"
        text
        size="small"
        type="warning"
        data-test="row-revoke"
        :disabled="busy"
        @click="askRevoke"
    >
      {{ $t('shareRevoke') }}
    </el-button>
    <el-button
        text
        size="small"
        type="danger"
        class="row-action-danger"
        data-test="row-delete"
        :disabled="busy"
        @click="askDelete"
    >
      {{ $t('delete') }}
    </el-button>
  </div>
</template>

<script setup>
import {computed, ref} from "vue"
import {useI18n} from "vue-i18n"
import {ElMessage, ElMessageBox} from "element-plus"
import {deleteMailShare, revokeMailShare} from "@/request/mail-share.js"
import {useShareClock} from "./use-share-clock.js"

const props = defineProps({
  row: {type: Object, required: true}
})
const emit = defineEmits(['open', 'changed'])

const {t, te} = useI18n()

// T-28/T-29 are the only writers of i18n/zh.js and i18n/en.js. Until they land the keys
// registered in exec-t21-note.md, fall back to the agreed copy instead of painting a raw key
// name on screen; te() flips to the real translation the moment they exist.
const PENDING_COPY = {
  shareDetail: '详情',
  shareDeleteConfirm: '彻底删除这个分享及其全部记录？此操作不可恢复，且与「销毁」不同——删除后列表里也不再保留审计记录。',
  shareDeleteSuccess: '已删除'
}

function tf(key) {
  return te(key) ? t(key) : (PENDING_COPY[key] || key)
}

const busy = ref(false)

// P1: read the live status, not the API snapshot the parent happened to fetch.
const {liveStatus} = useShareClock()

// revoke flips status to REVOKED and the backend predicate is `status = 'ACTIVE'`, so an
// already destroyed share has nothing left to destroy (EXPIRED stays revocable: persistence
// is still ACTIVE). delete carries no status predicate at all, which is why it stays on
// every row.
const canRevoke = computed(() => props.row && liveStatus(props.row) !== 'REVOKED')

function isDismissal(err) {
  return err === 'cancel' || err === 'close'
}

async function run(action, successKey) {
  busy.value = true
  try {
    await action(props.row.shareId)
    ElMessage({message: tf(successKey), type: 'success', plain: true})
    emit('changed')
  } catch (err) {
    console.error('mail share row action failed', {shareId: props.row.shareId, code: err && err.code})
  } finally {
    busy.value = false
  }
}

function ask(message, onConfirm) {
  ElMessageBox.confirm(message, {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(onConfirm).catch((err) => {
    if (isDismissal(err)) {
      return
    }
    console.error('mail share row action confirm failed', {shareId: props.row.shareId, err})
  })
}

function askRevoke() {
  ask(t('shareRevokeConfirm'), () => run(revokeMailShare, 'shareRevokeSuccess'))
}

function askDelete() {
  ask(tf('shareDeleteConfirm'), () => run(deleteMailShare, 'shareDeleteSuccess'))
}
</script>

<style lang="scss" scoped>
// The actions get their own line under the fields rather than a slot in .card-head: three
// buttons next to the two tags squeeze the share name down to an ellipsis on a 320px card.
.row-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--light-border);
}

// destructive-emphasis: delete leaves nothing behind, so it is pushed away from the two
// recoverable actions instead of sitting flush against them.
.row-action-danger {
  margin-left: 6px;
}

@media (max-width: 767px) {
  .row-actions {
    gap: 4px;
  }

  // 44px touch targets on the phone breakpoint; el-button's small size is 24px.
  .row-actions :deep(.el-button) {
    min-height: 44px;
    padding: 0 8px;
  }
}
</style>
