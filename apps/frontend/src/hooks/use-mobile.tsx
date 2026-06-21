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

const coarsePointerQuery = "(pointer: coarse)"

// Same shared-subscription pattern as useIsMobile: one matchMedia listener for
// the primary pointer being coarse (touch), regardless of caller count.
const coarseMql = typeof window !== "undefined" ? window.matchMedia(coarsePointerQuery) : null

function subscribeCoarse(onChange: () => void) {
  coarseMql?.addEventListener("change", onChange)
  return () => coarseMql?.removeEventListener("change", onChange)
}

function getCoarseSnapshot() {
  return coarseMql?.matches ?? false
}

/** True when the device's primary pointer is coarse (touch), e.g. a phone or
 *  tablet. Paired with {@link useIsMobile} to detect a phone-like device. */
export function useIsCoarsePointer() {
  return useSyncExternalStore(subscribeCoarse, getCoarseSnapshot)
}
