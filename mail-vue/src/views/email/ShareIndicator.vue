<template>
  <button
      v-if="canManage"
      type="button"
      class="share-indicator"
      data-test="share-indicator"
      :title="listError ? t('shareListError') : t('shareManage')"
      @click="emit('open')"
  >
    <span>{{ t('shareManage') }}</span>
    <span class="share-indicator-count" data-test="share-active-count">{{ activeCount }}</span>
  </button>
</template>
<script setup>
import { computed, onActivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { hasPerm } from '@/perm/perm.js'
import { useUserStore } from '@/store/user.js'
import { listMailShares } from '@/request/mail-share.js'
import { liveEffectiveStatus } from '@/views/share-admin/status.js'
import { useShareClock } from '@/views/share-admin/use-share-clock.js'

function canManageShare() {
  const keys = useUserStore().user && useUserStore().user.permKeys
  if (!Array.isArray(keys)) {
    return false
  }
  return hasPerm('share:manage')
}

const props = defineProps({
  accountId: { type: Number, default: 0 }
})
const emit = defineEmits(['open'])
const { t } = useI18n()
const shares = ref([])
const listError = ref(false)
const { nowMs } = useShareClock()
const canManage = computed(() => canManageShare())
const activeCount = computed(() => {
  const id = Number(props.accountId)
  return shares.value.filter((row) => {
    return Number(row.accountId) === id && liveEffectiveStatus(row, nowMs.value) === 'ACTIVE'
  }).length
})

function onVisible() {
  if (typeof document === 'undefined' || document.visibilityState === 'visible') {
    refresh()
  }
}

async function refresh() {
  if (!canManageShare()) {
    return
  }
  listError.value = false
  try {
    const data = await listMailShares()
    shares.value = Array.isArray(data && data.list) ? data.list : []
  } catch (err) {
    listError.value = true
    console.error('mail share indicator list failed', { code: err && err.code })
  }
}

defineExpose({ refresh, activeCount })

onMounted(() => {
  refresh()
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', refresh)
})

onActivated(() => {
  refresh()
})

onUnmounted(() => {
  document.removeEventListener('visibilitychange', onVisible)
  window.removeEventListener('focus', refresh)
})

watch(() => props.accountId, () => {
  refresh()
})
</script>
<style scoped>
.share-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 8px;
  padding: 0 8px;
  height: 24px;
  border: none;
  border-radius: 12px;
  background: #f4f4f5;
  color: #606266;
  font-size: 13px;
  cursor: pointer;
}

.share-indicator-count {
  min-width: 16px;
  color: #409eff;
  font-weight: 600;
}
</style>
