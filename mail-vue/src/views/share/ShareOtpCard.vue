<template>
  <section
    v-if="enabled && featuredMail"
    class="share-otp"
    data-share-code
  >
    <p class="share-otp-label">{{ tx('shareVisitCode', 'Verification code') }}</p>
    <div class="share-otp-row">
      <strong class="share-otp-value">{{ featuredMail.code }}</strong>
      <button
        type="button"
        data-share-copy
        @click="copyFeaturedCode"
      >
        {{ tx('shareVisitCopy', 'Copy') }}
      </button>
    </div>
    <p data-share-code-from>{{ tx('shareVisitFrom', 'From') }} {{ senderLine(featuredMail) }}</p>
    <input
      class="share-otp-select"
      :class="{ 'is-visible': copyResult === 'manual' }"
      :ref="bindSelectable"
      readonly
      :value="featuredMail.code"
      :aria-label="tx('shareVisitCode', 'Verification code')"
    >
    <p
      v-if="copyResult"
      :data-share-copy-result="copyResult"
    >{{ copyResult === 'copied' ? tx('shareVisitCopied', 'Copied') : tx('shareVisitCopyManual', 'Select the code and copy it yourself') }}</p>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useCopyWithFallback } from '@/composables/useCopyWithFallback.js'
import { senderLine } from './mail-fields.js'

defineOptions({
    name: 'ShareOtpCard'
})

const props = defineProps({
    mails: {
        type: Array,
        default: () => []
    },
    selected: {
        type: Object,
        default: null
    },
    enabled: {
        type: Boolean,
        default: true
    }
})

const { t, te } = useI18n()
const { copy, selectableRef } = useCopyWithFallback()

const copyResult = ref('')

function tx(key, fallback) {
    return te(key) ? t(key) : fallback
}

function hasShareCode(code) {
    return code != null && String(code) !== ''
}

const featuredMail = computed(() => {
    const selected = props.selected
    if (selected && hasShareCode(selected.code)) {
        return selected
    }
    for (let i = props.mails.length - 1; i >= 0; i--) {
        if (hasShareCode(props.mails[i].code)) {
            return props.mails[i]
        }
    }
    return null
})

function bindSelectable(el) {
    selectableRef.value = el
}

async function copyFeaturedCode() {
    if (!featuredMail.value) {
        return
    }
    const result = await copy(featuredMail.value.code)
    copyResult.value = result.copied ? 'copied' : 'manual'
    if (result.copied && typeof ElMessage === 'function') {
        ElMessage({
            message: tx('shareVisitCopied', 'Copied'),
            type: 'success'
        })
    }
}
</script>

<style scoped>
.share-otp {
    position: relative;
    margin: 24px 0;
    padding: 16px;
    border: 1px solid #d0d7de;
    border-radius: 8px;
    background: #f6f8fa;
}

.share-otp-label {
    margin: 0 0 8px;
    font-size: 13px;
    color: #4b5563;
}

.share-otp-row {
    display: flex;
    align-items: center;
    gap: 12px;
}

.share-otp-row button {
    font: inherit;
    cursor: pointer;
}

.share-otp-value {
    font-size: 32px;
    letter-spacing: 0.12em;
    font-variant-numeric: tabular-nums;
}

.share-otp-select {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    border: 0;
}

.share-otp-select.is-visible {
    position: static;
    width: 100%;
    height: auto;
    margin: 8px 0 0;
    padding: 8px;
    clip: auto;
    overflow: visible;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    font: inherit;
    letter-spacing: 0.12em;
}
</style>
