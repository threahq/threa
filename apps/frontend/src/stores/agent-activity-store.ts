import { useCallback, useMemo, useRef, useSyncExternalStore } from "react"
import type { ActiveAgentSession, StreamEvent } from "@threa/types"
import { deriveAgentSessionLifecycle, type AgentSessionLifecycle } from "@/lib/agent-session-lifecycle"

/**
 * Ephemeral, non-persisted store of the agent sessions running RIGHT NOW,
 * keyed by their exact stream so a stream row can paint an "agent working"
 * state without inheriting activity from a parent or child. A full workspace
 * bootstrap seeds `activeAgentSessions`. Stream bootstraps reconcile the same
 * cached lifecycle events that drive the open timeline, while live starts/ends
 * fold in from the `agent_session:*` room events (INV-53). Removal is by session
 * id (stream-agnostic) so a terminal event clears every surface regardless of
 * which path observed it.
 *
 * Not in IDB: this is transient presence, not durable state — a cold reload
 * re-derives it from the fresh bootstrap.
 */

// workspaceId -> sessionId -> session
const workspaces = new Map<string, Map<string, ActiveAgentSession>>()
// Terminal events are final for a session id. Keep enough recent ids to fence
// in-flight snapshots and duplicate delivery without retaining page-lifetime history.
const TERMINAL_FENCE_LIMIT = 1024
const terminalSessions = new Map<string, Set<string>>()

// `${workspaceId}:${streamId}` -> listeners subscribed to that row
const keyListeners = new Map<string, Set<() => void>>()
// Content-stable snapshot per key (referential stability for useSyncExternalStore)
const keySnapshots = new Map<string, ActiveAgentSession[]>()
// `${workspaceId}:${sessionId}` -> listeners subscribed to that one session
const sessionListeners = new Map<string, Set<() => void>>()

const EMPTY: readonly ActiveAgentSession[] = Object.freeze([])

function subKey(workspaceId: string, streamId: string): string {
  return `${workspaceId}:${streamId}`
}

function sameSession(a: ActiveAgentSession, b: ActiveAgentSession): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.streamId === b.streamId &&
    a.rootStreamId === b.rootStreamId &&
    a.personaName === b.personaName &&
    a.stepCount === b.stepCount &&
    a.messageCount === b.messageCount &&
    a.substep === b.substep
  )
}

/**
 * Identity only — no progress fields. The stream-key snapshot compares with this
 * so a progress/substep tick (several per second in a research loop) cannot churn
 * the array every sidebar row subscribes to; by-id subscribers still get every
 * tick through `notifySession`.
 */
function sameSessionIdentity(a: ActiveAgentSession, b: ActiveAgentSession): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.streamId === b.streamId &&
    a.rootStreamId === b.rootStreamId &&
    a.personaName === b.personaName
  )
}

/** Exactly what a board card's running chip renders. */
function sameSessionChip(a: ActiveAgentSession, b: ActiveAgentSession): boolean {
  return a.sessionId === b.sessionId && a.personaName === b.personaName && a.stepCount === b.stepCount
}

function sameList(
  a: readonly ActiveAgentSession[],
  b: readonly ActiveAgentSession[],
  equal: (x: ActiveAgentSession, y: ActiveAgentSession) => boolean
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && !equal(a[i], b[i])) return false
  }
  return true
}

function notifySession(workspaceId: string, sessionId: string): void {
  for (const listener of sessionListeners.get(subKey(workspaceId, sessionId)) ?? []) listener()
}

function isTerminalSession(workspaceId: string, sessionId: string): boolean {
  return terminalSessions.get(workspaceId)?.has(sessionId) ?? false
}

function markTerminalSession(workspaceId: string, sessionId: string): void {
  let sessions = terminalSessions.get(workspaceId)
  if (!sessions) {
    sessions = new Set()
    terminalSessions.set(workspaceId, sessions)
  }
  sessions.delete(sessionId)
  sessions.add(sessionId)
  if (sessions.size <= TERMINAL_FENCE_LIMIT) return
  const oldest = sessions.values().next().value
  if (oldest !== undefined) sessions.delete(oldest)
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
    if (prev && sameList(prev, sessions, sameSessionIdentity)) return
    keySnapshots.set(key, sessions)
  }
  for (const listener of keyListeners.get(key) ?? []) listener()
}

/**
 * Replace the whole running set for a workspace (bootstrap / reconnect re-seed).
 * Membership is authoritative — an entry absent from the seed is dropped (INV-53).
 * Progress the seed doesn't carry (the bootstrap projection has no
 * `stepCount`/`messageCount`/`substep`) keeps the tracked value, so a reconnect
 * re-seed can't reset a still-running session's counts to undefined.
 */
export function seedAgentActivity(workspaceId: string, sessions: ActiveAgentSession[]): void {
  const previous = workspaces.get(workspaceId)
  const affectedStreams = new Set<string>()
  for (const entry of previous?.values() ?? []) affectedStreams.add(entry.streamId)

  const next = new Map<string, ActiveAgentSession>()
  const affectedSessions = new Set<string>(previous?.keys() ?? [])
  for (const session of sessions) {
    if (isTerminalSession(workspaceId, session.sessionId)) continue
    const existing = previous?.get(session.sessionId)
    next.set(session.sessionId, {
      ...session,
      stepCount: session.stepCount ?? existing?.stepCount,
      messageCount: session.messageCount ?? existing?.messageCount,
      substep: session.substep ?? existing?.substep,
    })
    affectedStreams.add(session.streamId)
    affectedSessions.add(session.sessionId)
  }
  workspaces.set(workspaceId, next)

  for (const streamId of affectedStreams) recomputeKey(workspaceId, streamId)
  for (const sessionId of affectedSessions) notifySession(workspaceId, sessionId)
}

/**
 * Add or refresh one running session (live `started`/`progress`). Progress fields
 * the incoming event doesn't carry (`stepCount`/`messageCount`/`substep` are
 * absent on `started`/`activity_started` and on the bootstrap projection) keep the
 * value already tracked, so a late `started` can't wipe counts a progress tick
 * already delivered.
 */
export function upsertAgentSession(workspaceId: string, session: ActiveAgentSession): void {
  if (isTerminalSession(workspaceId, session.sessionId)) return
  let ws = workspaces.get(workspaceId)
  if (!ws) {
    ws = new Map()
    workspaces.set(workspaceId, ws)
  }
  const existing = ws.get(session.sessionId)
  const next: ActiveAgentSession = {
    ...session,
    stepCount:
      session.stepCount === undefined || existing?.stepCount === undefined
        ? (session.stepCount ?? existing?.stepCount)
        : Math.max(session.stepCount, existing.stepCount),
    messageCount:
      session.messageCount === undefined || existing?.messageCount === undefined
        ? (session.messageCount ?? existing?.messageCount)
        : Math.max(session.messageCount, existing.messageCount),
    substep: session.substep ?? existing?.substep,
  }
  if (existing && sameSession(existing, next)) return
  ws.set(session.sessionId, next)
  if (existing && existing.streamId !== next.streamId) {
    recomputeKey(workspaceId, existing.streamId)
  }
  recomputeKey(workspaceId, next.streamId)
  notifySession(workspaceId, next.sessionId)
}

/**
 * Fold a live progress tick into an already-tracked session. No-op for an
 * untracked id — the caller upserts in that case (it needs the resolved root
 * stream, which this path deliberately avoids re-reading per step). A step
 * advance drops the previous step's substep, which is stale by definition.
 */
export function updateAgentSessionProgress(
  workspaceId: string,
  sessionId: string,
  progress: { stepCount?: number; messageCount?: number; substep?: string | null }
): void {
  const ws = workspaces.get(workspaceId)
  const existing = ws?.get(sessionId)
  if (!ws || !existing) return
  const stepCount = progress.stepCount ?? existing.stepCount
  const stepAdvanced = progress.stepCount !== undefined && progress.stepCount !== existing.stepCount
  let substep = existing.substep
  if (progress.substep !== undefined) substep = progress.substep
  else if (stepAdvanced) substep = null
  const next: ActiveAgentSession = {
    ...existing,
    stepCount,
    messageCount: progress.messageCount ?? existing.messageCount,
    substep,
  }
  if (sameSession(existing, next)) return
  ws.set(sessionId, next)
  recomputeKey(workspaceId, next.streamId)
  notifySession(workspaceId, sessionId)
}

/** Remove a session by id on any terminal signal. */
export function removeAgentSession(workspaceId: string, sessionId: string): void {
  markTerminalSession(workspaceId, sessionId)
  const ws = workspaces.get(workspaceId)
  const existing = ws?.get(sessionId)
  if (!ws || !existing) return
  ws.delete(sessionId)
  recomputeKey(workspaceId, existing.streamId)
  notifySession(workspaceId, sessionId)
}

export function reconcileAgentActivityFromStreamEvents(
  workspaceId: string,
  streamId: string,
  rootStreamId: string,
  events: readonly StreamEvent[]
): void {
  reconcileAgentActivityFromStreamLifecycle(workspaceId, streamId, rootStreamId, deriveAgentSessionLifecycle(events))
}

export function removeTerminatedAgentActivity(workspaceId: string, lifecycle: AgentSessionLifecycle): void {
  for (const sessionId of lifecycle.terminated) removeAgentSession(workspaceId, sessionId)
}

export function reconcileAgentActivityFromStreamLifecycle(
  workspaceId: string,
  streamId: string,
  rootStreamId: string,
  lifecycle: AgentSessionLifecycle
): void {
  removeTerminatedAgentActivity(workspaceId, lifecycle)
  for (const session of lifecycle.running.values()) {
    upsertAgentSession(workspaceId, {
      sessionId: session.sessionId,
      streamId,
      rootStreamId,
      personaName: session.personaName,
      startedAt: session.startedAt,
      stepCount: session.stepCount,
      messageCount: session.messageCount,
    })
  }
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

/** Non-reactive read of one running session by id; undefined when not running. */
export function getAgentSession(workspaceId: string, sessionId: string): ActiveAgentSession | undefined {
  return workspaces.get(workspaceId)?.get(sessionId)
}

function subscribeSessions(workspaceId: string | undefined, sessionIds: readonly string[]) {
  return (onChange: () => void) => {
    if (!workspaceId) return () => {}
    const keys = sessionIds.map((id) => subKey(workspaceId, id))
    for (const key of keys) {
      let set = sessionListeners.get(key)
      if (!set) {
        set = new Set()
        sessionListeners.set(key, set)
      }
      set.add(onChange)
    }
    return () => {
      for (const key of keys) {
        const set = sessionListeners.get(key)
        if (!set) continue
        set.delete(onChange)
        if (set.size === 0) sessionListeners.delete(key)
      }
    }
  }
}

/**
 * Reactive read of ONE session's live state by id — the board's running-session
 * row reads its own session here instead of keeping a workspace-wide subscription
 * per row, so an unrelated session's tick doesn't re-render it.
 */
export function useAgentSessionActivity(
  workspaceId: string | undefined,
  sessionId: string | null | undefined
): ActiveAgentSession | undefined {
  const ids = useMemo(() => (sessionId ? [sessionId] : []), [sessionId])
  const subscribe = useMemo(() => subscribeSessions(workspaceId, ids), [workspaceId, ids])
  const getSnapshot = useCallback(
    () => (workspaceId && sessionId ? getAgentSession(workspaceId, sessionId) : undefined),
    [workspaceId, sessionId]
  )
  return useSyncExternalStore(subscribe, getSnapshot)
}

/**
 * Reactive read of a caller-chosen SET of sessions (a board card's own
 * conversation rows), most recently started first, skipping ids that aren't
 * running. Scoping by id — not by stream — is what keeps a sibling conversation's
 * agent off this card.
 */
export function useAgentSessionActivities(
  workspaceId: string | undefined,
  sessionIds: readonly string[]
): readonly ActiveAgentSession[] {
  const key = sessionIds.join(",")
  const ids = useMemo(() => (key ? key.split(",") : []), [key])
  const subscribe = useMemo(() => subscribeSessions(workspaceId, ids), [workspaceId, ids])
  const cache = useRef<readonly ActiveAgentSession[]>(EMPTY)
  const getSnapshot = useCallback(() => {
    const next = workspaceId
      ? ids
          .map((id) => getAgentSession(workspaceId, id))
          .filter((entry): entry is ActiveAgentSession => entry !== undefined)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      : []
    if (next.length === 0) {
      cache.current = EMPTY
      return EMPTY
    }
    if (sameList(cache.current, next, sameSessionChip)) return cache.current
    cache.current = next
    return next
  }, [workspaceId, ids])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Test-only: wipe all state between cases. */
export function __resetAgentActivityStore(): void {
  workspaces.clear()
  terminalSessions.clear()
  keyListeners.clear()
  keySnapshots.clear()
  sessionListeners.clear()
}
