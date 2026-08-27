<template>
  <section
    v-if="enabled && selected"
    class="share-otp"
    data-share-otp-card
  >
    <template v-if="code || linkHref">
      <div
        v-if="code"
        data-share-code
      >
        <p class="share-otp-label">{{ tx('shareVisitCode', 'Verification code') }}</p>
        <div class="share-otp-row">
          <strong class="share-otp-value">{{ code }}</strong>
          <button
            type="button"
            data-share-copy
            @click="copyCode"
          >
            {{ tx('shareVisitCopy', 'Copy') }}
          </button>
        </div>
        <input
          class="share-otp-select"
          :class="{ 'is-visible': copyResult === 'manual' }"
          :ref="bindSelectable"
          readonly
          :value="code"
          :aria-label="tx('shareVisitCode', 'Verification code')"
        >
        <!-- role=status, because this line is the whole confirmation: a visitor on a screen
             reader would otherwise press Copy and hear nothing at all. Keyed by attempt so
             copying twice is heard twice — aria-live only speaks when the region changes,
             and the second confirmation carries the same sentence as the first. -->
        <p
          v-if="copyResult"
          :key="copyAttempt"
          :data-share-copy-result="copyResult"
          :data-share-copy-attempt="copyAttempt"
          role="status"
        >{{ copyResult === 'copied' ? tx('shareVisitCopied', 'Copied') : tx('shareVisitCopyManual', 'Select the code and copy it yourself') }}</p>
      </div>

      <!-- The whole URL is the link text on purpose: hiding it behind a button would turn
           "found in this mail" into an endorsement the page cannot make, since the body it
           came from is written by whoever sent the mail. -->
      <div
        v-if="linkHref"
        class="share-otp-link"
        data-share-link
      >
        <p class="share-otp-label">{{ tx('shareVisitLink', 'Verification link') }}</p>
        <a
          class="share-otp-url"
          data-share-link-url
          :href="linkHref"
          target="_blank"
          rel="noopener noreferrer"
          :aria-label="`${tx('shareVisitLinkOpen', 'Open')} ${linkHref}`"
        >{{ linkHref }}</a>
      </div>

      <p data-share-code-from>{{ tx('shareVisitFrom', 'From') }} {{ senderLine(selected) }}</p>
    </template>

    <p
      v-else
      class="share-otp-empty"
      data-share-nothing-found
    >{{ tx('shareVisitNothingFound', 'No verification code or link found') }}</p>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useCopyWithFallback } from '@/composables/useCopyWithFallback.js'
import { senderLine } from './mail-fields.js'

defineOptions({
    name: 'ShareOtpCard'
})

const props = defineProps({
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
const copyAttempt = ref(0)

function tx(key, fallback) {
    return te(key) ? t(key) : fallback
}

// Only ever the mail in front of the visitor. Scanning the rest of the list for a code to
// show would put another mail's code under this mail's sender line.
const code = computed(() => {
    const value = props.selected && props.selected.code
    return value == null ? '' : String(value)
})

// The body is attacker-controlled, so the protocol allow list is this page's own defence
// and does not lean on the projection having filtered already. A relative or unparsable
// href has no origin to show the visitor either, so it is not offered as a link.
const linkHref = computed(() => {
    const raw = props.selected && props.selected.link
    const value = raw == null ? '' : String(raw).trim()
    if (!value) {
        return ''
    }
    let parsed
    try {
        parsed = new URL(value)
    } catch {
        return ''
    }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : ''
})

watch(() => props.selected, () => {
    copyResult.value = ''
})

function bindSelectable(el) {
    selectableRef.value = el
}

async function copyCode() {
    if (!code.value) {
        return
    }
    const result = await copy(code.value)
    copyAttempt.value += 1
    copyResult.value = result.copied ? 'copied' : 'manual'
}
</script>

<style scoped>
/* P5 · UI 设计卡:P0 信息 = OTP 大字 + 复制。token 继承自 .share-shell,
   fallback 值与设计卡一致,组件单独渲染时形状不变。 */
.share-otp {
    position: relative;
    margin: 24px 0;
    padding: 20px;
    border: 1px solid rgba(59, 91, 219, 0.25);
    border-radius: calc(var(--sh-radius, 16px) - 4px);
    background: var(--sh-accent-soft, #edf2ff);
}

.share-otp-label {
    margin: 0 0 8px;
    font-size: 13px;
    color: var(--sh-muted, #5c5f77);
}

.share-otp-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px 16px;
}

.share-otp-row button {
    font: inherit;
    cursor: pointer;
    padding: 10px 18px;
    color: #fff;
    background: var(--sh-accent, #3b5bdb);
    border: 1px solid var(--sh-accent, #3b5bdb);
    border-radius: calc(var(--sh-radius, 16px) - 8px);
}

.share-otp-row button:focus-visible {
    outline: 2px solid var(--sh-text, #1b1f3b);
    outline-offset: 2px;
}

/* 设计卡:OTP clamp(30px, 8vw, 40px),等宽数字。 */
.share-otp-value {
    font-size: clamp(30px, 8vw, 40px);
    line-height: 1.2;
    letter-spacing: 0.12em;
    color: var(--sh-text, #1b1f3b);
    font-variant-numeric: tabular-nums;
}

.share-otp-link {
    margin-top: 16px;
}

/* Wraps rather than truncates: a URL cut off mid-host is exactly the part a visitor
   needs to read before deciding to follow it. */
.share-otp-url {
    display: inline-block;
    max-width: 100%;
    overflow-wrap: anywhere;
    word-break: break-all;
    color: var(--sh-accent, #3b5bdb);
}

.share-otp-empty {
    margin: 0;
    color: var(--sh-muted, #5c5f77);
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
    box-sizing: border-box;
    border: 1px solid rgba(92, 95, 119, 0.35);
    border-radius: calc(var(--sh-radius, 16px) - 8px);
    font: inherit;
    letter-spacing: 0.12em;
}

/* 移动(设计卡):复制按钮全宽,触控 ≥ 44px。 */
@media (max-width: 640px) {
    .share-otp-row button {
        width: 100%;
        min-height: 44px;
    }
}
</style>
