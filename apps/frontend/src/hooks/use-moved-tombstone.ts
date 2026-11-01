import Dexie from "dexie"
import { useObservable, type InteropableObservable } from "dexie-react-hooks"
import type { StreamEvent } from "@threahq/types"
import { db, type CachedEvent } from "@/db"

// Every timeline row mounts this hook and almost none was moved: a live query per
// row, even one that reads nothing, wakes on every IDB commit in the app.
const NO_TOMBSTONE: InteropableObservable<undefined> = {
  getValue: () => undefined,
  subscribe(onNext) {
    onNext(undefined)
    return () => {}
  },
}

/**
 * Look up a `messages:moved` tombstone event from the local IDB cache by
 * workspace and `event.id`. Returns the cached row (shaped as the wire `StreamEvent`
 * — the cache adds workspaceId + cache-housekeeping fields the drawer
 * doesn't read), or `undefined` when the id is missing or the row hasn't
 * been cached yet (before bootstrap hydrates the destination stream).
 *
 * Used by the destination-side per-message context-menu action ("Show
 * move details") to populate the move drill-in drawer. The destination
 * doesn't render an inline tombstone, so the drawer needs to fetch the
 * tombstone on demand.
 */
export function useMovedTombstone(workspaceId: string, moveTombstoneId: string | undefined): StreamEvent | undefined {
  return useObservable<StreamEvent | undefined>(
    () =>
      moveTombstoneId
        ? Dexie.liveQuery(async () => {
            const cached: CachedEvent | undefined = await db.events.get([workspaceId, moveTombstoneId])
            return cached as StreamEvent | undefined
          })
        : NO_TOMBSTONE,
    [workspaceId, moveTombstoneId]
  )
}
