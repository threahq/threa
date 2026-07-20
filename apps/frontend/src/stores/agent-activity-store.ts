import { useCallback, useSyncExternalStore } from "react"
import type { ActiveAgentSession } from "@threa/types"

/**
 * Ephemeral, non-persisted store of the agent sessions running RIGHT NOW,
 * keyed by their exact stream so a stream row can paint an "agent working"
 * state without inheriting activity from a parent or child. Seeded from the
 * workspace bootstrap (`activeAgentSessions`) and, on
 * reconnect, re-seeded as the authoritative running set (INV-53) — the seed
 * REPLACES the workspace's entries, so any entry whose end signal was missed is
 * dropped at the next reconnect. Live starts/ends fold in from the
 * `agent_session:*` room events (see workspace-sync). Removal is by session id
 * (stream-agnostic) so a terminal event always clears reliably regardless of
 * which room delivered it.
 *
 * Not in IDB: this is transient presence, not durable state — a cold reload
 * re-derives it from the fresh bootstrap.
 */

// workspaceId -> sessionId -> session
const workspaces = new Map<string, Map<string, ActiveAgentSession>>()

// `${workspaceId}:${streamId}` -> listeners subscribed to that row
const keyListeners = new Map<string, Set<() => void>>()
// Content-stable snapshot per key (referential stability for useSyncExternalStore)
const keySnapshots = new Map<string, ActiveAgentSession[]>()

const EMPTY: readonly ActiveAgentSession[] = Object.freeze([])

function subKey(workspaceId: string, streamId: string): string {
  return `${workspaceId}:${streamId}`
}

function sameSnapshot(a: readonly ActiveAgentSession[], b: readonly ActiveAgentSession[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].sessionId !== b[i].sessionId || a[i].personaName !== b[i].personaName) return false
  }
  return true
}

/** Recompute the cached snapshot for one stream key and notify iff its content changed. */
function recomputeKey(workspaceId: string, streamId: string): void {
  const key = subKey(workspaceId, streamId)
  const sessions = [...(workspaces.get(workspaceId)?.values() ?? [])]
    .filter((entry) => entry.streamId === streamId)
    // Most-recently-started first: the row's primary label picks [0].
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))

  const prev = keySnapshots.get(key)
  if (sessions.length === 0) {
    if (prev === undefined) return
    keySnapshots.delete(key)
  } else {
    if (prev && sameSnapshot(prev, sessions)) return
    keySnapshots.set(key, sessions)
  }
  for (const listener of keyListeners.get(key) ?? []) listener()
}

/** Replace the whole running set for a workspace (bootstrap / reconnect re-seed). */
export function seedAgentActivity(workspaceId: string, sessions: ActiveAgentSession[]): void {
  const previous = workspaces.get(workspaceId)
  const affectedStreams = new Set<string>()
  for (const entry of previous?.values() ?? []) affectedStreams.add(entry.streamId)

  const next = new Map<string, ActiveAgentSession>()
  for (const session of sessions) {
    next.set(session.sessionId, { ...session })
    affectedStreams.add(session.streamId)
  }
  workspaces.set(workspaceId, next)

  for (const streamId of affectedStreams) recomputeKey(workspaceId, streamId)
}

/** Add or refresh one running session (live `started`/`progress`). */
export function upsertAgentSession(workspaceId: string, session: ActiveAgentSession): void {
  let ws = workspaces.get(workspaceId)
  if (!ws) {
    ws = new Map()
    workspaces.set(workspaceId, ws)
  }
  const existing = ws.get(session.sessionId)
  if (
    existing &&
    existing.rootStreamId === session.rootStreamId &&
    existing.personaName === session.personaName &&
    existing.streamId === session.streamId
  ) {
    return
  }
  ws.set(session.sessionId, { ...session })
  if (existing && existing.streamId !== session.streamId) {
    recomputeKey(workspaceId, existing.streamId)
  }
  recomputeKey(workspaceId, session.streamId)
}

/** Remove a session by id on any terminal signal. */
export function removeAgentSession(workspaceId: string, sessionId: string): void {
  const ws = workspaces.get(workspaceId)
  const existing = ws?.get(sessionId)
  if (!ws || !existing) return
  ws.delete(sessionId)
  recomputeKey(workspaceId, existing.streamId)
}

/** True if a session with this id is already tracked in the workspace. */
export function hasAgentSession(workspaceId: string, sessionId: string): boolean {
  return workspaces.get(workspaceId)?.has(sessionId) ?? false
}

/** Non-reactive read of a stream's running sessions (most recent first). */
export function getAgentActivityForStream(workspaceId: string, streamId: string): readonly ActiveAgentSession[] {
  return keySnapshots.get(subKey(workspaceId, streamId)) ?? EMPTY
}

/**
 * The agent sessions running directly in `streamId`, most recently started
 * first; empty when idle. Reactive per-row read for the sidebar — subscribes
 * only to this stream's slice, so parent and thread activity stay independent.
 */
export function useAgentActivityForStream(
  workspaceId: string | undefined,
  streamId: string | undefined
): readonly ActiveAgentSession[] {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!workspaceId || !streamId) return () => {}
      const key = subKey(workspaceId, streamId)
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
    },
    [workspaceId, streamId]
  )
  const getSnapshot = useCallback(
    () => (workspaceId && streamId ? getAgentActivityForStream(workspaceId, streamId) : EMPTY),
    [workspaceId, streamId]
  )
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Test-only: wipe all state between cases. */
export function __resetAgentActivityStore(): void {
  workspaces.clear()
  keyListeners.clear()
  keySnapshots.clear()
}
