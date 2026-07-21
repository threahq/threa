import { useSyncExternalStore } from "react"
import { useIsMobile } from "./use-mobile"

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

/** Imperative snapshot of the coarse-primary-pointer media query, for non-React callers. */
export function isCoarsePointerDevice() {
  return getSnapshot()
}

export function useCoarsePointer() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

// The overlay-sidebar / mobile-full-screen breadth: a phone-width viewport OR a
// touch-primary device (a tablet in landscape is wide but finger-driven, so it
// keeps the swipeable overlay sidebar and full-screen panel). The single source
// for this formula so `useSidebar().isMobile` and the board float gate can't
// drift apart — the disagreement between them is what produced the mid-flow
// editor bug.
export function useIsMobileOrCoarse() {
  const isNarrowViewport = useIsMobile()
  const isTouchPrimary = useCoarsePointer()
  return isNarrowViewport || isTouchPrimary
}
