import { useCallback, useMemo, useRef, useSyncExternalStore } from "react"
import { StreamTypes } from "@threahq/types"
import type { ActiveAgentSession, AgentStepType, StreamEvent, StreamType } from "@threahq/types"
import { deriveAgentSessionLifecycle, type AgentSessionLifecycle } from "@/lib/agent-session-lifecycle"

/**
 * Ephemeral, non-persisted store of the agent sessions running RIGHT NOW,
 * keyed by their exact stream so a stream row can paint an "agent working"
 * state without inheriting activity from a parent or child. The same sessions
 * are keyed a second way, by the timeline rows they hang under — `parentAnchorId`
 * (the parent-timeline row a thread session hangs off) and `triggerMessageId` —
 * so a row can paint a session that runs in another stream. A full workspace
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

// `${workspaceId}:${sessionId}` -> listeners subscribed to that one session
const sessionListeners = new Map<string, Set<() => void>>()

const EMPTY: readonly ActiveAgentSession[] = Object.freeze([])

function subKey(workspaceId: string, id: string): string {
  return `${workspaceId}:${id}`
}

/**
 * One keyed view over the running set. `equal` decides whether a recompute is
 * worth notifying; `snapshots` holds one content-stable array per key
 * (referential stability for `useSyncExternalStore`).
 */
type SessionIndex = {
  keysOf: (session: ActiveAgentSession) => readonly string[]
  equal: (a: ActiveAgentSession, b: ActiveAgentSession) => boolean
  listeners: Map<string, Set<() => void>>
  snapshots: Map<string, ActiveAgentSession[]>
}

const byStream: SessionIndex = {
  keysOf: (session) => [session.streamId],
  equal: sameSessionIdentity,
  listeners: new Map(),
  snapshots: new Map(),
}

const byAnchor: SessionIndex = {
  keysOf: anchorKeysOf,
  // Full comparison, unlike the stream index: the thinking row under an anchor
  // renders the step type and `substep`, so a progress tick has to reach it.
  equal: sameSession,
  listeners: new Map(),
  snapshots: new Map(),
}

const INDEXES = [byStream, byAnchor] as const

/** The timeline rows a session hangs under: its parent anchor and its trigger. */
function anchorKeysOf(session: ActiveAgentSession): string[] {
  const ids: string[] = []
  if (session.parentAnchorId) ids.push(session.parentAnchorId)
  if (session.triggerMessageId && session.triggerMessageId !== session.parentAnchorId) {
    ids.push(session.triggerMessageId)
  }
  return ids
}

/**
 * Every rendered field, plus the anchors — those are index keys, and
 * `upsertAgentSession` early-returns on this, so leaving them out would let an
 * upsert that moves a session between anchor rows be swallowed.
 */
function sameSession(a: ActiveAgentSession, b: ActiveAgentSession): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.streamId === b.streamId &&
    a.rootStreamId === b.rootStreamId &&
    a.personaName === b.personaName &&
    a.parentAnchorId === b.parentAnchorId &&
    a.triggerMessageId === b.triggerMessageId &&
    a.currentStepType === b.currentStepType &&
    a.stepCount === b.stepCount &&
    a.messageCount === b.messageCount &&
    a.substep === b.substep
  )
}

/**
 * Identity and keys — no progress fields. The stream-key snapshot compares with
 * this so a progress/substep tick (several per second in a research loop) cannot
 * churn the array every sidebar row subscribes to; by-id subscribers still get
 * every tick through `notifySession`.
 */
function sameSessionIdentity(a: ActiveAgentSession, b: ActiveAgentSession): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.streamId === b.streamId &&
    a.rootStreamId === b.rootStreamId &&
    a.personaName === b.personaName &&
    a.parentAnchorId === b.parentAnchorId &&
    a.triggerMessageId === b.triggerMessageId
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

/** Recompute the cached snapshot for one key and notify iff its content changed. */
function recompute(index: SessionIndex, workspaceId: string, id: string): void {
  const key = subKey(workspaceId, id)
  const sessions = [...(workspaces.get(workspaceId)?.values() ?? [])]
    .filter((entry) => index.keysOf(entry).includes(id))
    // Most-recently-started first: the row's primary label picks [0].
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))

  const prev = index.snapshots.get(key)
  if (sessions.length === 0) {
    if (prev === undefined) return
    index.snapshots.delete(key)
  } else {
    if (prev && sameList(prev, sessions, index.equal)) return
    index.snapshots.set(key, sessions)
  }
  for (const listener of index.listeners.get(key) ?? []) listener()
}

/** Refresh every key the given entries appear under, in every index. */
function recomputeFor(workspaceId: string, entries: readonly (ActiveAgentSession | undefined)[]): void {
  for (const index of INDEXES) {
    const ids = new Set<string>()
    for (const entry of entries) {
      if (!entry) continue
      for (const id of index.keysOf(entry)) ids.add(id)
    }
    for (const id of ids) recompute(index, workspaceId, id)
  }
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
  const next = new Map<string, ActiveAgentSession>()
  const affectedSessions = new Set<string>(previous?.keys() ?? [])
  for (const session of sessions) {
    if (isTerminalSession(workspaceId, session.sessionId)) continue
    const existing = previous?.get(session.sessionId)
    next.set(session.sessionId, {
      ...session,
      parentAnchorId: session.parentAnchorId ?? existing?.parentAnchorId ?? null,
      triggerMessageId: session.triggerMessageId ?? existing?.triggerMessageId,
      currentStepType: session.currentStepType ?? existing?.currentStepType,
      stepCount: session.stepCount ?? existing?.stepCount,
      messageCount: session.messageCount ?? existing?.messageCount,
      substep: session.substep ?? existing?.substep,
    })
    affectedSessions.add(session.sessionId)
  }
  workspaces.set(workspaceId, next)

  recomputeFor(workspaceId, [...(previous?.values() ?? []), ...next.values()])
  for (const sessionId of affectedSessions) notifySession(workspaceId, sessionId)
}

/**
 * Add or refresh one running session (live `started`/`progress`). Progress fields
 * the incoming event doesn't carry (`stepCount`/`messageCount`/`substep` are
 * absent on `started`/`activity_started` and on the bootstrap projection) keep the
 * value already tracked, so a late `started` can't wipe counts a progress tick
 * already delivered. The anchor fields are kept the same way: a stream row cached
 * by an older bundle carries neither anchor field, so a reconcile off that row
 * must not null out an anchor the workspace bootstrap already resolved.
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
    parentAnchorId: session.parentAnchorId ?? existing?.parentAnchorId ?? null,
    triggerMessageId: session.triggerMessageId ?? existing?.triggerMessageId,
    currentStepType: session.currentStepType ?? existing?.currentStepType,
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
  recomputeFor(workspaceId, [existing, next])
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
  progress: {
    stepCount?: number
    messageCount?: number
    substep?: string | null
    currentStepType?: AgentStepType
  }
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
    currentStepType: progress.currentStepType ?? existing.currentStepType,
    stepCount,
    messageCount: progress.messageCount ?? existing.messageCount,
    substep,
  }
  if (sameSession(existing, next)) return
  ws.set(sessionId, next)
  recomputeFor(workspaceId, [existing, next])
  notifySession(workspaceId, sessionId)
}

/** Stop the live indicator without fencing a retry that reuses the session id. */
export function clearAgentSession(workspaceId: string, sessionId: string): void {
  const ws = workspaces.get(workspaceId)
  const existing = ws?.get(sessionId)
  if (!ws || !existing) return
  ws.delete(sessionId)
  recomputeFor(workspaceId, [existing])
  notifySession(workspaceId, sessionId)
}

/** Remove a session by id on any terminal signal. */
export function removeAgentSession(workspaceId: string, sessionId: string): void {
  markTerminalSession(workspaceId, sessionId)
  clearAgentSession(workspaceId, sessionId)
}

/** Where a session found in a stream's events runs, and the row it hangs under. */
export type AgentActivityStreamContext = {
  streamId: string
  rootStreamId: string
  parentAnchorId: string | null
}

/**
 * Only a THREAD reports an anchor. An aside carries `parent_anchor_id` too, and
 * its companion is not the anchor row's reply — reporting it would light the host
 * message as working and point "Reply in thread" at the aside. Same rule the
 * backend applies in `parentActivityTarget` before it emits to the parent room.
 *
 * `parentMessageId` is the pre-`parentAnchorId` field name, still the only anchor
 * on IDB rows cached by an earlier bundle.
 */
export function agentActivityStreamContext(stream: {
  id: string
  type: StreamType
  rootStreamId: string | null
  parentAnchorId?: string | null
  parentMessageId?: string | null
}): AgentActivityStreamContext {
  const anchored = stream.type === StreamTypes.THREAD
  return {
    streamId: stream.id,
    rootStreamId: stream.rootStreamId ?? stream.id,
    parentAnchorId: anchored ? (stream.parentAnchorId ?? stream.parentMessageId ?? null) : null,
  }
}

export function reconcileAgentActivityFromStreamEvents(
  workspaceId: string,
  context: AgentActivityStreamContext,
  events: readonly StreamEvent[]
): void {
  reconcileAgentActivityFromStreamLifecycle(workspaceId, context, deriveAgentSessionLifecycle(events))
}

export function removeTerminatedAgentActivity(workspaceId: string, lifecycle: AgentSessionLifecycle): void {
  for (const sessionId of lifecycle.terminated) removeAgentSession(workspaceId, sessionId)
}

export function reconcileAgentActivityFromStreamLifecycle(
  workspaceId: string,
  context: AgentActivityStreamContext,
  lifecycle: AgentSessionLifecycle
): void {
  removeTerminatedAgentActivity(workspaceId, lifecycle)
  for (const session of lifecycle.running.values()) {
    upsertAgentSession(workspaceId, {
      sessionId: session.sessionId,
      streamId: context.streamId,
      rootStreamId: context.rootStreamId,
      parentAnchorId: context.parentAnchorId,
      triggerMessageId: session.triggerMessageId,
      personaName: session.personaName,
      startedAt: session.startedAt,
      currentStepType: session.currentStepType,
      stepCount: session.stepCount,
      messageCount: session.messageCount,
    })
  }
}

/** True if a session with this id is already tracked in the workspace. */
export function hasAgentSession(workspaceId: string, sessionId: string): boolean {
  return workspaces.get(workspaceId)?.has(sessionId) ?? false
}

function readIndex(index: SessionIndex, workspaceId: string, id: string): readonly ActiveAgentSession[] {
  return index.snapshots.get(subKey(workspaceId, id)) ?? EMPTY
}

function useIndex(
  index: SessionIndex,
  workspaceId: string | undefined,
  id: string | undefined
): readonly ActiveAgentSession[] {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!workspaceId || !id) return () => {}
      const key = subKey(workspaceId, id)
      let set = index.listeners.get(key)
      if (!set) {
        set = new Set()
        index.listeners.set(key, set)
      }
      set.add(onChange)
      return () => {
        set.delete(onChange)
        if (set.size === 0) index.listeners.delete(key)
      }
    },
    [index, workspaceId, id]
  )
  const getSnapshot = useCallback(
    () => (workspaceId && id ? readIndex(index, workspaceId, id) : EMPTY),
    [index, workspaceId, id]
  )
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Non-reactive read of a stream's running sessions (most recent first). */
export function getAgentActivityForStream(workspaceId: string, streamId: string): readonly ActiveAgentSession[] {
  return readIndex(byStream, workspaceId, streamId)
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
  return useIndex(byStream, workspaceId, streamId)
}

/** Non-reactive read of an anchor row's running sessions (most recent first). */
export function getAgentActivityForAnchor(workspaceId: string, anchorId: string): readonly ActiveAgentSession[] {
  return readIndex(byAnchor, workspaceId, anchorId)
}

/**
 * The agent sessions running under the timeline row `anchorId` — a thread
 * session hanging off that row, or a session triggered from it — most recently
 * started first; empty when idle.
 */
export function useAgentActivityForAnchor(
  workspaceId: string | undefined,
  anchorId: string | undefined
): readonly ActiveAgentSession[] {
  return useIndex(byAnchor, workspaceId, anchorId)
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

/** Drop every workspace's agent sessions — an account switch, or a test between cases. */
export function resetAgentActivityStore(): void {
  workspaces.clear()
  terminalSessions.clear()
  for (const index of INDEXES) {
    index.listeners.clear()
    index.snapshots.clear()
  }
  sessionListeners.clear()
}
