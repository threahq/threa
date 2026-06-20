import { useSyncExternalStore } from "react"

// Touch affordances — swipe, long-press, action sheets, larger tap targets —
// key off input capability, not viewport width. An iPad in landscape is wide
// but finger-driven; a narrow desktop window is small but mouse-driven. Width
// (useIsMobile) answers "do I have room?"; this answers "what is the user
// pointing with?". `(pointer: coarse)` is true when the primary pointer is a
// finger, so a laptop with a touchscreen still reads as fine (its trackpad is
// the primary pointer), which is the right default for precise affordances.
const coarseQuery = "(pointer: coarse)"

// Shared subscription — one matchMedia listener regardless of how many
// components call useCoarsePointer (avoids N listeners in long message lists).
const coarseMql = typeof window !== "undefined" ? window.matchMedia(coarseQuery) : null

function subscribe(onChange: () => void) {
  coarseMql?.addEventListener("change", onChange)
  return () => coarseMql?.removeEventListener("change", onChange)
}

function getSnapshot() {
  return coarseMql?.matches ?? false
}

export function useCoarsePointer() {
  return useSyncExternalStore(subscribe, getSnapshot)
}
