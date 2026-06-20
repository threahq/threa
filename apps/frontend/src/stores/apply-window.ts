import { useRef, useSyncExternalStore } from "react"

/**
 * A coarse, app-global "a multi-event apply is in progress" signal. While it is
 * open, the shared IndexedDB store hooks (sidebar streams, unread/activity
 * badges, stream memberships, labels, dmPeers, drafts, …) HOLD their last value
 * instead of re-rendering for every individual write, then re-read once when it
 * closes — so applying N events (a sync catch-up replay) paints the FINAL state
 * in one settle instead of trickling N times. Without it, replay drives the live
 * socket handlers per entry and each write fires its table's `useLiveQuery`, so a
 * backlog of streams archived / drafts upserted / members added visibly slots in
 * one at a time.
 *
 * It is purely a render-layer coalescer: IndexedDB stays the source of truth and
 * the hooks re-read fresh on close, so the worst case for any bug here is a
 * single stale frame that the close corrects — never lost or wrong data. That is
 * why the gate is global and event-type-agnostic rather than per handler: a new
 * handler needs no awareness of it.
 *
 * Refcounted (begin/end nest) so overlapping windows are safe; a watchdog
 * force-closes a stuck window so a missed `end` can never strand the UI frozen.
 *
 * Global (not workspace-keyed) on purpose: `workspace-layout` mounts exactly one
 * `SyncEngine` at a time (it recreates the engine on workspace change and the
 * account scope remounts on account switch), so there is only ever one catch-up
 * coordinating this gate. If concurrent per-workspace engines are ever
 * introduced, key this by `workspaceId` the way `reveal-gate` does, or one
 * workspace's replay would freeze another's reads.
 */
let depth = 0
let watchdog: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

// Long enough to cover a real catch-up replay (bounded by the collapse threshold
// to a few hundred entries — sub-second), short enough that a leaked window
// self-heals quickly rather than stranding the UI frozen.
const APPLY_WINDOW_WATCHDOG_MS = 5_000

// Notify only on the closed↔open transitions that matter to readers (depth
// 0↔1), never on a nested bump (1↔2): `useApplyWindowOpen` snapshots the boolean,
// so a nested change wouldn't re-render anyway, and direct subscribers want the
// transition, not every refcount tick.
function notifyTransition(): void {
  for (const listener of listeners) listener()
}

export function beginApplyWindow(): void {
  depth += 1
  // Arm the watchdog once, on the open transition — not on nested begins, so a
  // (mis)nested caller can't keep pushing the deadline out and stranding the UI
  // frozen. The bound is "≤5s from first open", which any real replay clears.
  if (depth === 1) {
    if (watchdog) clearTimeout(watchdog)
    watchdog = setTimeout(forceCloseApplyWindow, APPLY_WINDOW_WATCHDOG_MS)
    notifyTransition()
  }
}

export function endApplyWindow(): void {
  if (depth === 0) return
  depth -= 1
  if (depth === 0) {
    if (watchdog) {
      clearTimeout(watchdog)
      watchdog = null
    }
    notifyTransition()
  }
}

function forceCloseApplyWindow(): void {
  if (depth === 0) return
  console.warn("Apply window watchdog fired; force-closing", { depth })
  depth = 0
  watchdog = null
  notifyTransition()
}

export function isApplyWindowOpen(): boolean {
  return depth > 0
}

export function subscribeApplyWindow(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Re-renders the caller on every closed↔open transition. The snapshot IS the
 * open boolean (not a version counter), so React tracks the value it returns —
 * no concurrent-mode tearing, and a nested refcount bump doesn't re-render.
 */
export function useApplyWindowOpen(): boolean {
  return useSyncExternalStore(subscribeApplyWindow, isApplyWindowOpen, isApplyWindowOpen)
}

/**
 * Hold `value` steady while an apply window is open, releasing to the latest
 * value when it closes. Outside a window this is a pass-through — zero behavior
 * change for live operation, which is the overwhelming common case.
 *
 * The ref is written during render on purpose: it caches the last value seen
 * while the window was closed (the pre-window value to freeze on), is derived
 * deterministically from `value`, and never schedules a render — the same
 * structural-sharing pattern the stream store uses.
 */
export function useBatchedValue<T>(value: T): T {
  const open = useApplyWindowOpen()
  const held = useRef(value)
  if (!open) held.current = value
  return open ? held.current : value
}

/** Test/teardown escape hatch: reset to the closed, depth-0 state. */
export function resetApplyWindow(): void {
  const wasOpen = depth > 0
  depth = 0
  if (watchdog) {
    clearTimeout(watchdog)
    watchdog = null
  }
  if (wasOpen) notifyTransition()
}
