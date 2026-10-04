import Dexie from "dexie"
import { replaceEqualDeep } from "@tanstack/react-query"
import { useLiveQuery } from "dexie-react-hooks"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { db, sequenceToNum, type CachedEvent, type CachedStream } from "@/db"
import { getDraftPromotionEvents, releaseDraftPromotionEvents } from "@/lib/draft-promotions"
import { getPerfCapture } from "@/lib/perf/capture"
import { trackPendingRead } from "./apply-window"
import { getWorkspaceTableRow, hasResolvedSharedEntry, subscribeWorkspaceTableRow } from "./workspace-table-registry"

/**
 * Cap the number of events loaded from IDB per stream when no sequence floor
 * is known (initial load before bootstrap resolves). Once the caller provides
 * a floor, the floor itself bounds memory usage and the cap doesn't apply.
 */
const DEFAULT_IDB_EVENT_LIMIT = 150

/**
 * Size of the one unanchored tail read per stream visit — it sets where the tail
 * floor latches, and nothing else. The tail then grows by whatever arrives during
 * the visit and is never re-trimmed until the stream is re-entered; that additive
 * growth is the accepted price of a floor that never moves (see `useStreamEvents`).
 */
export const TIMELINE_TAIL_EVENTS = 200

/** No-op kept for clearAllCachedData compat; events live only in IDB now. */
export function resetStreamStoreCache(): void {}

/**
 * Read events for a stream from IndexedDB, sorted ASC by `_sequenceNum`.
 *
 * Single read path regardless of whether a floor is provided:
 *   - With a floor: range scan from the floor to maxKey, no count cap.
 *   - Without a floor: same range, but capped to the latest N events as a
 *     memory bound on initial pre-bootstrap load.
 *
 * Pending and failed optimistic events use the persisted sequence visible at
 * creation as their anchor. A pending send starts at the tail, then moves
 * upward naturally when newer server events arrive, without comparing client
 * and server clocks.
 */
export async function loadStreamEvents(
  workspaceId: string,
  streamId: string,
  fromSequenceNum: number | null
): Promise<CachedEvent[]> {
  const hasFloor = fromSequenceNum != null
  const lowerBound: [string, string, number] | [string, string, typeof Dexie.minKey] = hasFloor
    ? [workspaceId, streamId, fromSequenceNum]
    : [workspaceId, streamId, Dexie.minKey]
  const range = db.events
    .where("[workspaceId+streamId+_sequenceNum]")
    .between(lowerBound, [workspaceId, streamId, Dexie.maxKey], true, true)

  // With a floor we scan the compound index ASC directly — already in render
  // order. Without a floor we scan DESC + cap to the newest N as a memory bound
  // on the pre-bootstrap load, then sort ASC by `_sequenceNum`: the render
  // contract is ascending (INV-61), and the DESC cursor's materialised direction
  // can't be assumed, so an explicit comparison sort — not the cursor order — is
  // what guarantees it. Bounded by `DEFAULT_IDB_EVENT_LIMIT`, and `useLiveQuery`
  // re-runs the floored (sort-free) branch for every steady-state write, so the
  // cost lands only on the one pre-bootstrap read.
  let base: CachedEvent[]
  if (hasFloor) {
    base = await range.toArray()
  } else {
    base = await range.reverse().limit(DEFAULT_IDB_EVENT_LIMIT).toArray()
    base.sort((a, b) => a._sequenceNum - b._sequenceNum)
  }

  // Pending/failed optimistic events may have placeholder sequences outside the
  // scanned window (the current scheme uses `Date.now()`, so they sort to the
  // very top and are usually already in `base`). Drive this off the `_status`
  // index — Dexie only indexes rows where the value is present, so this is the
  // handful of unsent rows app-wide, not an O(history) scan of the stream.
  const unsentForStream = await loadUnsentStreamEvents(workspaceId, streamId, hasFloor ? fromSequenceNum : null)
  if (unsentForStream.length === 0) return base

  const loadedIds = new Set(base.map((e) => e.id))
  const extra = unsentForStream.filter((e) => !loadedIds.has(e.id))
  return orderStreamEvents([...base, ...extra])
}

async function loadUnsentStreamEvents(
  workspaceId: string,
  streamId: string,
  floor: number | null
): Promise<CachedEvent[]> {
  const unsent = await db.events.where("_status").anyOf(["pending", "failed", "editing"]).toArray()
  return unsent.filter(
    (e) => e.workspaceId === workspaceId && e.streamId === streamId && (floor === null || e._sequenceNum >= floor)
  )
}

/**
 * The bounded half of the split read: the newest events of a stream.
 *
 * Anchored (`tailFloor !== null`) the read is the plain range `[tailFloor,
 * maxKey]`, already ASC and already covering every unsent row that sits at or
 * above the floor — production optimistic rows carry `Date.now()` sequences, and
 * one whose placeholder lands below the floor is inside the prefix's range read
 * instead. No `_status` merge, so the two ranges stay disjoint by construction.
 *
 * Unanchored (`tailFloor === null`) it is the newest `TIMELINE_TAIL_EVENTS`
 * above `scanFloor`, scanned DESC and sorted ASC explicitly: the render contract
 * is ascending (INV-61) and the DESC cursor's materialised direction cannot be
 * assumed — the same standard `loadStreamEvents` holds itself to. This emission
 * exists only to latch the anchor, so it merges the `_status` index the same way
 * a capped read must.
 */
export async function loadStreamTail(
  workspaceId: string,
  streamId: string,
  tailFloor: number | null,
  scanFloor: number | null = null
): Promise<CachedEvent[]> {
  if (tailFloor !== null) {
    return await db.events
      .where("[workspaceId+streamId+_sequenceNum]")
      .between([workspaceId, streamId, tailFloor], [workspaceId, streamId, Dexie.maxKey], true, true)
      .toArray()
  }

  const base = await db.events
    .where("[workspaceId+streamId+_sequenceNum]")
    .between(
      scanFloor === null ? [workspaceId, streamId, Dexie.minKey] : [workspaceId, streamId, scanFloor],
      [workspaceId, streamId, Dexie.maxKey],
      true,
      true
    )
    .reverse()
    .limit(TIMELINE_TAIL_EVENTS)
    .toArray()
  base.sort((a, b) => a._sequenceNum - b._sequenceNum)

  const unsentForStream = await loadUnsentStreamEvents(workspaceId, streamId, scanFloor)
  if (unsentForStream.length === 0) return base

  const loadedIds = new Set(base.map((e) => e.id))
  const extra = unsentForStream.filter((e) => !loadedIds.has(e.id))
  return orderStreamEvents([...base, ...extra])
}

/**
 * The other half: everything the user paged in below the tail, `[floor,
 * tailFloor)`. Disjoint from the tail range by construction, which is what
 * makes a live message wake the tail alone (D1: Dexie's wake set is per index
 * range plus the pks a query returned, so a patch to a row this read holds
 * still wakes it).
 *
 * `tailFloor === null` is the pre-anchor emission and runs today's single
 * floored read verbatim, so the very first rendered window is byte-identical to
 * the unsplit one and the anchor resolves without a narrower frame in between.
 */
export async function loadStreamPrefix(
  workspaceId: string,
  streamId: string,
  floor: number | null,
  tailFloor: number | null
): Promise<CachedEvent[]> {
  if (tailFloor === null) return await loadStreamEvents(workspaceId, streamId, floor)
  return await db.events
    .where("[workspaceId+streamId+_sequenceNum]")
    .between(
      floor === null ? [workspaceId, streamId, Dexie.minKey] : [workspaceId, streamId, floor],
      [workspaceId, streamId, tailFloor],
      true,
      false
    )
    .toArray()
}

type OrderableStreamEvent = Pick<CachedEvent, "id" | "sequence" | "createdAt"> &
  Partial<Pick<CachedEvent, "_sequenceNum" | "_anchorSequenceNum" | "_status" | "_preEditStatus">>

function eventSequence(event: OrderableStreamEvent): number {
  return event._sequenceNum ?? sequenceToNum(event.sequence)
}

/** Pending or sent, not yet echoed, including a pending send held for editing. */
export function isInFlight(event: { _status?: string; _preEditStatus?: string }): boolean {
  if (event._status === "editing") return event._preEditStatus === "pending"
  return event._status === "pending" || event._status === "sent"
}

/**
 * Orders optimistic stream events among persisted ones. In-flight sends sit at
 * the tail, where their echo will land: the server sequences them after
 * everything the socket has already delivered, so a row arriving mid-send
 * belongs above them. Failed rows, and failed rows being edited, stay at their
 * persisted anchors.
 *
 * @param events - Persisted and optimistic events to order.
 * @param persistedComparator - Optional chronology for persisted events, such as thread ordering.
 * @returns A newly ordered event array.
 * @example
 * const ordered = orderStreamEvents(cachedEvents)
 */
export function orderStreamEvents<T extends OrderableStreamEvent>(
  events: T[],
  persistedComparator: (leftEvent: T, rightEvent: T) => number = (leftEvent, rightEvent) =>
    eventSequence(leftEvent) - eventSequence(rightEvent)
): T[] {
  const optimistic: T[] = []
  const persisted: T[] = []

  for (const event of events) {
    if (event._status != null) optimistic.push(event)
    else persisted.push(event)
  }

  const inferredAnchors = new Map<string, number>()
  for (const optimisticEvent of optimistic) {
    if (isInFlight(optimisticEvent) || optimisticEvent._anchorSequenceNum != null || persisted.length === 0) continue
    const optimisticCreatedAt = Date.parse(optimisticEvent.createdAt)
    const inferred = persisted.reduce<number | null>((current, persistedEvent) => {
      if (Date.parse(persistedEvent.createdAt) > optimisticCreatedAt) return current
      return Math.max(current ?? 0, eventSequence(persistedEvent))
    }, null)
    inferredAnchors.set(
      optimisticEvent.id,
      inferred ?? Math.max(0, Math.min(...persisted.map((persistedEvent) => eventSequence(persistedEvent))) - 1)
    )
  }
  const anchor = (event: OrderableStreamEvent) =>
    isInFlight(event)
      ? Number.POSITIVE_INFINITY
      : (event._anchorSequenceNum ?? inferredAnchors.get(event.id) ?? Number.POSITIVE_INFINITY)
  persisted.sort(persistedComparator)
  optimistic.sort(
    (leftEvent, rightEvent) =>
      anchor(leftEvent) - anchor(rightEvent) ||
      eventSequence(leftEvent) - eventSequence(rightEvent) ||
      leftEvent.id.localeCompare(rightEvent.id)
  )

  const optimisticAfterPersistedIndex = new Map<number, T[]>()
  for (const optimisticEvent of optimistic) {
    let afterIndex = -1
    for (let i = 0; i < persisted.length; i++) {
      if (eventSequence(persisted[i]) <= anchor(optimisticEvent)) afterIndex = i
    }
    const slot = optimisticAfterPersistedIndex.get(afterIndex) ?? []
    slot.push(optimisticEvent)
    optimisticAfterPersistedIndex.set(afterIndex, slot)
  }

  const ordered = [...(optimisticAfterPersistedIndex.get(-1) ?? [])]
  for (let i = 0; i < persisted.length; i++) {
    ordered.push(persisted[i], ...(optimisticAfterPersistedIndex.get(i) ?? []))
  }
  return ordered
}

/**
 * Union the two ranges into one rendered window. Both are ASC and disjoint
 * (`prefix < tailFloor <= tail`), so with no unsent rows present the union is a
 * concat — no Map, no dedupe, no re-sort. Only optimistic rows need
 * `orderStreamEvents`, which places them by status rather than at their
 * placeholder sequences; that is the same fast path `loadStreamEvents` takes.
 * An empty prefix still orders, so a failed row keeps its anchor there too.
 */
export function unionStreamRanges(prefix: CachedEvent[], tail: CachedEvent[]): CachedEvent[] {
  const combined = prefix.length === 0 ? tail : prefix.concat(tail)
  return combined.some((event) => event._status != null) ? orderStreamEvents(combined) : combined
}

/** A stamped read result: the workspace and stream it was read for, and the tail floor it was made under. */
export type StampedStreamEvents = CachedEvent[] & {
  __workspaceId?: string
  __streamId?: string
  __tailFloor?: number | null
}

export function stampStreamEvents(
  events: CachedEvent[],
  workspaceId: string,
  streamId: string | undefined,
  tailFloor: number | null = null
): StampedStreamEvents {
  // Copy before stamping: Dexie can hand two live queries the SAME result array
  // when their ranges coincide (an unanchored prefix and tail read under the
  // same floor do), and stamping in place would then rewrite the other read's
  // stamp — composing a window that unions one array with itself.
  const stamped = events.slice() as StampedStreamEvents
  stamped.__workspaceId = workspaceId
  if (streamId) stamped.__streamId = streamId
  stamped.__tailFloor = tailFloor
  return stamped
}

/**
 * Compose the rendered window from the two stamped reads, gating on BOTH stamps
 * rather than on the current anchor. Each arm records the tail floor it was read
 * under, and only two results read under the SAME floor abut: prefix `[floor,
 * F)` + tail `[F, max]`.
 *
 * Pre-latch (`F === null`) the prefix is today's whole floored read and the tail
 * is the unanchored capped scan that exists only to pick `F` — so the prefix
 * alone is the complete window, and unioning would duplicate.
 *
 * The gate that matters is the mid-latch skew: an unanchored tail's lower bound
 * moves with every arriving message, so pairing an anchored prefix `[floor, F)`
 * with a tail re-read as `[F+1, max]` drops sequence `F` and fabricates a hole
 * (INV-61). Unequal stamps mean the pair does not abut — hold the last complete
 * window instead, which is stale but contiguous.
 */
export function composeStreamWindow(
  prefix: StampedStreamEvents | undefined,
  tail: StampedStreamEvents | null,
  previousWindow: CachedEvent[] | null
): CachedEvent[] | undefined {
  if (!prefix) return undefined
  const prefixFloor = prefix.__tailFloor ?? null
  if (prefixFloor === null) return prefix
  if (!tail || (tail.__tailFloor ?? null) !== prefixFloor) return previousWindow ?? undefined
  return unionStreamRanges(prefix, tail)
}

/** The tail floor latched for one stream visit. */
interface TailAnchor {
  workspaceId: string
  streamId: string
  tailFloor: number
}

/**
 * Reactively read all events for a stream from IndexedDB.
 * Returns `undefined` while the query is resolving, `CachedEvent[]` once resolved.
 * Updates automatically when any write to db.events affects this stream.
 *
 * Correctness: when `workspaceId` or `streamId` changes, `useLiveQuery` keeps
 * returning the previous key's result until the new query resolves. We can't
 * trust that result even when it's empty (an empty previous-stream result would
 * otherwise be interpreted as "current stream is empty"). We track which
 * `(workspaceId, streamId)` the live result has actually been resolved for and
 * return `undefined` until the two match.
 */
export function useStreamEvents(
  workspaceId: string,
  streamId: string | undefined,
  fromSequenceNum?: number | null
): CachedEvent[] | undefined {
  const floor = fromSequenceNum ?? null
  // Floorless callers keep the single capped read: their bound is the count cap,
  // and a tail/prefix split there would change what that cap means.
  const bounded = floor !== null

  const [anchor, setAnchor] = useState<TailAnchor | null>(null)
  // The tail floor is latched ONCE per stream and never moves while the stream
  // is open. Paging older only widens the prefix downward, so the two ranges are
  // abutting AND immutable for the whole visit: whatever the previous emission
  // rendered is still covered by the stale prefix plus the unchanged tail while
  // the widened prefix read is in flight. Skew between the two live queries
  // therefore cannot uncover a range, and nothing rendered can vanish or
  // fabricate a hole (INV-61). A stream switch re-latches by construction.
  const latchedFloor =
    bounded && anchor !== null && anchor.workspaceId === workspaceId && anchor.streamId === streamId
      ? anchor.tailFloor
      : null
  // ...except when the window floor rises ABOVE the latch: a `syncMode: "replace"`
  // bootstrap (long-offline reconnect) resets the floor ratchet, and keeping the
  // old latch would invert the prefix range `[floor, tailFloor)` (permanently
  // empty) while the tail re-read the whole pre-disconnect history on every
  // message. Dropping the latch re-runs the unanchored tail once, which re-latches
  // through the effect below; `composeStreamWindow`'s stamp gate holds the previous
  // window across the transition, so nothing narrows.
  const tailFloor = latchedFloor !== null && floor !== null && floor > latchedFloor ? null : latchedFloor
  // Once anchored the tail range is independent of the window floor, so an older
  // page must not re-run it.
  const tailScanFloor = tailFloor === null ? floor : null

  // Both reads register with the apply window while in flight so a bootstrap
  // sweep holds its window until the timeline has re-read what it wrote.
  const tail = useLiveQuery(async () => {
    if (!streamId || !bounded) return stampStreamEvents([], workspaceId, streamId)
    const release = trackPendingRead()
    try {
      const stopLoad = getPerfCapture().time("timeline.tailLoad")
      const events = await loadStreamTail(workspaceId, streamId, tailFloor, tailScanFloor)
      stopLoad()
      return stampStreamEvents(events, workspaceId, streamId, tailFloor)
    } finally {
      release()
    }
  }, [workspaceId, streamId, tailFloor, tailScanFloor, bounded])

  const result = useLiveQuery(async () => {
    if (!streamId) return stampStreamEvents([], workspaceId, streamId)
    const release = trackPendingRead()
    try {
      const capture = getPerfCapture()
      capture.count("liveQuery.rerun")
      const stopLoad = capture.time("liveQuery.load")
      const events = bounded
        ? await loadStreamPrefix(workspaceId, streamId, floor, tailFloor)
        : await loadStreamEvents(workspaceId, streamId, floor)
      stopLoad()
      // Stamp the result with the key it was fetched for so the caller can
      // distinguish a fresh empty result from a stale empty result left over
      // from the previous workspace or stream.
      return stampStreamEvents(events, workspaceId, streamId, bounded ? tailFloor : null)
    } finally {
      release()
    }
  }, [workspaceId, streamId, floor, tailFloor, bounded])

  // Until `useLiveQuery` re-runs after a key change, `result` is still the
  // previous key's array. Our stamp lets us detect that regardless of whether
  // the previous result happened to be non-empty or empty.
  const resultMatches = result?.__workspaceId === workspaceId && result.__streamId === streamId
  const tailMatches = tail?.__workspaceId === workspaceId && tail.__streamId === streamId
  const tailForStream = bounded && streamId && tailMatches ? (tail ?? null) : null

  const oldestPersistedTail =
    bounded && streamId && tailForStream && tailFloor === null
      ? tailForStream.find((event) => event._status == null)
      : undefined

  useEffect(() => {
    if (!bounded || !streamId || !oldestPersistedTail) return
    setAnchor({ workspaceId, streamId, tailFloor: oldestPersistedTail._sequenceNum })
  }, [bounded, workspaceId, streamId, oldestPersistedTail])

  // Between one read landing and the next one it triggers (a stream switch, a
  // re-latch after an unanchored tail, a prefix stamped for an older floor)
  // neither querier is in flight, yet the window on screen is not the final
  // one. Count that gap as pending too, so a sweep does not release on it.
  const expectedTailFloor = bounded ? tailFloor : null
  const readsUnsettled =
    !!streamId &&
    (!resultMatches ||
      (result?.__tailFloor ?? null) !== expectedTailFloor ||
      (bounded && (!tailMatches || (tail?.__tailFloor ?? null) !== tailFloor)) ||
      !!oldestPersistedTail)
  useEffect(() => {
    if (!readsUnsettled) return
    return trackPendingRead()
  }, [readsUnsettled])

  const prevRef = useRef<{ workspaceId: string; streamId: string; array: CachedEvent[] } | null>(null)
  const prevArray =
    prevRef.current?.workspaceId === workspaceId && prevRef.current?.streamId === streamId
      ? (prevRef.current?.array ?? null)
      : null

  const union = useMemo(() => composeStreamWindow(result, tailForStream, prevArray), [result, tailForStream, prevArray])

  // Both reads must be stamped for the current stream before anything is
  // returned: a union built from one fresh and one stale range is a window with
  // a hole in it, which INV-61's contiguity gate would read as a real gap.
  const resolved = !streamId || (resultMatches && (!bounded || tailMatches))
  // A draft→real promotion moves the optimistic rows onto the real id before the
  // real view mounts. Until its live query resolves (and, for the draft id, once
  // the rows have moved away), paint those rows so neither view shows a skeleton
  // or an empty state for a message the user just sent.
  const handoff = streamId ? getDraftPromotionEvents(workspaceId, streamId) : null
  // Release on the first window that actually carries rows, not on `resolved`:
  // the live query can resolve from a snapshot taken before the moved rows
  // landed, and releasing there drops the handoff for the very render that
  // still needs it — one empty frame between the draft's rows and the real
  // stream's.
  const carriesRows = resolved && (union?.length ?? 0) > 0
  useEffect(() => {
    if (streamId && carriesRows && handoff) releaseDraftPromotionEvents(workspaceId, streamId)
  }, [workspaceId, streamId, carriesRows, handoff])

  if (!resolved) return handoff ?? undefined
  if (!union || !streamId) return union
  if (handoff && union.length === 0) return handoff

  const prev = prevRef.current
  const shared = shareEventIdentities(prevArray, union)
  if (shared !== prev?.array) {
    prevRef.current = { workspaceId, streamId, array: shared }
  }
  return shared
}

/**
 * Structural sharing across liveQuery emissions: `useLiveQuery` re-runs on
 * ANY write to db.events and materializes all-new row objects, even for rows
 * whose stored bytes did not change. Downstream memoization (timeline rows)
 * keys off row identity, so without sharing a single-message write would
 * invalidate every visible row.
 *
 * A row from `prev` is reused when its write markers match: every
 * payload-mutating write path bumps `_patchedAt` (socket patches),
 * `_cachedAt` (bootstrap apply / cache updates), or `_status` (optimistic
 * lifecycle), so matching markers imply an identical row. When every position
 * is unchanged, the previous array itself is returned so array-level memo
 * chains bail out too.
 *
 * Exported for isolated coverage; production callers go through
 * `useStreamEvents`.
 */
export function shareEventIdentities(prev: CachedEvent[] | null, next: CachedEvent[]): CachedEvent[] {
  if (!prev) return next
  const prevById = new Map(prev.map((row) => [row.id, row]))
  let allSame = prev.length === next.length
  const shared = next.map((row, i) => {
    const old = prevById.get(row.id)
    if (
      old &&
      old._cachedAt === row._cachedAt &&
      old._patchedAt === row._patchedAt &&
      old._status === row._status &&
      old.sequence === row.sequence &&
      old._anchorSequenceNum === row._anchorSequenceNum
    ) {
      if (allSame && prev[i] !== old) allSame = false
      return old
    }
    allSame = false
    return row
  })
  return allSame ? prev : shared
}

/**
 * The fallback query's answer when the registry owns the id and no read was made.
 * A module constant, so it never re-renders a consumer by identity; every other
 * answer is exactly what `db.streams.get` returned, `undefined` for absent
 * included — the fallback path's observable behaviour is byte-for-byte today's.
 */
const REGISTRY_OWNED_ROW = Symbol("registry-owned-stream-row")
type StreamRowFallback = CachedStream | typeof REGISTRY_OWNED_ROW | undefined

/**
 * Reactively read a single stream of one workspace from IndexedDB.
 *
 * Fast path: when the shared workspace-streams registry already holds the id,
 * the read is a Map hit woken by a per-key subscription. The fallback
 * `useLiveQuery` below still mounts on this path (conditional hooks are banned),
 * so its observable and global `storagemutated` listener are still per instance;
 * what the fast path removes is the per-key IDB `get` and its re-run on every
 * streams write. This hook is mounted four times per message row, so that read
 * ran ~4× the rendered window on every write before.
 *
 * Fallback (D7, fail-open): an id the workspace's entry does not hold — a socket
 * write that landed before bootstrap — resolves through the per-key
 * `db.streams.get`. Both paths mount the same hooks unconditionally; only the
 * work inside them differs.
 *
 * `pick` narrows the read to the fields a caller uses: the row is rewritten on
 * every message in its stream, so a per-row reader holding the whole row
 * re-renders the entire timeline window each time. A picked read re-renders
 * only when a picked field changes, compared deeply.
 *
 * `undefined` means "genuinely not resolved anywhere". `resolveDecryptContext`
 * reads that as "hold, never attempt", and a decrypt attempted against an
 * unhydrated row caches its failure forever — so a value already resolved on
 * either path is held across an ownership change rather than flickering to
 * `undefined`.
 */
export function useStreamFromStore(
  workspaceId: string | undefined,
  streamId: string | undefined
): CachedStream | undefined
export function useStreamFromStore<T extends object>(
  workspaceId: string | undefined,
  streamId: string | undefined,
  pick: (row: CachedStream) => T
): T | undefined
export function useStreamFromStore<T extends object>(
  workspaceId: string | undefined,
  streamId: string | undefined,
  pick?: (row: CachedStream) => T
): CachedStream | T | undefined {
  const registryHolds = Boolean(workspaceId && streamId && getWorkspaceTableRow(workspaceId, "streams", streamId))

  const pickedRef = useRef<T | null>(null)
  const view = useCallback(
    (row: CachedStream): CachedStream | T => {
      if (!pick) return row
      // Deep, not per-field: nested values (`e2eActors`) are fresh objects on every row rewrite.
      pickedRef.current = pickedRef.current ? replaceEqualDeep(pickedRef.current, pick(row)) : pick(row)
      return pickedRef.current
    },
    [pick]
  )

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!workspaceId || !streamId || !registryHolds) return () => {}
      return subscribeWorkspaceTableRow(workspaceId, "streams", streamId, onStoreChange)
    },
    [workspaceId, streamId, registryHolds]
  )
  const readRegistryRow = useCallback(() => {
    const row =
      workspaceId && streamId && registryHolds ? getWorkspaceTableRow(workspaceId, "streams", streamId) : undefined
    return row && view(row)
  }, [workspaceId, streamId, registryHolds, view])
  const registryRow = useSyncExternalStore(subscribe, readRegistryRow, readRegistryRow)

  const fallback = useLiveQuery<StreamRowFallback, StreamRowFallback>(
    async () => {
      if (!workspaceId || !streamId) return undefined
      // Re-checked inside the query (not read off the render) so a registry that
      // resolved between render and run still spares the read.
      if (getWorkspaceTableRow(workspaceId, "streams", streamId)) return REGISTRY_OWNED_ROW
      return await db.streams.get([workspaceId, streamId])
    },
    [workspaceId, streamId, registryHolds],
    // Seeded with the marker while the registry owns the id: the query's first
    // emission is then a no-op instead of a second render of every reader.
    registryHolds ? REGISTRY_OWNED_ROW : undefined
  )

  const lastResolvedRef = useRef<{ workspaceId: string; streamId: string; row: CachedStream | T } | null>(null)
  const lastOwnerRef = useRef<{ workspaceId: string; streamId: string } | null>(null)
  if (!workspaceId || !streamId) return undefined
  const held = lastResolvedRef.current
  if (held && (held.workspaceId !== workspaceId || held.streamId !== streamId)) lastResolvedRef.current = null
  const owner = lastOwnerRef.current
  if (owner && (owner.workspaceId !== workspaceId || owner.streamId !== streamId)) lastOwnerRef.current = null
  if (registryRow) {
    lastResolvedRef.current = { workspaceId, streamId, row: registryRow }
    lastOwnerRef.current = { workspaceId, streamId }
    return registryRow
  }
  if (lastOwnerRef.current && !registryHolds && hasResolvedSharedEntry(workspaceId, "streams")) {
    // That entry is still live and resolved and no longer holds the id: a real
    // removal, not the ownership drop the hold-over below exists for. Drop the
    // held row so the sentinel yields `undefined` on this render instead of
    // serving a deleted stream until the fallback query re-emits.
    lastResolvedRef.current = null
    lastOwnerRef.current = null
  }
  if (fallback === REGISTRY_OWNED_ROW) {
    // The registry has dropped the id (teardown, workspace switch) and the query
    // has not re-emitted yet — `useLiveQuery` keeps the previous result across a
    // deps change, so this marker is exactly that window. Hold the last resolved
    // row rather than flicker to `undefined`, which `resolveDecryptContext` would
    // read as "unhydrated" and whose failed decrypt is cached forever.
    return lastResolvedRef.current?.row
  }
  // The same deps-change window can still carry the previous key's row.
  if (fallback && (fallback.workspaceId !== workspaceId || fallback.id !== streamId)) return undefined
  const resolved = fallback && view(fallback)
  lastResolvedRef.current = resolved ? { workspaceId, streamId, row: resolved } : null
  return resolved
}
