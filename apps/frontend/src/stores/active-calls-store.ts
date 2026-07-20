import { useCallback, useSyncExternalStore } from "react"
import type { ActiveCall } from "@threa/types"

/**
 * Ephemeral, non-persisted store of the calls live RIGHT NOW (roadmap 1.4),
 * keyed by call id within a workspace. Two reads ride it:
 *
 * - the sidebar live-call dot, per sidebar root (`rootStreamId`), and
 * - the timeline call card's LIVENESS gate — the card renders live only when a
 *   live call with its id is present here (liveness defaults dead: a stale live
 *   card with a Join button on a dead call is an interactive lie).
 *
 * Seeded from the workspace bootstrap (`activeCalls`) and, on reconnect, re-seeded
 * as the authoritative live set (INV-53) — the seed REPLACES the workspace's
 * entries, so a call whose end signal was missed is dropped at the next
 * reconnect. Live starts/ends fold in from `stream:call_started` /
 * `stream:call_ended` (workspace/user-room fan-out for the dot); the roster count
 * refines from the stream-scoped `call:participants_changed`.
 *
 * Not in IDB: transient presence, re-derived from the fresh bootstrap on reload.
 */

interface ActiveCallEntry extends ActiveCall {
  /** Currently-joined participant UserIds, when known (from bootstrap / participants_changed). */
  participantUserIds: string[]
}

// workspaceId -> callId -> entry
const workspaces = new Map<string, Map<string, ActiveCallEntry>>()

// `${workspaceId}:root:${rootStreamId}` and `${workspaceId}:call:${callId}` -> listeners
const keyListeners = new Map<string, Set<() => void>>()
// Content-stable snapshots per key (referential stability for useSyncExternalStore)
const rootSnapshots = new Map<string, ActiveCallEntry[]>()
const callSnapshots = new Map<string, ActiveCallEntry | null>()

const EMPTY: readonly ActiveCallEntry[] = Object.freeze([])

function rootKey(workspaceId: string, rootStreamId: string): string {
  return `${workspaceId}:root:${rootStreamId}`
}
function callKey(workspaceId: string, callId: string): string {
  return `${workspaceId}:call:${callId}`
}

function notify(key: string): void {
  for (const listener of keyListeners.get(key) ?? []) listener()
}

function sameEntry(a: ActiveCallEntry | null, b: ActiveCallEntry | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.callId === b.callId &&
    a.mode === b.mode &&
    a.participantCount === b.participantCount &&
    a.participantUserIds.length === b.participantUserIds.length &&
    a.participantUserIds.every((id, i) => id === b.participantUserIds[i])
  )
}

function sameRoot(a: readonly ActiveCallEntry[], b: readonly ActiveCallEntry[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!sameEntry(a[i], b[i])) return false
  return true
}

/** Recompute the cached snapshot for one call key; notify iff its content changed. */
function recomputeCall(workspaceId: string, callId: string): void {
  const key = callKey(workspaceId, callId)
  const entry = workspaces.get(workspaceId)?.get(callId) ?? null
  const prev = callSnapshots.get(key)
  if (entry === null) {
    if (prev === undefined) return
    callSnapshots.delete(key)
  } else {
    if (prev !== undefined && sameEntry(prev, entry)) return
    callSnapshots.set(key, entry)
  }
  notify(key)
}

/** Recompute the cached snapshot for one sidebar-root key; notify iff changed. */
function recomputeRoot(workspaceId: string, rootStreamId: string): void {
  const key = rootKey(workspaceId, rootStreamId)
  const calls = [...(workspaces.get(workspaceId)?.values() ?? [])]
    .filter((entry) => entry.rootStreamId === rootStreamId)
    .sort((a, b) => a.callId.localeCompare(b.callId))
  const prev = rootSnapshots.get(key)
  if (calls.length === 0) {
    if (prev === undefined) return
    rootSnapshots.delete(key)
  } else {
    if (prev && sameRoot(prev, calls)) return
    rootSnapshots.set(key, calls)
  }
  notify(key)
}

function recompute(workspaceId: string, entry: ActiveCallEntry): void {
  recomputeCall(workspaceId, entry.callId)
  recomputeRoot(workspaceId, entry.rootStreamId)
}

/** Replace the whole live set for a workspace (bootstrap / reconnect re-seed). */
export function seedActiveCalls(workspaceId: string, calls: ActiveCall[]): void {
  const previous = workspaces.get(workspaceId)
  const affectedRoots = new Set<string>()
  const affectedCalls = new Set<string>()
  for (const entry of previous?.values() ?? []) {
    affectedRoots.add(entry.rootStreamId)
    affectedCalls.add(entry.callId)
  }
  const next = new Map<string, ActiveCallEntry>()
  for (const call of calls) {
    // Preserve a known roster from the prior entry — the workspace seed carries a
    // count but not the joined UserIds, and the card's live avatars want them.
    const prior = previous?.get(call.callId)
    next.set(call.callId, { ...call, participantUserIds: prior?.participantUserIds ?? [] })
    affectedRoots.add(call.rootStreamId)
    affectedCalls.add(call.callId)
  }
  workspaces.set(workspaceId, next)
  for (const callId of affectedCalls) recomputeCall(workspaceId, callId)
  for (const root of affectedRoots) recomputeRoot(workspaceId, root)
}

/** Add or refresh one live call (a `call_started`, or a stream-bootstrap seed). */
export function upsertActiveCall(workspaceId: string, call: ActiveCall & { participantUserIds?: string[] }): void {
  let ws = workspaces.get(workspaceId)
  if (!ws) {
    ws = new Map()
    workspaces.set(workspaceId, ws)
  }
  const existing = ws.get(call.callId)
  const entry: ActiveCallEntry = {
    callId: call.callId,
    streamId: call.streamId,
    rootStreamId: call.rootStreamId,
    mode: call.mode,
    participantCount: call.participantCount,
    participantUserIds: call.participantUserIds ?? existing?.participantUserIds ?? [],
  }
  ws.set(call.callId, entry)
  recompute(workspaceId, entry)
}

/**
 * Refine an existing live call's roster (from `call:participants_changed`). Carries
 * the joined UserIds + count for the card.
 *
 * REFINE-ONLY: a `participants_changed` for a call the store isn't tracking (its
 * start was missed, or — the resurrection footgun — it already ended and was
 * removed) must NEVER fabricate a live entry. Creation is owned by the seed/upsert
 * paths (bootstrap + `call_started`); a late roster event for a dead call is a
 * no-op so its card stays dead.
 */
export function updateCallParticipants(
  workspaceId: string,
  args: { callId: string; streamId: string; participantCount: number; participantUserIds: string[] }
): void {
  const ws = workspaces.get(workspaceId)
  const existing = ws?.get(args.callId)
  if (!ws || !existing) return
  const entry: ActiveCallEntry = {
    ...existing,
    participantCount: args.participantCount,
    participantUserIds: args.participantUserIds,
  }
  ws.set(args.callId, entry)
  recompute(workspaceId, entry)
}

/** Remove a live call by id on `call_ended` (root-agnostic). */
export function removeActiveCall(workspaceId: string, callId: string): void {
  const ws = workspaces.get(workspaceId)
  const existing = ws?.get(callId)
  if (!ws || !existing) return
  ws.delete(callId)
  recompute(workspaceId, existing)
}

/** Non-reactive read of one live call by id (the card liveness gate). */
export function getActiveCall(workspaceId: string, callId: string): ActiveCallEntry | null {
  return workspaces.get(workspaceId)?.get(callId) ?? null
}

function subscribeKey(key: string, onChange: () => void): () => void {
  let set = keyListeners.get(key)
  if (!set) {
    set = new Set()
    keyListeners.set(key, set)
  }
  set.add(onChange)
  return () => {
    set.delete(onChange)
    if (set.size === 0) keyListeners.delete(key)
  }
}

/**
 * The one live call with `callId`, if any — the card's liveness gate. Reactive
 * per-call so a roster change on an unrelated call re-renders nothing here.
 */
export function useActiveCall(workspaceId: string | undefined, callId: string | undefined): ActiveCallEntry | null {
  const subscribe = useCallback(
    (onChange: () => void) => (workspaceId && callId ? subscribeKey(callKey(workspaceId, callId), onChange) : () => {}),
    [workspaceId, callId]
  )
  const getSnapshot = useCallback(
    () => (workspaceId && callId ? getActiveCall(workspaceId, callId) : null),
    [workspaceId, callId]
  )
  return useSyncExternalStore(subscribe, getSnapshot)
}

/**
 * The live calls in `rootStreamId` (sidebar dot). Reactive per-row: an unrelated
 * stream's call change re-renders nothing here.
 */
export function useActiveCallsForStream(
  workspaceId: string | undefined,
  rootStreamId: string | undefined
): readonly ActiveCallEntry[] {
  const subscribe = useCallback(
    (onChange: () => void) =>
      workspaceId && rootStreamId ? subscribeKey(rootKey(workspaceId, rootStreamId), onChange) : () => {},
    [workspaceId, rootStreamId]
  )
  const getSnapshot = useCallback(
    () => (workspaceId && rootStreamId ? (rootSnapshots.get(rootKey(workspaceId, rootStreamId)) ?? EMPTY) : EMPTY),
    [workspaceId, rootStreamId]
  )
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Test-only: wipe all state between cases. */
export function __resetActiveCallsStore(): void {
  workspaces.clear()
  keyListeners.clear()
  rootSnapshots.clear()
  callSnapshots.clear()
}
