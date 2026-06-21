import { useSyncExternalStore } from "react"

// Which input the user is *currently* driving the app with. This is distinct
// from device capability: a touchscreen laptop can be driven by its trackpad
// (mouse) one moment and a finger the next, and the browser's `(pointer: …)` /
// `(hover: …)` media queries report a single fixed guess that is wrong for the
// other input. We instead watch the live pointer stream and flip a mode, so
// hover affordances reveal for a mouse and stay out of the way for a finger —
// regardless of what the device "is".
//
// The mode is mirrored onto `<html data-input>` so pure-CSS reveals can key off
// it (see the `.reveal-*` rules in index.css) without every component subscribing.
export type InputMode = "mouse" | "touch"

const INPUT_ATTR = "data-input"

function initialMode(): InputMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "mouse"
  // First paint guess from the primary pointer; corrected on the first real event.
  return window.matchMedia("(pointer: coarse)").matches ? "touch" : "mouse"
}

let mode: InputMode = initialMode()
const listeners = new Set<() => void>()

function applyAttribute() {
  if (typeof document !== "undefined") document.documentElement.setAttribute(INPUT_ATTR, mode)
}

function setMode(next: InputMode) {
  if (next === mode) return
  mode = next
  applyAttribute()
  for (const l of listeners) l()
}

function handlePointer(event: PointerEvent) {
  if (event.pointerType === "touch") setMode("touch")
  else if (event.pointerType === "mouse" || event.pointerType === "pen") setMode("mouse")
}

if (typeof window !== "undefined") {
  applyAttribute()
  // Capture so we see the input even when a child stops propagation; passive
  // because we never preventDefault. pointermove keeps a mouse that only hovers
  // (never clicks) from being misread as touch.
  window.addEventListener("pointerdown", handlePointer, { capture: true, passive: true })
  window.addEventListener("pointermove", handlePointer, { capture: true, passive: true })
}

function subscribe(onChange: () => void) {
  listeners.add(onChange)
  return () => listeners.delete(onChange)
}

function getSnapshot(): InputMode {
  return mode
}

function getServerSnapshot(): InputMode {
  return "mouse"
}

export function useInputMode(): InputMode {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
