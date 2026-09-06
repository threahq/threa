import { useLiveQuery } from "dexie-react-hooks"
import type { StreamEvent } from "@threahq/types"
import { db, type CachedEvent } from "@/db"

/**
 * Look up a `messages:moved` tombstone event from the local IDB cache by
 * its `event.id`. Returns the cached row (shaped as the wire `StreamEvent`
 * — the cache adds workspaceId + cache-housekeeping fields the drawer
 * doesn't read), or `undefined` when the id is missing or the row hasn't
 * been cached yet (before bootstrap hydrates the destination stream).
 *
 * Used by the destination-side per-message context-menu action ("Show
 * move details") to populate the move drill-in drawer. The destination
 * doesn't render an inline tombstone, so the drawer needs to fetch the
 * tombstone on demand.
 */
export function useMovedTombstone(moveTombstoneId: string | undefined): StreamEvent | undefined {
  return useLiveQuery<StreamEvent | undefined>(async () => {
    if (!moveTombstoneId) return undefined
    const cached: CachedEvent | undefined = await db.events.get(moveTombstoneId)
    return cached as StreamEvent | undefined
  }, [moveTombstoneId])
}
