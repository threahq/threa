import Dexie from "dexie"
import { useLiveQuery } from "dexie-react-hooks"
import { useCallback, useRef, useSyncExternalStore } from "react"
import { db, sequenceToNum, type CachedEvent, type CachedStream } from "@/db"
import { getPerfCapture } from "@/lib/perf/capture"
import {
  allocateWorkspaceTableToken,
  findSharedRowWorkspace,
  getWorkspaceTableRow,
  hasResolvedSharedEntry,
  subscribeWorkspaceTableRow,
} from "./workspace-table-registry"

/**
 * Cap the number of events loaded from IDB per stream when no sequence floor
 * is known (initial load before bootstrap resolves). Once the caller provides
 * a floor, the floor itself bounds memory usage and the cap doesn't apply.
 */
const DEFAULT_IDB_EVENT_LIMIT = 150

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
export async function loadStreamEvents(streamId: string, fromSequenceNum: number | null): Promise<CachedEvent[]> {
  const hasFloor = fromSequenceNum != null
  const lowerBound: [string, number] | [string, typeof Dexie.minKey] = hasFloor
    ? [streamId, fromSequenceNum]
    : [streamId, Dexie.minKey]
  const range = db.events.where("[streamId+_sequenceNum]").between(lowerBound, [streamId, Dexie.maxKey], true, true)

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
  const unsentForStream = (await db.events.where("_status").anyOf(["pending", "failed", "editing"]).toArray()).filter(
    (e) => e.streamId === streamId && (!hasFloor || e._sequenceNum >= fromSequenceNum)
  )
  if (unsentForStream.length === 0) return base

  const loadedIds = new Set(base.map((e) => e.id))
  const extra = unsentForStream.filter((e) => !loadedIds.has(e.id))
  return orderStreamEvents([...base, ...extra])
}

type OrderableStreamEvent = Pick<CachedEvent, "id" | "sequence" | "createdAt"> &
  Partial<Pick<CachedEvent, "_sequenceNum" | "_anchorSequenceNum" | "_status">>

function eventSequence(event: OrderableStreamEvent): number {
  return event._sequenceNum ?? sequenceToNum(event.sequence)
}

/**
 * Interleaves optimistic stream events at their persisted sequence anchors.
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
    if (optimisticEvent._anchorSequenceNum != null || persisted.length === 0) continue
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
    event._anchorSequenceNum ?? inferredAnchors.get(event.id) ?? Number.POSITIVE_INFINITY
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
 * Reactively read all events for a stream from IndexedDB.
 * Returns `undefined` while the query is resolving, `CachedEvent[]` once resolved.
 * Updates automatically when any write to db.events affects this stream.
 *
 * Correctness: when `streamId` changes, `useLiveQuery` keeps returning the
 * previous stream's result until the new query resolves. We can't trust that
 * result even when it's empty (an empty previous-stream result would otherwise
 * be interpreted as "current stream is empty"). We track which `streamId`
 * the live result has actually been resolved for and return `undefined`
 * until the two match.
 */
export function useStreamEvents(
  streamId: string | undefined,
  fromSequenceNum?: number | null
): CachedEvent[] | undefined {
  const result = useLiveQuery(async () => {
    if (!streamId) return []
    const capture = getPerfCapture()
    capture.count("liveQuery.rerun")
    const stopLoad = capture.time("liveQuery.load")
    const events = await loadStreamEvents(streamId, fromSequenceNum ?? null)
    stopLoad()
    // Stamp the result with the streamId it was fetched for so the caller
    // can distinguish a fresh empty result from a stale empty result left
    // over from the previous stream.
    ;(events as CachedEvent[] & { __streamId?: string }).__streamId = streamId
    return events
  }, [streamId, fromSequenceNum])

  // Until `useLiveQuery` re-runs after a streamId change, `result` is still
  // the previous stream's array. Our stamp lets us detect that regardless of
  // whether the previous result happened to be non-empty or empty.
  const resultStreamId = (result as (CachedEvent[] & { __streamId?: string }) | undefined)?.__streamId
  const prevRef = useRef<{ streamId: string; array: CachedEvent[] } | null>(null)
  if (streamId && resultStreamId !== streamId) {
    return undefined
  }
  if (!result || !streamId) return result

  const prev = prevRef.current
  const shared = shareEventIdentities(prev?.streamId === streamId ? prev.array : null, result)
  if (shared !== prev?.array) {
    prevRef.current = { streamId, array: shared }
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
 * Reactively read a single stream from IndexedDB.
 *
 * Fast path: when the shared workspace-streams registry already holds the id,
 * the read is a Map hit woken by a per-key subscription. The fallback
 * `useLiveQuery` below still mounts on this path (conditional hooks are banned),
 * so its observable and global `storagemutated` listener are still per instance;
 * what the fast path removes is the per-key IDB `get` and its re-run on every
 * streams write. This hook is mounted four times per message row, so that read
 * ran ~4× the rendered window on every write before.
 *
 * Fallback (D7, fail-open): an id no shared entry holds — a socket write that
 * landed before bootstrap, or the `sharedWorkspaceReads=off` arm, where entries
 * are private to a token this hook does not have and the fast path therefore
 * misses by design — resolves through today's per-key `db.streams.get`. Both
 * paths mount the same hooks unconditionally; only the work inside them differs.
 *
 * `undefined` means "genuinely not resolved anywhere". `resolveDecryptContext`
 * reads that as "hold, never attempt", and a decrypt attempted against an
 * unhydrated row caches its failure forever — so a value already resolved on
 * either path is held across a registry flip rather than flickering to
 * `undefined`.
 */
export function useStreamFromStore(streamId: string | undefined): CachedStream | undefined {
  const tokenRef = useRef<number | null>(null)
  tokenRef.current ??= allocateWorkspaceTableToken()
  const token = tokenRef.current

  const registryWorkspaceId = streamId ? findSharedRowWorkspace("streams", streamId) : undefined

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!streamId || !registryWorkspaceId) return () => {}
      return subscribeWorkspaceTableRow(registryWorkspaceId, "streams", streamId, token, onStoreChange)
    },
    [streamId, registryWorkspaceId, token]
  )
  const readRegistryRow = useCallback(
    () =>
      streamId && registryWorkspaceId
        ? getWorkspaceTableRow(registryWorkspaceId, "streams", streamId, token)
        : undefined,
    [streamId, registryWorkspaceId, token]
  )
  const registryRow = useSyncExternalStore(subscribe, readRegistryRow, readRegistryRow)

  const fallback = useLiveQuery<StreamRowFallback>(async () => {
    if (!streamId) return undefined
    // Re-checked inside the query (not read off the render) so a registry that
    // resolved between render and run still spares the read.
    if (findSharedRowWorkspace("streams", streamId)) return REGISTRY_OWNED_ROW
    return await db.streams.get(streamId)
  }, [streamId, registryWorkspaceId])

  const lastResolvedRef = useRef<{ streamId: string; row: CachedStream } | null>(null)
  const lastOwnerRef = useRef<{ streamId: string; workspaceId: string } | null>(null)
  if (!streamId) return undefined
  if (lastResolvedRef.current?.streamId !== streamId) lastResolvedRef.current = null
  if (lastOwnerRef.current?.streamId !== streamId) lastOwnerRef.current = null
  if (registryRow && registryWorkspaceId) {
    lastResolvedRef.current = { streamId, row: registryRow }
    lastOwnerRef.current = { streamId, workspaceId: registryWorkspaceId }
    return registryRow
  }
  const owner = lastOwnerRef.current
  if (owner && !registryWorkspaceId && hasResolvedSharedEntry(owner.workspaceId, "streams")) {
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
  lastResolvedRef.current = fallback ? { streamId, row: fallback } : null
  return fallback
}
