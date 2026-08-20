import { useSyncExternalStore } from "react"

// Bounded in-memory ring of call page-lifecycle events (module store +
// useSyncExternalStore, like call-store). Diagnostic only — nothing reads it to
// make a decision. NOT cleared on teardown or on the next call's start: it exists
// to explain a call that already died, so clearing it there would erase the
// evidence. Bounded instead, and dropped only by the account flush.

export const CALL_LIFECYCLE_KINDS = [
  "visible",
  "hidden",
  "freeze",
  "resume",
  "pagehide",
  "pageshow",
  "socket_connect",
  "socket_disconnect",
  "lease_renew_ok",
  "lease_renew_failed",
  "rejoin_same_endpoint",
  "rejoin_new_endpoint",
  "rejoin_failed",
  "publish_failed",
  "pull_failed",
  "teardown",
] as const

export type CallLifecycleKind = (typeof CALL_LIFECYCLE_KINDS)[number]

export const CALL_LIFECYCLE_LOG_MAX = 200

export interface CallLifecycleEntry {
  at: number
  kind: CallLifecycleKind
  detail?: string
}

let entries: CallLifecycleEntry[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** Append an event, stamping `at`; oldest entries fall off at the cap. */
export function recordCallLifecycleEvent(entry: { kind: CallLifecycleKind; detail?: string }): void {
  const next = entries.concat({ at: Date.now(), ...entry })
  entries = next.length > CALL_LIFECYCLE_LOG_MAX ? next.slice(next.length - CALL_LIFECYCLE_LOG_MAX) : next
  emit()
}

/** Oldest first. */
export function getCallLifecycleEvents(): CallLifecycleEntry[] {
  return entries
}

export function subscribeCallLifecycle(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Flush entry point (account switch / logout), beside `resetCallStoreCache`. */
export function clearCallLifecycleLog(): void {
  if (entries.length === 0) return
  entries = []
  emit()
}

export function useCallLifecycleEvents(): CallLifecycleEntry[] {
  return useSyncExternalStore(subscribeCallLifecycle, getCallLifecycleEvents, getCallLifecycleEvents)
}
