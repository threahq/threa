import { useSyncExternalStore } from "react"

export const MOBILE_BREAKPOINT = 640

const mobileQuery = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

// Shared subscription — one matchMedia listener regardless of how many
// components call useIsMobile (avoids N listeners in long message lists).
const mql = typeof window !== "undefined" ? window.matchMedia(mobileQuery) : null

function subscribe(onChange: () => void) {
  mql?.addEventListener("change", onChange)
  return () => mql?.removeEventListener("change", onChange)
}

function getSnapshot() {
  return mql?.matches ?? false
}

export function useIsMobile() {
  return useSyncExternalStore(subscribe, getSnapshot)
}

/**
 * Minimum viewport for a side-by-side split (a form/main pane plus a resizable
 * side panel). Derived from the panel-layout floors: MIN_MAIN_WIDTH (400) +
 * MIN_PANEL_WIDTH (300) + a docked sidebar — below this the split crushes both
 * panes, so split surfaces should fall back to their stacked/drawer layout.
 * Phone-landscape (~667-850px) and small tablets land in that band; gating on
 * MOBILE_BREAKPOINT alone would hand them the degenerate split.
 */
export const SPLIT_VIEW_BREAKPOINT = 1024

const splitCapableQuery = `(min-width: ${SPLIT_VIEW_BREAKPOINT}px)`
const splitMql = typeof window !== "undefined" ? window.matchMedia(splitCapableQuery) : null

function subscribeSplit(onChange: () => void) {
  splitMql?.addEventListener("change", onChange)
  return () => splitMql?.removeEventListener("change", onChange)
}

function getSplitSnapshot() {
  return splitMql?.matches ?? false
}

/** True when the viewport can host a usable editor|panel split. */
export function useIsSplitCapable() {
  return useSyncExternalStore(subscribeSplit, getSplitSnapshot)
}
