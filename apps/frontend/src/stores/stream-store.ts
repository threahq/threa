import Dexie from "dexie"
import { useLiveQuery } from "dexie-react-hooks"
import { useRef } from "react"
import { db, type CachedEvent, type CachedStream } from "@/db"

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

export function orderStreamEvents(events: CachedEvent[]): CachedEvent[] {
  const optimistic: CachedEvent[] = []
  const persisted: CachedEvent[] = []

  for (const event of events) {
    if (event._status != null) optimistic.push(event)
    else persisted.push(event)
  }

  const anchor = (event: CachedEvent) => event._anchorSequenceNum ?? Number.POSITIVE_INFINITY
  persisted.sort((a, b) => a._sequenceNum - b._sequenceNum)
  optimistic.sort((a, b) => anchor(a) - anchor(b) || a._sequenceNum - b._sequenceNum || a.id.localeCompare(b.id))

  const ordered: CachedEvent[] = []
  let persistedIndex = 0
  for (const optimisticEvent of optimistic) {
    while (persistedIndex < persisted.length && persisted[persistedIndex]._sequenceNum <= anchor(optimisticEvent)) {
      ordered.push(persisted[persistedIndex])
      persistedIndex++
    }
    ordered.push(optimisticEvent)
  }

  return ordered.concat(persisted.slice(persistedIndex))
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
    const events = await loadStreamEvents(streamId, fromSequenceNum ?? null)
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
      old.sequence === row.sequence
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
 * Reactively read a single stream from IndexedDB.
 */
export function useStreamFromStore(streamId: string | undefined): CachedStream | undefined {
  return useLiveQuery(() => (streamId ? db.streams.get(streamId) : undefined), [streamId], undefined)
}
