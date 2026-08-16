<template>
  <div class="safe-mail">
    <div class="safe-mail-bar">
      <div class="safe-mail-toggle">
        <el-button
          size="small"
          :type="mode === 'text' ? 'primary' : 'default'"
          :disabled="!canShowText"
          @click="mode = 'text'"
        >{{ labels.plainText }}</el-button>
        <el-button
          size="small"
          :type="mode === 'html' ? 'primary' : 'default'"
          :disabled="!canShowHtml"
          @click="mode = 'html'"
        >{{ labels.html }}</el-button>
        <button
          v-if="showIframe"
          type="button"
          class="safe-mail-expand"
          data-testid="safe-mail-expand"
          @click="toggleExpanded"
        >{{ expanded ? labels.collapse : labels.expand }}</button>
      </div>
      <el-alert
        v-if="view.notice === 'noPlainText'"
        class="safe-mail-notice"
        type="info"
        :closable="false"
        :title="labels.noPlainText"
        show-icon
      />
      <el-alert
        v-if="injectFailed"
        class="safe-mail-notice"
        type="warning"
        :closable="false"
        :title="labels.renderFailed"
        show-icon
      />
    </div>
    <pre v-if="showText" class="safe-mail-text">{{ text }}</pre>
    <iframe
      v-else-if="showIframe"
      class="safe-mail-frame"
      :style="{ height: frameHeight }"
      :sandbox="IFRAME_SANDBOX"
      :srcdoc="built.srcdoc"
      title="Email HTML"
      @error="onFrameError"
    />
    <div v-else class="safe-mail-empty">{{ labels.empty }}</div>
  </div>
</template>
<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  IFRAME_SANDBOX,
  DEFAULT_FRAME_HEIGHT,
  EXPANDED_FRAME_HEIGHT,
  hasMeaningfulText,
  hasMeaningfulHtml,
  resolveView,
  tryBuildSrcdoc,
  supportsSrcdoc
} from './srcdoc.js'

defineOptions({ name: 'SafeMailRenderer' })

const props = defineProps({
  text: { type: String, default: '' },
  html: { type: String, default: '' },
  content: { type: String, default: '' },
  height: { type: String, default: DEFAULT_FRAME_HEIGHT },
  defaultMode: {
    type: String,
    default: 'text',
    validator: (value) => value === 'text' || value === 'html'
  }
})

const { t, te, locale } = useI18n()
const mode = ref('text')
const expanded = ref(false)
const frameError = ref(false)
const srcdocSupported = ref(supportsSrcdoc())
const frameHeight = computed(() => (
  expanded.value ? EXPANDED_FRAME_HEIGHT : props.height
))

const COPY = {
  zh: {
    plainText: '纯文本',
    html: 'HTML',
    noPlainText: '该邮件无纯文本版本',
    renderFailed: '无法显示 HTML，已改为纯文本',
    empty: '没有可显示的正文',
    expand: '展开',
    collapse: '收起'
  },
  en: {
    plainText: 'Plain text',
    html: 'HTML',
    noPlainText: 'This message has no plain-text version',
    renderFailed: 'Unable to display HTML. Showing plain text instead.',
    empty: 'No message body',
    expand: 'Expand',
    collapse: 'Collapse'
  }
}

const I18N_KEYS = {
  plainText: 'safeMailPlainText',
  html: 'safeMailHtml',
  noPlainText: 'safeMailNoPlainText',
  renderFailed: 'safeMailRenderFailed',
  empty: 'safeMailEmpty',
  expand: 'safeMailExpand',
  collapse: 'safeMailCollapse'
}

const htmlSource = computed(() => {
  if (hasMeaningfulHtml(props.html)) return props.html
  return props.content || ''
})

const labels = computed(() => {
  const lang = locale.value === 'zh' ? 'zh' : 'en'
  const pack = COPY[lang]
  const out = {}
  for (const key of Object.keys(pack)) {
    const i18nKey = I18N_KEYS[key]
    out[key] = i18nKey && te(i18nKey) ? t(i18nKey) : pack[key]
  }
  return out
})

watch(
  () => [props.text, htmlSource.value, props.defaultMode],
  () => {
    frameError.value = false
    expanded.value = false
    mode.value = resolveView({
      text: props.text,
      html: htmlSource.value,
      preferredDefault: props.defaultMode
    }).defaultMode
  },
  { immediate: true }
)

const view = computed(() => resolveView({
  text: props.text,
  html: htmlSource.value,
  mode: mode.value
}))

const built = computed(() => {
  if (!hasMeaningfulHtml(htmlSource.value)) return { ok: true, srcdoc: '' }
  return tryBuildSrcdoc(htmlSource.value)
})

const injectFailed = computed(() => {
  if (!hasMeaningfulHtml(htmlSource.value)) return false
  return !built.value.ok || !srcdocSupported.value || frameError.value
})

const canShowText = computed(() => hasMeaningfulText(props.text))
const canShowHtml = computed(() => hasMeaningfulHtml(htmlSource.value))

const showIframe = computed(() => {
  return view.value.view === 'html'
    && built.value.ok
    && !!built.value.srcdoc
    && srcdocSupported.value
    && !frameError.value
})

const showText = computed(() => {
  if (showIframe.value) return false
  return canShowText.value
})

function toggleExpanded() {
  expanded.value = !expanded.value
}

function onFrameError() {
  console.error('[SafeMailRenderer] iframe failed to load')
  frameError.value = true
}
</script>

<style scoped>
.safe-mail {
  width: 100%;
  min-width: 0;
}

.safe-mail-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 8px;
}

.safe-mail-toggle {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.safe-mail-expand {
  margin: 0;
  padding: 5px 11px;
  border: 1px solid var(--el-border-color, #dcdfe6);
  border-radius: 4px;
  background: transparent;
  color: var(--el-text-color-regular, #606266);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.safe-mail-notice {
  width: fit-content;
  max-width: 100%;
}

.safe-mail-text {
  margin: 0;
  font-family: inherit;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--el-text-color-primary);
}

.safe-mail-frame {
  display: block;
  width: 100%;
  min-height: 560px;
  border: 1px solid var(--el-border-color, #dcdfe6);
  background: #fff;
  overflow: auto;
}

.safe-mail-empty {
  color: var(--el-text-color-secondary);
}
</style>
