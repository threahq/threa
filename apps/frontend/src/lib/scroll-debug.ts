/**
 * Opt-in tracing for the timeline scroll engine. Off by default and free when
 * off (a single localStorage read short-circuits before any work). Turn it on in
 * the browser console with:
 *
 *   localStorage.threaScrollDebug = "1"   // then reload
 *
 * or append `?scrolldebug=1` to the URL once (it persists the flag). Every scroll
 * decision (follow arm/disarm, snaps, ResizeObserver actions, keyboard focus,
 * composer-height changes) prints a structured `[scroll] <event>` line so a
 * device-only glitch can be diagnosed from the console / remote inspector.
 *
 * This module is intentionally self-contained and easy to delete once the
 * timeline scroll behaviour is locked in.
 */

const STORAGE_KEY = "threaScrollDebug"

let cached: boolean | null = null

/** Whether scroll tracing is enabled. Reads the URL param once (and persists it
 *  to localStorage), then caches the localStorage value for the session. */
export function isScrollDebugEnabled(): boolean {
  if (cached !== null) return cached
  if (typeof window === "undefined") return false
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("scrolldebug")
    if (fromUrl === "1") window.localStorage.setItem(STORAGE_KEY, "1")
    if (fromUrl === "0") window.localStorage.removeItem(STORAGE_KEY)
    cached = window.localStorage.getItem(STORAGE_KEY) === "1"
  } catch {
    cached = false
  }
  return cached
}

/** Emit a structured trace line when scroll debugging is enabled; otherwise a
 *  no-op. `data` is logged inline so it's filterable/expandable in the console. */
export function scrollDebug(event: string, data?: Record<string, unknown>): void {
  if (!isScrollDebugEnabled()) return
  const t = Math.round(performance.now())
  console.debug(`[scroll +${t}ms] ${event}`, data ?? {})
}
