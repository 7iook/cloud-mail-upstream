import { onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue'
import { liveEffectiveStatus } from './status.js'

// The ~1s heartbeat behind every owner-facing share status (P1). Each consuming face reads
// liveEffectiveStatus against this reactive clock, so a tab parked across expiresAt flips to
// EXPIRED without a refetch; focus/visibility syncs cover a frozen background tab.
export function useShareClock() {
    const nowMs = ref(Date.now())
    let timer = 0

    function sync() {
        nowMs.value = Date.now()
    }

    function onVisibility() {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') {
            sync()
        }
    }

    // start/stop are idempotent because both onMounted and onActivated fire on the first
    // mount inside a keep-alive tree, and stop runs for both onDeactivated and onUnmounted.
    function start() {
        if (timer) {
            return
        }
        sync()
        timer = window.setInterval(sync, 1000)
        window.addEventListener('focus', sync)
        document.addEventListener('visibilitychange', onVisibility)
    }

    function stop() {
        if (!timer) {
            return
        }
        window.clearInterval(timer)
        timer = 0
        window.removeEventListener('focus', sync)
        document.removeEventListener('visibilitychange', onVisibility)
    }

    onMounted(start)
    // The email page sits in the layout keep-alive: navigating away deactivates instead of
    // unmounting, so without these two hooks every visit would leak one ticking interval.
    onActivated(start)
    onDeactivated(stop)
    onUnmounted(stop)

    function liveStatus(row) {
        return liveEffectiveStatus(row, nowMs.value)
    }

    return { nowMs, liveStatus }
}
