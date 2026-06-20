import { useSyncExternalStore } from "react"

// Whether touch input is AVAILABLE on this device — not whether it is the
// primary pointer. Touch gestures (long-press, swipe, pull-to-refresh) are
// enabled additively whenever a finger *could* be used: a finger then fires the
// gesture, a mouse simply never emits touch events, so enabling them on a
// hybrid (touchscreen laptop) costs nothing and strands no one. Keying gesture
// enablement on the *primary* pointer instead would exclude hybrids — that
// exclusion was the dead zone this fixes.
const anyCoarseQuery = "(any-pointer: coarse)"

const anyCoarseMql =
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(anyCoarseQuery) : null

function hasMaxTouchPoints(): boolean {
  return typeof navigator !== "undefined" && navigator.maxTouchPoints > 0
}

function subscribe(onChange: () => void) {
  anyCoarseMql?.addEventListener("change", onChange)
  return () => anyCoarseMql?.removeEventListener("change", onChange)
}

function getSnapshot(): boolean {
  return (anyCoarseMql?.matches ?? false) || hasMaxTouchPoints()
}

function getServerSnapshot(): boolean {
  return false
}

export function useTouchCapable(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
