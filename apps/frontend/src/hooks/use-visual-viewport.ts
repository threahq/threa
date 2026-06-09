import { useState, useEffect, useRef } from "react"

/** Threshold in px — if viewport height is this much smaller than baseline, keyboard is open */
const KEYBOARD_THRESHOLD = 100

/** How long to poll visualViewport after focus changes to catch keyboard animation (ms) */
const POLL_DURATION = 600

/**
 * Debounce (ms) for *growth* of `--viewport-height`. Chrome on Android steps
 * `visualViewport.height` through several intermediate values while the
 * keyboard closes — including a transient overshoot past the real viewport
 * (753px reported on a 725px screen) — and writing each one into layout makes
 * the close a multi-step stutter and briefly sizes the app taller than the
 * screen, pushing the bottom-anchored composer below the fold. Growth is never
 * urgent (while the value moves, the closing keyboard still covers the area
 * the app hasn't reclaimed), so wait for it to hold still and apply the final
 * height once — the same single-step resize Firefox performs natively.
 * Shrink stays synchronous: deferring it leaves the composer hidden behind
 * the rising keyboard while the user is about to type.
 */
const GROWTH_DEBOUNCE_MS = 150

/** CSS custom property AppShell reads to size the app to the visible viewport */
const VIEWPORT_HEIGHT_VAR = "--viewport-height"

/**
 * Tracks the on-screen keyboard state on mobile devices and pins
 * `--viewport-height` to the actual visible viewport height.
 *
 * Why always write `--viewport-height` (not just when the keyboard is open)?
 * Chrome on Android does not reliably recompute `dvh` after `location.reload`,
 * pull-to-refresh, or a back-forward cache restore — the engine keeps the
 * pre-reload "URL-bar hidden" value, so any element sized to `100dvh` renders
 * taller than the visible area. The bottom of the app (composer) ends up
 * below the fold until something forces a re-layout (opening the keyboard for
 * search or the quick switcher, URL-bar animation, orientation change).
 * Firefox Android handles `dvh` correctly, which is why the bug is Chrome-only.
 * Sourcing the height from `visualViewport.height` bypasses the buggy `dvh`
 * resolution entirely and gives layout a stable, authoritative value.
 *
 * Detection strategy (layered to handle browser differences):
 * 1. Primary: visualViewport.height < window.innerHeight (Chrome, Safari)
 * 2. Fallback: visualViewport.height < baselineHeight (Firefox Android,
 *    which resizes both viewports together when the keyboard opens)
 *
 * Also polls `visualViewport` during input focus transitions to catch
 * keyboard animation frames that may not emit discrete resize events, and
 * re-measures on `pageshow` so BFCache restores do not linger in a stale
 * viewport state.
 */
export function useVisualViewport(enabled: boolean): boolean {
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false)
  // Separate handles: the focus-transition poll must not share a raf slot with
  // scroll coalescing. iOS Safari emits visualViewport `scroll` events while
  // the keyboard hide animation un-pans the page; if that cancelled the poll
  // it would freeze --viewport-height at the still-collapsed mid-animation
  // height, leaving the composer floating above a dead keyboard gap.
  const pollRafId = useRef(0)
  const scrollRafId = useRef(0)
  const settleTimeoutId = useRef(0)
  // Baseline height = innerHeight when keyboard is known to be closed.
  // Used as fallback for browsers that resize both viewports together (Firefox).
  const baseHeight = useRef(typeof window !== "undefined" ? window.innerHeight : 0)

  useEffect(() => {
    if (!enabled) return

    const vv = window.visualViewport
    const docEl = document.documentElement

    // Reset baseline on mount
    baseHeight.current = window.innerHeight
    // Last value written to --viewport-height so we can skip redundant style
    // writes during the rAF poll loop and avoid invalidating every consumer
    // of the custom property on frames where nothing actually changed.
    let lastWrittenHeight = Number.NaN
    // Growth target currently waiting out the settle debounce (NaN when none).
    // Tracked so the poll loop — which calls update() every frame with the
    // same value — doesn't reset the timer and starve the debounce; only a
    // *changed* target reschedules it.
    let pendingGrowthHeight = Number.NaN
    let growthTimerId = 0

    const measureEffectiveHeight = () => {
      const vvHeight = vv ? vv.height : window.innerHeight

      // The OS keyboard for this page can only appear when an editable element
      // in this document has focus. If `vv.height` shrinks without an editable
      // focus, it is a transient browser quirk — Chrome on Android does this
      // routinely when a PWA is foregrounded after another app had the system
      // keyboard up, and on URL-bar / system-bar animations during resume.
      // Trusting that shrink propagates through `--viewport-height` → AppShell
      // → scroller ResizeObservers and shows up as the "scroll offset bug":
      // AppShell briefly shorter than the device viewport, plus a stray
      // `scrollTop += delta` shift that doesn't unwind cleanly when the
      // height bounces back. Clamp to `innerHeight` in that case so layout
      // stays put until the phantom resolves.
      const editableFocused = isEditableFocused()
      const looksLikePhantomShrink = !!vv && !editableFocused && vvHeight < window.innerHeight - KEYBOARD_THRESHOLD
      return looksLikePhantomShrink ? window.innerHeight : vvHeight
    }

    const applyHeight = (px: number) => {
      docEl.style.setProperty(VIEWPORT_HEIGHT_VAR, `${px}px`)
      lastWrittenHeight = px
    }

    const cancelPendingGrowth = () => {
      clearTimeout(growthTimerId)
      pendingGrowthHeight = Number.NaN
    }

    const update = () => {
      const effectiveHeight = measureEffectiveHeight()

      // Primary: visual viewport smaller than layout viewport (Chrome, Safari)
      let keyboardOpen = vv ? effectiveHeight < window.innerHeight - KEYBOARD_THRESHOLD : false

      // Fallback: viewport shrank from baseline (Firefox resizes both together)
      if (!keyboardOpen) {
        keyboardOpen = effectiveHeight < baseHeight.current - KEYBOARD_THRESHOLD
      }

      // Update baseline when keyboard is confirmed closed
      if (!keyboardOpen) {
        baseHeight.current = window.innerHeight
      }

      // Always pin --viewport-height to a concrete pixel value. Relying on
      // `100dvh` alone is unsafe on Chrome Android, which caches a stale
      // "URL-bar hidden" value across reloads, pull-to-refresh, and BFCache
      // restores and leaves the app taller than the visible viewport until
      // something (keyboard, URL bar animation, orientation change) forces a
      // re-layout. Shrink applies synchronously (keyboard opening must reveal
      // the composer immediately); growth waits out GROWTH_DEBOUNCE_MS so
      // Chrome Android's chunked keyboard-close values — and its transient
      // past-the-screen overshoot — collapse into one final write.
      if (effectiveHeight !== lastWrittenHeight) {
        if (Number.isNaN(lastWrittenHeight) || effectiveHeight < lastWrittenHeight) {
          cancelPendingGrowth()
          applyHeight(effectiveHeight)
        } else if (effectiveHeight !== pendingGrowthHeight) {
          cancelPendingGrowth()
          pendingGrowthHeight = effectiveHeight
          growthTimerId = window.setTimeout(() => {
            pendingGrowthHeight = Number.NaN
            // Re-measure at fire time: the keyboard may have settled on a
            // different final value than the chunk that scheduled this (the
            // overshoot settles back down without always emitting a resize).
            const settled = measureEffectiveHeight()
            if (settled !== lastWrittenHeight) applyHeight(settled)
          }, GROWTH_DEBOUNCE_MS)
        }
      } else {
        // Height returned to the already-written value before the debounce
        // elapsed — the growth was transient; nothing to apply.
        cancelPendingGrowth()
      }

      // Only update React state when the boolean actually changes
      setIsKeyboardOpen((prev) => (prev !== keyboardOpen ? keyboardOpen : prev))

      // Pin page scroll to prevent iOS visual viewport panning
      if (vv && vv.offsetTop > 0) {
        window.scrollTo(0, 0)
      }
    }

    // Poll every frame for a duration to catch keyboard open/close animation.
    // After the rAF window closes, re-measure once more on a timer: iOS Safari
    // can settle visualViewport.height a few hundred ms after the keyboard
    // hide animation visually completes, and once the page is idle (no scroll
    // possible under html/body overflow:hidden) no other event would correct a
    // stale, too-short --viewport-height.
    const pollForDuration = (ms: number) => {
      cancelAnimationFrame(pollRafId.current)
      clearTimeout(settleTimeoutId.current)
      const start = performance.now()
      const poll = () => {
        update()
        if (performance.now() - start < ms) {
          pollRafId.current = requestAnimationFrame(poll)
        }
      }
      pollRafId.current = requestAnimationFrame(poll)
      settleTimeoutId.current = window.setTimeout(update, ms + 200)
    }

    // Coalesce viewport scroll events via rAF. Uses its own handle so it can
    // never cancel an in-flight focus-transition poll (the poll already calls
    // update() every frame, so scroll updates during it are redundant anyway).
    const onScroll = () => {
      cancelAnimationFrame(scrollRafId.current)
      scrollRafId.current = requestAnimationFrame(update)
    }

    // Poll across focus transitions on editable elements — covers both keyboard
    // opening (focusin) and closing (focusout), which can each animate for
    // several frames without emitting discrete resize events.
    const onEditableFocusChange = (e: FocusEvent) => {
      if (e.target instanceof HTMLElement && isEditable(e.target)) {
        pollForDuration(POLL_DURATION)
      }
    }

    // Re-measure when the page is restored (BFCache restore, tab refocus).
    // Chrome Android's dvh is routinely stale here and `resize` events may
    // not fire, so poll briefly to catch the URL bar animation too.
    const onPageShow = () => {
      baseHeight.current = window.innerHeight
      pollForDuration(POLL_DURATION)
    }

    // Set initial state
    update()

    // Listen to visualViewport events (primary detection for Chrome/Safari)
    if (vv) {
      vv.addEventListener("resize", update)
      vv.addEventListener("scroll", onScroll)
    }
    // Also listen to window resize (Firefox fires this when keyboard changes innerHeight)
    window.addEventListener("resize", update)
    document.addEventListener("focusin", onEditableFocusChange)
    document.addEventListener("focusout", onEditableFocusChange)
    window.addEventListener("pageshow", onPageShow)

    return () => {
      cancelAnimationFrame(pollRafId.current)
      cancelAnimationFrame(scrollRafId.current)
      clearTimeout(settleTimeoutId.current)
      cancelPendingGrowth()
      if (vv) {
        vv.removeEventListener("resize", update)
        vv.removeEventListener("scroll", onScroll)
      }
      window.removeEventListener("resize", update)
      document.removeEventListener("focusin", onEditableFocusChange)
      document.removeEventListener("focusout", onEditableFocusChange)
      window.removeEventListener("pageshow", onPageShow)
      docEl.style.removeProperty(VIEWPORT_HEIGHT_VAR)
    }
  }, [enabled])

  return enabled ? isKeyboardOpen : false
}

function isEditable(el: HTMLElement): boolean {
  const tag = el.tagName
  if (tag === "INPUT" || tag === "TEXTAREA") return true
  if (el.isContentEditable) return true
  return false
}

function isEditableFocused(): boolean {
  const el = document.activeElement
  return el instanceof HTMLElement && isEditable(el)
}
