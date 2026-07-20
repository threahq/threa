import { useSyncExternalStore } from "react"
import type { CallMode } from "@/calls/config"

// Module store (useSyncExternalStore) for live incoming-call rings, keyed by
// attemptId (the invitation id). Rings arrive user-scoped on the account socket
// (workspace-sync) and are settled by a matching event from any of the user's
// devices — an accept on the phone clears the laptop's overlay. Registered in
// account-scope `flushModuleStoreCaches` so a switch drops the prior account's
// rings. One attempt = one ring across every device (multi-device single id).

export interface IncomingCall {
  attemptId: string
  callId: string
  workspaceId: string
  streamId: string
  inviterId: string
  inviterName: string | null
  mode: CallMode
  /** Epoch ms; the ring self-dismisses at this deadline if no settle arrives. */
  expiresAtMs: number
}

let calls: IncomingCall[] = []
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function clearTimer(attemptId: string): void {
  const timer = timers.get(attemptId)
  if (timer) {
    clearTimeout(timer)
    timers.delete(attemptId)
  }
}

/**
 * Register a live ring. A ring already past its deadline (a stale sync-log
 * replay after being offline) is dropped rather than surfaced. Re-adding the
 * same attempt id is idempotent. Schedules a local self-dismiss at the deadline
 * so the overlay clears even if the server's expire settle is missed.
 */
export function addIncomingCall(call: IncomingCall): void {
  if (call.expiresAtMs <= Date.now()) return
  if (calls.some((c) => c.attemptId === call.attemptId)) return
  calls = [...calls, call]
  clearTimer(call.attemptId)
  timers.set(
    call.attemptId,
    setTimeout(() => settleIncomingCall(call.attemptId), Math.max(0, call.expiresAtMs - Date.now()))
  )
  emit()
}

/** Remove a ring (settled on any device, timed out, or acted on locally). */
export function settleIncomingCall(attemptId: string): void {
  clearTimer(attemptId)
  if (!calls.some((c) => c.attemptId === attemptId)) return
  calls = calls.filter((c) => c.attemptId !== attemptId)
  emit()
}

/** Clear every ring on account switch (account-scope `flushModuleStoreCaches`). */
export function resetIncomingCallStoreCache(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  if (calls.length === 0) return
  calls = []
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): IncomingCall[] {
  return calls
}

export function useIncomingCalls(): IncomingCall[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Non-reactive read for imperative callers (tests, the SW click bridge). */
export function getIncomingCalls(): IncomingCall[] {
  return calls
}
