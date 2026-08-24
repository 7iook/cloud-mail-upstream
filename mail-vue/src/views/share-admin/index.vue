<template>
  <div class="share-admin">
    <div class="header-actions">
      <el-select
          v-model="status"
          class="status-filter"
          data-test="status-filter"
          :placeholder="tf('shareFilterStatus')"
          @change="onStatusChange"
      >
        <el-option :label="tf('shareFilterAll')" value=""/>
        <el-option v-for="item in statusOptions" :key="item" :label="statusText(item)" :value="item"/>
      </el-select>
      <button class="icon-button" type="button" :aria-label="tf('shareRefresh')" :title="tf('shareRefresh')"
              @click="refresh">
        <Icon icon="ion:reload" width="18" height="18"/>
      </button>
    </div>

    <el-scrollbar class="scrollbar">
      <div class="loading" :class="listLoading ? 'loading-show' : 'loading-hide'"
           :style="firstLoad ? 'background: transparent' : ''">
        <loading/>
      </div>

      <div v-if="forbidden" class="panel" data-test="share-admin-forbidden">
        <Icon class="panel-icon" icon="fluent:shield-prohibited-20-regular" width="34" height="34"/>
        <p class="panel-text">{{ tf('shareAdminForbidden') }}</p>
      </div>

      <div v-else-if="errored" class="panel" data-test="share-admin-error">
        <Icon class="panel-icon" icon="fluent:plug-disconnected-20-regular" width="34" height="34"/>
        <p class="panel-text">{{ $t('shareListError') }}</p>
      </div>

      <div v-else-if="!listLoading && rows.length === 0" class="empty" data-test="share-admin-empty">
        <el-empty :image-size="isMobile ? 120 : null" :description="$t('shareEmpty')"/>
      </div>

      <div v-else class="share-cards">
        <article
            v-for="row in rows"
            :key="row.shareId"
            class="share-card"
            data-test="share-row"
            :data-share-id="row.shareId"
            :data-status="row.effectiveStatus"
        >
          <div class="card-head">
            <span class="card-name" data-test="share-name">{{ row.name || row.mailbox || row.shareId }}</span>
            <div class="card-tags">
              <el-tag type="info" data-test="share-type">{{ tf(shareTypeLabelKey(row.shareType)) }}</el-tag>
              <el-tag :type="statusMeta(row.effectiveStatus).tone" data-test="share-status">
                {{ statusText(row.effectiveStatus) }}
              </el-tag>
            </div>
          </div>

          <dl class="card-fields">
            <div class="field">
              <dt class="field-label">{{ tf('shareBoundMailboxes') }}</dt>
              <dd class="field-value field-wrap" data-test="share-bindings">{{ bindingSummary(row) }}</dd>
            </div>
            <div class="field">
              <dt class="field-label">{{ tf('shareSessionQuota') }}</dt>
              <dd class="field-value field-quota" data-test="share-quota">
                {{ quotaText(row, tf('shareQuotaUnlimited')) }}
              </dd>
            </div>
            <div class="field">
              <dt class="field-label">{{ $t('shareExpiresAt') }}</dt>
              <dd class="field-value" data-test="share-expires">{{ row.expiresAt || '-' }}</dd>
            </div>
            <div class="field">
              <dt class="field-label">{{ $t('shareLastAccess') }}</dt>
              <dd class="field-value" data-test="share-last-access">{{ row.lastAccessAt || '-' }}</dd>
            </div>
          </dl>
        </article>
      </div>
    </el-scrollbar>

    <div v-if="total > size" class="pager">
      <el-pagination
          layout="prev, pager, next"
          :current-page="page"
          :page-size="size"
          :total="total"
          @current-change="onPageChange"
      />
    </div>
  </div>
</template>

<script setup>
import {ref} from "vue"
import {Icon} from "@iconify/vue"
import {useI18n} from "vue-i18n"
import loading from "@/components/loading/index.vue"
import {isShareForbidden, listMailShares} from "@/request/mail-share.js"
import {SHARE_STATUSES, bindingSummary, quotaText, shareTypeLabelKey, statusMeta} from "./status.js"

defineOptions({
  name: 'share-admin'
})

const {t, te} = useI18n()

// T-28/T-29 are the only writers of i18n/zh.js and i18n/en.js. Until they land these nine
// keys (registered in exec-t20-note.md), fall back to the agreed copy instead of painting a
// raw key name on screen; te() flips to the real translation the moment they exist.
const PENDING_COPY = {
  shareStatusLimitReached: '已达访问上限',
  shareTypeSingle: '单邮箱',
  shareTypeMulti: '多邮箱',
  shareBoundMailboxes: '绑定邮箱',
  shareSessionQuota: '会话用量',
  shareQuotaUnlimited: '不限',
  shareFilterStatus: '状态',
  shareFilterAll: '全部',
  shareAdminForbidden: '你没有分享管理权限，请联系管理员。',
  shareRefresh: '刷新'
}

function tf(key) {
  return te(key) ? t(key) : (PENDING_COPY[key] || key)
}

const statusOptions = SHARE_STATUSES
const size = 20
const isMobile = window.innerWidth < 1025

const status = ref('')
const page = ref(1)
const total = ref(0)
const rows = ref([])
const listLoading = ref(true)
const firstLoad = ref(true)
const forbidden = ref(false)
const errored = ref(false)

// Only the newest request may write the list: switching the filter twice in a row must not
// let the slower first response overwrite the second.
let reqSeq = 0

function statusText(value) {
  const {labelKey} = statusMeta(value)
  return labelKey ? tf(labelKey) : value
}

async function fetchList() {
  const seq = ++reqSeq
  listLoading.value = true
  const query = {page: page.value, size}
  if (status.value) {
    query.status = status.value
  }
  try {
    const data = await listMailShares(query)
    if (seq !== reqSeq) {
      return
    }
    forbidden.value = false
    errored.value = false
    rows.value = Array.isArray(data && data.list) ? data.list : []
    total.value = Number(data && data.total) || 0
  } catch (err) {
    if (seq !== reqSeq) {
      return
    }
    rows.value = []
    total.value = 0
    // A body-403 means the perm was revoked mid-session; it is not a 401 and must not bounce
    // the owner to /login.
    forbidden.value = isShareForbidden(err)
    errored.value = !forbidden.value
    console.error('mail share list failed', {code: err && err.code})
  } finally {
    if (seq === reqSeq) {
      listLoading.value = false
      firstLoad.value = false
    }
  }
}

function onStatusChange() {
  page.value = 1
  fetchList()
}

function onPageChange(next) {
  page.value = next
  fetchList()
}

function refresh() {
  fetchList()
}

fetchList()
</script>

<style lang="scss" scoped>
.share-admin {
  height: 100%;
}

.header-actions {
  padding: 9px 15px;
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  align-items: center;
  box-shadow: var(--header-actions-border);
  font-size: 18px;
  @media (max-width: 767px) {
    gap: 15px;
  }

  .status-filter {
    width: min(200px, calc(100vw - 120px));
  }

  // A plain <button> keeps the reload reachable by keyboard while looking like the bare
  // header icons used across the other management pages.
  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    cursor: pointer;
  }
}

.scrollbar {
  height: calc(100% - 48px);
  position: relative;
  background: var(--extra-light-fill);
}

.share-cards {
  padding: 15px 15px 25px 15px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 15px;
  @media (max-width: 767px) {
    grid-template-columns: 1fr;
    padding: 12px 12px 20px 12px;
    gap: 12px;
  }
}

.share-card {
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  padding: 15px;
  transition: all 200ms;

  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--light-border);
  }

  .card-tags {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .card-name {
    font-size: 16px;
    font-weight: bold;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .card-fields {
    margin: 0;
    padding-top: 10px;
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
      width: 84px;
      color: var(--secondary-text-color);
    }

    .field-value {
      margin: 0;
      min-width: 0;
      color: var(--regular-text-color);
    }

    .field-wrap {
      word-break: break-all;
    }

    .field-quota {
      font-variant-numeric: tabular-nums;
    }

    @media (max-width: 767px) {
      .field {
        flex-direction: column;
        gap: 2px;
      }

      .field-label {
        width: auto;
      }
    }
  }
}

.panel,
.empty {
  height: 100%;
  min-height: 220px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 20px;
}

.panel-icon {
  color: var(--secondary-text-color);
}

.panel-text {
  margin: 0;
  max-width: 420px;
  text-align: center;
  line-height: 1.6;
  color: var(--regular-text-color);
}

.pager {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 48px;
  box-shadow: inset 0 1px 0 0 var(--el-border-color-lighter);
}

.loading {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  background: var(--loadding-background);
  z-index: 2;
}

.loading-show {
  transition: all 200ms ease 200ms;
  opacity: 1;
}

.loading-hide {
  pointer-events: none;
  transition: var(--loading-hide-transition);
  opacity: 0;
}
</style>
