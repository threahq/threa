import Dexie from "dexie"
import { useLiveQuery } from "dexie-react-hooks"
import { db, type CachedEvent, type CachedStream } from "@/db"

/**
 * Cap the number of events loaded from IDB per stream when no sequence floor
 * is known (initial load before bootstrap resolves). Once the caller provides
 * a floor, the floor itself bounds memory usage and the cap doesn't apply.
 */
const DEFAULT_IDB_EVENT_LIMIT = 150

/** No-op — the in-memory event cache has been removed. Kept for clearAllCachedData compat. */
export function resetStreamStoreCache(): void {}

/**
 * Read events for a stream from IndexedDB, sorted ASC by `_sequenceNum`.
 *
 * Single read path regardless of whether a floor is provided:
 *   - With a floor: range scan from the floor to maxKey, no count cap.
 *   - Without a floor: same range, but capped to the latest N events as a
 *     memory bound on initial pre-bootstrap load.
 *
 * Pending and failed optimistic events with placeholder sequences are merged
 * in and the full list re-sorted, so they always land in their natural slot
 * by `_sequenceNum` rather than being appended at the end of the array.
 */
export async function loadStreamEvents(streamId: string, fromSequenceNum: number | null): Promise<CachedEvent[]> {
  const hasFloor = fromSequenceNum != null
  const lowerBound: [string, number] | [string, typeof Dexie.minKey] = hasFloor
    ? [streamId, fromSequenceNum]
    : [streamId, Dexie.minKey]
  const range = db.events.where("[streamId+_sequenceNum]").between(lowerBound, [streamId, Dexie.maxKey], true, true)

  // The compound index already yields rows in `_sequenceNum` order, so the base
  // window needs no comparison sort:
  //   - With a floor: scan ASC directly — already in render order.
  //   - Without a floor: scan DESC + cap to the newest N (memory bound on the
  //     pre-bootstrap load), then flip to ASC with an O(n) reverse.
  // This matters because `useLiveQuery` re-runs this on every write to
  // `db.events`; a deep scrolled-back window must not pay an O(n log n) sort
  // per incoming message.
  let base: CachedEvent[]
  if (hasFloor) {
    base = await range.toArray()
  } else {
    base = await range.reverse().limit(DEFAULT_IDB_EVENT_LIMIT).toArray()
    base.reverse()
  }

  // Pending/failed optimistic events may have placeholder sequences outside the
  // scanned window (the current scheme uses `Date.now()`, so they sort to the
  // very top and are usually already in `base`). Drive this off the `_status`
  // index — Dexie only indexes rows where the value is present, so this is the
  // handful of unsent rows app-wide, not an O(history) scan of the stream.
  const unsentForStream = (await db.events.where("_status").anyOf(["pending", "failed"]).toArray()).filter(
    (e) => e.streamId === streamId && (!hasFloor || e._sequenceNum >= fromSequenceNum)
  )
  if (unsentForStream.length === 0) return base

  // Only now pay for de-duplication: a pending row inside the scanned range is
  // already present in `base`, so drop those before merging.
  const loadedIds = new Set(base.map((e) => e.id))
  const extra = unsentForStream.filter((e) => !loadedIds.has(e.id))
  if (extra.length === 0) return base

  // Re-sort the spliced list so order is determined solely by `_sequenceNum`,
  // not by which path a row arrived on.
  const merged = [...base, ...extra]
  merged.sort((a, b) => a._sequenceNum - b._sequenceNum)
  return merged
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
  if (streamId && resultStreamId !== streamId) {
    return undefined
  }

  return result
}

/**
 * Reactively read a single stream from IndexedDB.
 */
export function useStreamFromStore(streamId: string | undefined): CachedStream | undefined {
  return useLiveQuery(() => (streamId ? db.streams.get(streamId) : undefined), [streamId], undefined)
}
