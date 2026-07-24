import type { Activity, WorkspaceBootstrap } from "@threa/types"

/**
 * Pure state math for the unread counter family.
 *
 * MESSAGE unread (`unreadCounts` + `latestOrdinals`) is an absolute ordinal
 * model (sync phase 2c): the read position is implicit as latestOrdinal −
 * unread, so zeroing unread == advancing read to latest. Ordinals max-merge
 * (monotonic stream facts); duplicate/out-of-order applies converge.
 *
 * ACTIVITY unread is DERIVED, not maintained. `unreadActivities` is the held
 * set of the viewer's unread activity rows (the source of truth); the
 * `activityCounts` / `mentionCounts` / `unreadActivityCount` fields are a pure
 * projection of it (`deriveActivityCounts`), recomputed on every change. A
 * derived count can never outrun the rows the feed can show, so a phantom badge
 * (a count with nothing behind it) is structurally impossible. Rows are keyed by
 * `Activity.id`, so a replayed `activity:created` upserts in place rather than
 * duplicating; coupling (reading a stream) drops that stream's rows; bootstrap
 * replaces the set wholesale, so any transient drift converges to server truth.
 * See docs/plans/activity-counters-derive-from-data.md.
 */

export interface UnreadCounterState {
  unreadCounts: Record<string, number>
  /** Held set of the viewer's unread activity rows — the source of truth for badge + glow. */
  unreadActivities: Activity[]
  /** Derived from `unreadActivities`: per-stream total unread. */
  activityCounts: Record<string, number>
  /** Derived from `unreadActivities`: per-stream mention-type unread. */
  mentionCounts: Record<string, number>
  /** Derived: `unreadActivities.length`. */
  unreadActivityCount: number
  /**
   * Latest message ordinal per stream, seeded from bootstrap `messageCounts`
   * and max-merged from `stream:activity.messageOrdinal`. A missing entry
   * means no baseline yet (snapshot predates the field); appliers seed it
   * from the first absolute event they see.
   */
  latestOrdinals?: Record<string, number>
  /**
   * Sparse read overlay per stream (docs/sparse-read-overlay-design.md): the
   * message ids read individually ABOVE that stream's watermark via a
   * conversation surface. The effective unread invariant everywhere is
   * `unreadCounts[s] = max(0, latestOrdinals[s] − read(s) − |overlay(s)|)`, with
   * the watermark reconstructed as `read = latest − unread − |overlay|`. An
   * absent entry means an empty overlay. `stream:read_messages` and the
   * `readMessageIds`-carrying read events SET the set absolutely (idempotent
   * under sync-log order); a `stream:read_all` clears it.
   */
  readMessageIds?: Record<string, string[]>
}

/** Size of a stream's sparse read overlay (0 when absent). */
function overlaySize(state: UnreadCounterState, streamId: string): number {
  return state.readMessageIds?.[streamId]?.length ?? 0
}

/**
 * SET a stream's overlay to an absolute snapshot. An empty snapshot drops the
 * key (empty overlays are omitted); a no-op returns the same reference so
 * unrelated appliers stay referentially stable.
 */
function setOverlay(state: UnreadCounterState, streamId: string, ids: string[]): UnreadCounterState {
  const current = state.readMessageIds?.[streamId]
  if (ids.length === 0) {
    if (current === undefined) return state
    const next = { ...state.readMessageIds }
    delete next[streamId]
    return { ...state, readMessageIds: next }
  }
  if (current === ids) return state
  return { ...state, readMessageIds: { ...state.readMessageIds, [streamId]: ids } }
}

/** Per-stream activity + mention counts (and total) derived from the held unread rows. */
export function deriveActivityCounts(rows: Activity[]): {
  activityCounts: Record<string, number>
  mentionCounts: Record<string, number>
  unreadActivityCount: number
} {
  const activityCounts: Record<string, number> = {}
  const mentionCounts: Record<string, number> = {}
  for (const row of rows) {
    if (!row.streamId) continue
    activityCounts[row.streamId] = (activityCounts[row.streamId] ?? 0) + 1
    if (row.activityType === "mention") {
      mentionCounts[row.streamId] = (mentionCounts[row.streamId] ?? 0) + 1
    }
  }
  return { activityCounts, mentionCounts, unreadActivityCount: rows.length }
}

/** Set the held activity rows and re-derive the count projection in one step. */
function withActivities(state: UnreadCounterState, rows: Activity[]): UnreadCounterState {
  return { ...state, unreadActivities: rows, ...deriveActivityCounts(rows) }
}

/**
 * Upsert an `activity:created` row into the held set, keyed by `id` so a
 * replayed event (sync-log catch-up, INV-53) updates in place instead of
 * duplicating. Self rows are never held — they don't count as unread.
 */
export function upsertActivity(state: UnreadCounterState, activity: Activity): UnreadCounterState {
  if (activity.isSelf) return state
  const rows = state.unreadActivities.filter((a) => a.id !== activity.id)
  rows.push(activity)
  return withActivities(state, rows)
}

/** Drop every held row for a stream — coupling: reading the stream clears its activity. */
export function dropActivitiesForStream(state: UnreadCounterState, streamId: string): UnreadCounterState {
  if (!state.unreadActivities.some((a) => a.streamId === streamId)) return state
  return withActivities(
    state,
    state.unreadActivities.filter((a) => a.streamId !== streamId)
  )
}

/**
 * Drop held rows by id — applied on `activity:read` (a read performed on
 * another device/session). Idempotent with this device's own optimistic
 * mutations: dropping ids already absent is a same-reference no-op.
 */
export function dropActivitiesById(state: UnreadCounterState, activityIds: readonly string[]): UnreadCounterState {
  if (activityIds.length === 0) return state
  const ids = new Set(activityIds)
  if (!state.unreadActivities.some((a) => ids.has(a.id))) return state
  return withActivities(
    state,
    state.unreadActivities.filter((a) => !ids.has(a.id))
  )
}

/** Drop the held reaction row matching a `reaction:removed` (message + actor + emoji). */
export function dropReactionActivity(
  state: UnreadCounterState,
  match: { messageId: string; actorId: string; emoji: string }
): UnreadCounterState {
  const rows = state.unreadActivities.filter(
    (a) =>
      !(
        a.activityType === "reaction" &&
        a.messageId === match.messageId &&
        a.actorId === match.actorId &&
        a.emoji === match.emoji
      )
  )
  if (rows.length === state.unreadActivities.length) return state
  return withActivities(state, rows)
}

/** Re-home held rows from a moved message's source stream to its destination. */
export function rehomeActivities(
  state: UnreadCounterState,
  fromStreamId: string,
  toStreamId: string,
  messageIds: readonly string[]
): UnreadCounterState {
  // `messages:moved` can move a subset of a stream's messages, so re-home only
  // the rows for the moved messages — not every row in the source stream.
  const moved = new Set(messageIds)
  const shouldRehome = (a: Activity): boolean =>
    a.streamId === fromStreamId && a.messageId !== null && moved.has(a.messageId)
  if (!state.unreadActivities.some(shouldRehome)) return state
  return withActivities(
    state,
    state.unreadActivities.map((a) => (shouldRehome(a) ? { ...a, streamId: toStreamId } : a))
  )
}

/** Clear the held set — mark-all-read. */
export function clearActivities(state: UnreadCounterState): UnreadCounterState {
  if (state.unreadActivities.length === 0) return state
  return withActivities(state, [])
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
  const ov = overlaySize(state, streamId)
  const prevLatest = state.latestOrdinals?.[streamId]
  let latest: number
  let read: number
  if (prevLatest === undefined) {
    latest = messageOrdinal
    read =
      opts.isOwnMessage || opts.isViewing ? latest : Math.max(0, latest - (state.unreadCounts[streamId] ?? 0) - 1 - ov)
  } else {
    const prevRead = Math.max(0, prevLatest - (state.unreadCounts[streamId] ?? 0) - ov)
    latest = Math.max(prevLatest, messageOrdinal)
    read = opts.isOwnMessage ? Math.max(prevRead, messageOrdinal) : prevRead
    if (opts.isViewing) read = latest
  }
  return {
    ...state,
    latestOrdinals: { ...state.latestOrdinals, [streamId]: latest },
    unreadCounts: { ...state.unreadCounts, [streamId]: Math.max(0, latest - read - ov) },
  }
}

/**
 * Apply a `stream:read` absolute read position. The read position max-merges
 * (a stale read event can never regress unread); a read position ahead of the
 * locally-known latest is itself a lower bound on latest. Messages that arrived
 * after the read position stay unread. Coupling (D2): reading the stream also
 * drops its held activity rows, so the derived activity/mention counts for it
 * fall to zero without a separate counter event.
 */
export function applyStreamReadOrdinal(
  state: UnreadCounterState,
  streamId: string,
  lastReadOrdinal: number,
  readMessageIds?: string[]
): UnreadCounterState {
  // Reconstruct the OLD watermark against the OLD overlay before the SET below,
  // since the stored unread was computed with the old overlay size.
  const prevOv = overlaySize(state, streamId)
  const prevLatest = state.latestOrdinals?.[streamId]
  const latest = Math.max(prevLatest ?? 0, lastReadOrdinal)
  const prevRead =
    prevLatest === undefined ? lastReadOrdinal : Math.max(0, prevLatest - (state.unreadCounts[streamId] ?? 0) - prevOv)
  const read = Math.max(prevRead, lastReadOrdinal)
  const withOverlay = readMessageIds !== undefined ? setOverlay(state, streamId, readMessageIds) : state
  const ov = overlaySize(withOverlay, streamId)
  // Coupling (D2): drop the stream's held activity on a read that is at or ahead
  // of the current position — this includes the caught-up D5 heal, where the read
  // does not advance (lastReadOrdinal === prevRead). A strictly stale/out-of-order
  // read (lastReadOrdinal < prevRead) must NOT wipe activity that arrived after
  // the real read.
  const next = lastReadOrdinal >= prevRead ? dropActivitiesForStream(withOverlay, streamId) : withOverlay
  return {
    ...next,
    latestOrdinals: { ...next.latestOrdinals, [streamId]: latest },
    unreadCounts: { ...next.unreadCounts, [streamId]: Math.max(0, latest - read - ov) },
  }
}

/**
 * Apply a `stream:read_set` absolute read position. Unlike
 * `applyStreamReadOrdinal`, the read position is SET, not max-merged: an
 * explicit "mark as unread" moves the pointer BACKWARD, so unread must be
 * allowed to rise. The latest ordinal is still a monotonic stream fact and
 * max-merges. Held activity rows are left untouched — restoring activity for a
 * re-unread range is a deliberate follow-up (see the design note's out-of-scope).
 */
export function applyStreamReadSet(
  state: UnreadCounterState,
  streamId: string,
  lastReadOrdinal: number,
  readMessageIds?: string[]
): UnreadCounterState {
  const withOverlay = readMessageIds !== undefined ? setOverlay(state, streamId, readMessageIds) : state
  const ov = overlaySize(withOverlay, streamId)
  const latest = Math.max(withOverlay.latestOrdinals?.[streamId] ?? 0, lastReadOrdinal)
  return {
    ...withOverlay,
    latestOrdinals: { ...withOverlay.latestOrdinals, [streamId]: latest },
    unreadCounts: { ...withOverlay.unreadCounts, [streamId]: Math.max(0, latest - lastReadOrdinal - ov) },
  }
}

/**
 * Apply a `stream:read_all` reads array — per-stream `applyStreamReadOrdinal`.
 * The server wipes overlay rows for every updated stream, so each read clears
 * that stream's overlay set (passing `[]`).
 */
export function applyStreamsReadAllOrdinals(
  state: UnreadCounterState,
  reads: Array<{ streamId: string; lastReadOrdinal: number }>
): UnreadCounterState {
  let next = state
  for (const read of reads) {
    next = applyStreamReadOrdinal(next, read.streamId, read.lastReadOrdinal, [])
  }
  return next
}

/**
 * Apply a `stream:read_messages` snapshot — the absolute post-write read state
 * for one stream from a conversation-surface read. SETs the overlay to the
 * snapshot (idempotent under sync-log order), max-merges the watermark ordinal
 * (a conversation read only advances it), and recomputes effective unread by
 * the invariant. Held activity is left untouched: a conversation read is a
 * partial stream read, so it must not wipe other conversations' activity rows —
 * the activity feed reconcile (`reconcileActivities`) is the badge backstop.
 */
export function applyStreamReadMessages(
  state: UnreadCounterState,
  streamId: string,
  snapshot: { readMessageIds: string[]; lastReadOrdinal: number }
): UnreadCounterState {
  const prevOv = overlaySize(state, streamId)
  const prevLatest = state.latestOrdinals?.[streamId]
  const latest = Math.max(prevLatest ?? 0, snapshot.lastReadOrdinal)
  const prevRead =
    prevLatest === undefined
      ? snapshot.lastReadOrdinal
      : Math.max(0, prevLatest - (state.unreadCounts[streamId] ?? 0) - prevOv)
  const read = Math.max(prevRead, snapshot.lastReadOrdinal)
  const withOverlay = setOverlay(state, streamId, snapshot.readMessageIds)
  const ov = snapshot.readMessageIds.length
  return {
    ...withOverlay,
    latestOrdinals: { ...withOverlay.latestOrdinals, [streamId]: latest },
    unreadCounts: { ...withOverlay.unreadCounts, [streamId]: Math.max(0, latest - read - ov) },
  }
}

/**
 * SET `latestOrdinals[streamId]` from a `messages:moved` source count (fix A1).
 * A move relocates `message_created` rows out of the source, so the source's
 * true latest ordinal DROPS — the one sanctioned non-monotonic latest write
 * (precedent: `applyStreamReadSet`). The reconstructed watermark stays put and
 * unread clamps at ≥ 0, so a phantom unread that stuck on max-merge-only
 * `latestOrdinals` heals immediately.
 */
export function applyMovedSourceOrdinal(
  state: UnreadCounterState,
  streamId: string,
  sourceMessageOrdinal: number,
  movedMessageIds: readonly string[] = []
): UnreadCounterState {
  // Reconstruct the read position with the PRE-move overlay, then drop the moved
  // ids from the source set before recomputing — the server rehomed their rows
  // to the destination, so a stale entry here keeps subtracting for a message
  // the shrunk latest no longer counts, silently hiding genuine unread. One
  // fold for both writes so no reader sees the ordinal without the drop.
  // (Destination overlay is deliberately NOT topped up: destination `latest`
  // isn't bumped on move either, so omitting both keeps its arithmetic
  // consistent-stale until the next snapshot/bootstrap heals it.)
  const ovBefore = overlaySize(state, streamId)
  const prevUnread = state.unreadCounts[streamId] ?? 0
  const base = state.latestOrdinals?.[streamId] ?? sourceMessageOrdinal
  const read = Math.max(0, base - prevUnread - ovBefore)

  const moved = new Set(movedMessageIds)
  const remaining = (state.readMessageIds?.[streamId] ?? []).filter((id) => !moved.has(id))
  const next = setOverlay(state, streamId, remaining)
  const ovAfter = overlaySize(next, streamId)

  return {
    ...next,
    latestOrdinals: { ...next.latestOrdinals, [streamId]: sourceMessageOrdinal },
    unreadCounts: { ...next.unreadCounts, [streamId]: Math.max(0, sourceMessageOrdinal - read - ovAfter) },
  }
}

/** Drop every held row for a deleted message (fix A2), mirroring `dropReactionActivity`. */
export function dropMessageActivities(state: UnreadCounterState, messageId: string): UnreadCounterState {
  const rows = state.unreadActivities.filter((a) => a.messageId !== messageId)
  if (rows.length === state.unreadActivities.length) return state
  return withActivities(state, rows)
}

/**
 * Wholesale-replace the held activity set with the server's authoritative rows
 * (fix A4 backstop): opening the unread activity feed reconciles the badge to
 * exactly what the feed shows. Self rows are dropped to match `upsertActivity`.
 */
export function reconcileActivities(state: UnreadCounterState, serverRows: Activity[]): UnreadCounterState {
  return withActivities(
    state,
    serverRows.filter((a) => !a.isSelf)
  )
}

/**
 * The activity fields for a persisted cache row, always derived from the
 * bootstrap's held rows so a persisted row can never carry counts that disagree
 * with its rows. A pre-rollout bootstrap without `unreadActivities` derives
 * zeros (the badge is briefly low but honest) and self-heals on the next
 * bootstrap that carries rows.
 */
export function bootstrapActivityCacheFields(bootstrap: WorkspaceBootstrap): {
  unreadActivities: Activity[]
  activityCounts: Record<string, number>
  mentionCounts: Record<string, number>
  unreadActivityCount: number
} {
  const rows = bootstrap.unreadActivities ?? []
  return { unreadActivities: rows, ...deriveActivityCounts(rows) }
}

/** Streams whose counter state (unread/ordinal/overlay/activity rows) differs between two states. */
export function diffCounterStreams(prev: UnreadCounterState, next: UnreadCounterState): Set<string> {
  const out = new Set<string>()
  if (prev === next) return out
  for (const record of [
    [prev.unreadCounts, next.unreadCounts],
    [prev.latestOrdinals ?? {}, next.latestOrdinals ?? {}],
  ] as const) {
    const [a, b] = record
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if ((a[id] ?? 0) !== (b[id] ?? 0)) out.add(id)
    }
  }
  const overlayIds = new Set([...Object.keys(prev.readMessageIds ?? {}), ...Object.keys(next.readMessageIds ?? {})])
  for (const id of overlayIds) {
    const a = prev.readMessageIds?.[id] ?? []
    const b = next.readMessageIds?.[id] ?? []
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) out.add(id)
  }
  const sig = (rows: Activity[]): Map<string, string> => {
    const byStream = new Map<string, string[]>()
    for (const row of rows) {
      if (row.streamId === null) continue
      const ids = byStream.get(row.streamId) ?? []
      ids.push(row.id)
      byStream.set(row.streamId, ids)
    }
    return new Map([...byStream].map(([id, ids]) => [id, ids.sort().join(" ")]))
  }
  const prevSig = sig(prev.unreadActivities)
  const nextSig = sig(next.unreadActivities)
  for (const id of new Set([...prevSig.keys(), ...nextSig.keys()])) {
    if (prevSig.get(id) !== nextSig.get(id)) out.add(id)
  }
  return out
}

/**
 * Keep only touch stamps at or after `since`. Older entries are dead weight:
 * every future bootstrap's `fetchStartedAt` is later, so they can never win a
 * merge again.
 */
export function pruneCounterTouches(
  touches: Record<string, number> | undefined,
  since: number | undefined
): Record<string, number> {
  if (!touches || since === undefined) return {}
  const out: Record<string, number> = {}
  for (const [streamId, touchedAt] of Object.entries(touches)) {
    if (touchedAt >= since) out[streamId] = touchedAt
  }
  return out
}

/** The local counter cache slice the bootstrap merge reads (structural subset of `CachedUnreadState`). */
export interface LocalCounterCache {
  unreadCounts: Record<string, number>
  unreadActivities?: Activity[]
  latestOrdinals?: Record<string, number>
  readMessageIds?: Record<string, string[]>
  mutedStreamIds: string[]
  /** Per-stream timestamp of the last local counter write — see `diffCounterStreams` stamping in `putCountersIdb`. */
  counterTouchedAt?: Record<string, number>
  /** Per-stream timestamp of the last local mute toggle — merged separately so a mute can't freeze counters. */
  mutedTouchedAt?: Record<string, number>
}

/**
 * Merge a workspace bootstrap's counter fields with the local cache,
 * PER STREAM: the server snapshot wins except for streams whose local counter
 * state was touched during the fetch window (a socket event or optimistic read
 * landed after `fetchStartedAt` — the snapshot may predate it, INV-20). The
 * old row-level `_cachedAt` skip let one busy stream veto the server's truth
 * for every stream, so a drifted local count could survive bootstraps for days.
 */
export function mergeBootstrapUnreadFields(
  bootstrap: WorkspaceBootstrap,
  local: LocalCounterCache | undefined,
  fetchStartedAt: number | undefined
): {
  unreadCounts: Record<string, number>
  unreadActivities: Activity[]
  activityCounts: Record<string, number>
  mentionCounts: Record<string, number>
  unreadActivityCount: number
  latestOrdinals: Record<string, number>
  readMessageIds: Record<string, string[]>
  mutedStreamIds: string[]
  counterTouchedAt: Record<string, number>
  mutedTouchedAt: Record<string, number>
} {
  const counterTouchedAt = pruneCounterTouches(local?.counterTouchedAt, fetchStartedAt)
  const mutedTouchedAt = pruneCounterTouches(local?.mutedTouchedAt, fetchStartedAt)
  const touched = new Set(Object.keys(counterTouchedAt))
  const muteTouched = new Set(Object.keys(mutedTouchedAt))
  if (!local || (touched.size === 0 && muteTouched.size === 0)) {
    return {
      unreadCounts: bootstrap.unreadCounts,
      ...bootstrapActivityCacheFields(bootstrap),
      latestOrdinals: bootstrap.messageCounts ?? {},
      readMessageIds: bootstrap.readMessageIds ?? {},
      mutedStreamIds: bootstrap.mutedStreamIds,
      counterTouchedAt,
      mutedTouchedAt,
    }
  }
  const unreadCounts = { ...bootstrap.unreadCounts }
  const latestOrdinals = { ...bootstrap.messageCounts }
  const readMessageIds = { ...bootstrap.readMessageIds }
  for (const streamId of touched) {
    unreadCounts[streamId] = local.unreadCounts[streamId] ?? 0
    // The triple stays paired: a stream keeping its local unread keeps its
    // local ordinal and overlay too — mixing sources shifts the implied read.
    const localOrdinal = local.latestOrdinals?.[streamId]
    if (localOrdinal !== undefined) latestOrdinals[streamId] = localOrdinal
    else delete latestOrdinals[streamId]
    const localOverlay = local.readMessageIds?.[streamId]
    if (localOverlay !== undefined) readMessageIds[streamId] = localOverlay
    else delete readMessageIds[streamId]
  }
  // Mute membership merges on its OWN freshness — a mute-only toggle must not
  // freeze the stream's counter triple, and counter writes must not carry a
  // stale local mute membership over the server's.
  const mutedStreamIds = new Set(bootstrap.mutedStreamIds)
  for (const streamId of muteTouched) {
    if (local.mutedStreamIds.includes(streamId)) mutedStreamIds.add(streamId)
    else mutedStreamIds.delete(streamId)
  }
  // Rows without a streamId can't be stream-touched — they stay server-sourced.
  const rows = [
    ...(bootstrap.unreadActivities ?? []).filter((a) => !a.isSelf && !(a.streamId !== null && touched.has(a.streamId))),
    ...(local.unreadActivities ?? []).filter((a) => a.streamId !== null && touched.has(a.streamId)),
  ]
  return {
    unreadCounts,
    unreadActivities: rows,
    ...deriveActivityCounts(rows),
    latestOrdinals,
    readMessageIds,
    mutedStreamIds: Array.from(mutedStreamIds),
    counterTouchedAt,
    mutedTouchedAt,
  }
}

/** The counter slice of a workspace bootstrap (`messageCounts` are the latest ordinals). */
export function toCounterState(bootstrap: WorkspaceBootstrap): UnreadCounterState {
  // `unreadActivities` is the activity source of truth; the count fields are
  // always its derived projection (a pre-rollout snapshot without rows derives
  // zeros and self-heals on the next bootstrap that carries rows).
  const rows = bootstrap.unreadActivities ?? []
  return {
    unreadCounts: bootstrap.unreadCounts,
    unreadActivities: rows,
    ...deriveActivityCounts(rows),
    latestOrdinals: bootstrap.messageCounts,
    readMessageIds: bootstrap.readMessageIds,
  }
}

/** Write a counter slice back onto a workspace bootstrap object. */
export function withCounterState(bootstrap: WorkspaceBootstrap, state: UnreadCounterState): WorkspaceBootstrap {
  return {
    ...bootstrap,
    unreadCounts: state.unreadCounts,
    unreadActivities: state.unreadActivities,
    mentionCounts: state.mentionCounts,
    activityCounts: state.activityCounts,
    unreadActivityCount: state.unreadActivityCount,
    messageCounts: state.latestOrdinals,
    readMessageIds: state.readMessageIds,
  }
}
