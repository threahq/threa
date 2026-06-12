import type { WorkspaceBootstrap } from "@threa/types"

/**
 * Pure state math for the unread counter family (sync-v2 phase 2c).
 *
 * The four counter events (`stream:activity`, `stream:read`,
 * `stream:read_all`, `activity:created`) carry ABSOLUTE values so clients set
 * counters instead of incrementing — replayed and duplicated events converge.
 * Per stream the client keeps one number pair: the latest message ordinal
 * (`latestOrdinals`, the stream's total message count) and the unread count.
 * The read position is implicit — `lastReadOrdinal = latestOrdinal − unread`
 * — so every pre-existing code path that "zeroes the unread count" (local
 * mark-as-read, legacy event fallbacks) stays coherent for free: zeroing
 * unread IS advancing the read position to latest.
 *
 * Merge disciplines (PR #872 design decisions):
 * - Stream ordinals MAX-MERGE. They are monotonic stream facts, so duplicate
 *   and out-of-order applies (sweep-rescued late sync ids) converge without
 *   extra bookkeeping.
 * - Activity/mention counts LWW-SET in delivery order. They can legitimately
 *   DECREASE (reaction removal deletes activity rows and emits no
 *   compensating event), so a plain set is the only safe apply.
 * - `unreadActivityCount` is never on the wire: it is derived as
 *   Σ activityCounts whenever an absolute apply touches activity counts.
 *
 * Events missing the absolute fields are legacy: sync-log entries persisted
 * before the backend shipped the fields replay without them forever (no log
 * retention exists). `isLegacyUnreadCounterEntry` detects them so catch-up
 * can skip them (bootstrap stays their authority) while live handlers fall
 * back to the old increment/zero behavior.
 */

export interface UnreadCounterState {
  unreadCounts: Record<string, number>
  mentionCounts: Record<string, number>
  activityCounts: Record<string, number>
  unreadActivityCount: number
  /**
   * Latest message ordinal per stream, seeded from bootstrap `messageCounts`
   * and max-merged from `stream:activity.messageOrdinal`. A missing entry
   * means no baseline yet (snapshot predates the field); appliers seed it
   * from the first absolute event they see.
   */
  latestOrdinals?: Record<string, number>
}

function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0)
}

/**
 * Apply a `stream:activity` message ordinal. Latest max-merges; the implied
 * read position advances to the message for the author's own sends (the
 * server auto-advances the author's read pointer in the send transaction
 * without emitting `stream:read`) and pins to latest while the user is
 * viewing the stream (optimistic — auto-mark-read confirms server-side).
 *
 * Without a baseline the event seeds one: others' messages land as the
 * legacy increment would have; own/viewing land read = latest.
 */
export function applyStreamActivityOrdinal(
  state: UnreadCounterState,
  streamId: string,
  messageOrdinal: number,
  opts: { isOwnMessage: boolean; isViewing: boolean }
): UnreadCounterState {
  const prevLatest = state.latestOrdinals?.[streamId]
  let latest: number
  let read: number
  if (prevLatest === undefined) {
    latest = messageOrdinal
    read = opts.isOwnMessage || opts.isViewing ? latest : Math.max(0, latest - (state.unreadCounts[streamId] ?? 0) - 1)
  } else {
    const prevRead = Math.max(0, prevLatest - (state.unreadCounts[streamId] ?? 0))
    latest = Math.max(prevLatest, messageOrdinal)
    read = opts.isOwnMessage ? Math.max(prevRead, messageOrdinal) : prevRead
    if (opts.isViewing) read = latest
  }
  return {
    ...state,
    latestOrdinals: { ...state.latestOrdinals, [streamId]: latest },
    unreadCounts: { ...state.unreadCounts, [streamId]: Math.max(0, latest - read) },
  }
}

/**
 * Apply a `stream:read` absolute read position. The read position max-merges
 * (a stale read event can never regress unread); a read position ahead of
 * the locally-known latest is itself a lower bound on latest. Messages that
 * arrived after the read position stay unread — strictly better than the
 * legacy unconditional zero, which over-cleared when a message raced the
 * read event. Mention/activity counts zero in delivery order (the backend
 * clears the stream's activity rows on mark-as-read), LWW like all activity
 * counts.
 */
export function applyStreamReadOrdinal(
  state: UnreadCounterState,
  streamId: string,
  lastReadOrdinal: number
): UnreadCounterState {
  const prevLatest = state.latestOrdinals?.[streamId]
  const latest = Math.max(prevLatest ?? 0, lastReadOrdinal)
  const prevRead =
    prevLatest === undefined ? lastReadOrdinal : Math.max(0, prevLatest - (state.unreadCounts[streamId] ?? 0))
  const read = Math.max(prevRead, lastReadOrdinal)
  const activityCounts = { ...state.activityCounts, [streamId]: 0 }
  return {
    ...state,
    latestOrdinals: { ...state.latestOrdinals, [streamId]: latest },
    unreadCounts: { ...state.unreadCounts, [streamId]: Math.max(0, latest - read) },
    mentionCounts: { ...state.mentionCounts, [streamId]: 0 },
    activityCounts,
    unreadActivityCount: sumCounts(activityCounts),
  }
}

/** Apply a `stream:read_all` reads array — per-stream `applyStreamReadOrdinal`. */
export function applyStreamsReadAllOrdinals(
  state: UnreadCounterState,
  reads: Array<{ streamId: string; lastReadOrdinal: number }>
): UnreadCounterState {
  let next = state
  for (const read of reads) {
    next = applyStreamReadOrdinal(next, read.streamId, read.lastReadOrdinal)
  }
  return next
}

/**
 * Apply an `activity:created` absolute count pair for the target user's
 * stream (LWW set), rederiving the workspace total as Σ activityCounts.
 */
export function applyActivityCounts(
  state: UnreadCounterState,
  streamId: string,
  counts: { mentionCount: number; activityCount: number }
): UnreadCounterState {
  const activityCounts = { ...state.activityCounts, [streamId]: counts.activityCount }
  return {
    ...state,
    mentionCounts: { ...state.mentionCounts, [streamId]: counts.mentionCount },
    activityCounts,
    unreadActivityCount: sumCounts(activityCounts),
  }
}

/** The counter slice of a workspace bootstrap (`messageCounts` are the latest ordinals). */
export function toCounterState(bootstrap: WorkspaceBootstrap): UnreadCounterState {
  return {
    unreadCounts: bootstrap.unreadCounts,
    mentionCounts: bootstrap.mentionCounts,
    activityCounts: bootstrap.activityCounts,
    unreadActivityCount: bootstrap.unreadActivityCount,
    latestOrdinals: bootstrap.messageCounts,
  }
}

/** Write a counter slice back onto a workspace bootstrap object. */
export function withCounterState(bootstrap: WorkspaceBootstrap, state: UnreadCounterState): WorkspaceBootstrap {
  return {
    ...bootstrap,
    unreadCounts: state.unreadCounts,
    mentionCounts: state.mentionCounts,
    activityCounts: state.activityCounts,
    unreadActivityCount: state.unreadActivityCount,
    messageCounts: state.latestOrdinals,
  }
}

/**
 * True when this is one of the four unread counter events AND its payload
 * lacks the absolute fields — a sync-log entry persisted before the backend
 * shipped them (or a live emit from a not-yet-upgraded backend). Catch-up
 * skips these (the cursor still advances past them; the bootstrap remains
 * their authority, INV-53) and the gate splice applies their buffered live
 * copies regardless of position, exactly as the phase-2b skip set did.
 * Non-counter event types are never legacy. This fallback dies when sync-log
 * retention ships and pre-field entries age out.
 */
export function isLegacyUnreadCounterEntry(eventType: string, payload: unknown): boolean {
  const p = payload as Record<string, unknown> | null | undefined
  switch (eventType) {
    case "stream:activity":
      return typeof p?.messageOrdinal !== "number"
    case "stream:read":
      return typeof p?.lastReadOrdinal !== "number"
    case "stream:read_all":
      return !Array.isArray(p?.reads)
    case "activity:created": {
      const counts = p?.counts as Record<string, unknown> | null | undefined
      return typeof counts?.mentionCount !== "number" || typeof counts?.activityCount !== "number"
    }
    default:
      return false
  }
}
