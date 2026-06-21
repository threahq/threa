import { useSyncExternalStore } from "react"

// Whether the PRIMARY pointer is coarse — i.e. this is a touch-primary device
// (phone / tablet / convertible in tablet mode), NOT a mouse-primary one.
//
// This is deliberately distinct from `useTouchCapable` (`any-pointer: coarse`):
// a touch laptop is touch-CAPABLE but mouse-PRIMARY (its trackpad reports
// `pointer: fine`), and should keep its mouse-focused layout. Use this for
// device-class layout/mode decisions (e.g. the overlay-vs-pinned sidebar); use
// `useTouchCapable` to additively enable touch gestures, and `useInputMode` for
// affordances that follow whichever input the user is actively driving.
const coarseQuery = "(pointer: coarse)"

// Shared subscription — one matchMedia listener regardless of how many callers.
const coarseMql = typeof window !== "undefined" ? window.matchMedia(coarseQuery) : null

function subscribe(onChange: () => void) {
  coarseMql?.addEventListener("change", onChange)
  return () => coarseMql?.removeEventListener("change", onChange)
}

function getSnapshot() {
  return coarseMql?.matches ?? false
}

function getServerSnapshot() {
  return false
}

export function useCoarsePointer() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
