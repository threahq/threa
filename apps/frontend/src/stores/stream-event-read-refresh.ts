import Dexie from "dexie"
import { db, type CachedEvent } from "@/db"
import { BOARD_RAIL_EVENT_TYPES } from "@/lib/board/board-rail-event-types"

/**
 * Wake the main thread's event live queries after a backgrounded service worker
 * may have written rows while the page was frozen. Touch one row in each index
 * range shape mounted event consumers observe; a plain read cannot restore a
 * missed mutation signal.
 */
export async function requestStreamEventReadRefresh(streamIds: string[]): Promise<void> {
  const table = db.events
  const uniqueStreamIds = [...new Set(streamIds)]
  if (uniqueStreamIds.length === 0) return

  await table.db.transaction("rw", table, async () => {
    for (const streamId of uniqueStreamIds) {
      const latest = await table
        .where("[streamId+_sequenceNum]")
        .between([streamId, Dexie.minKey], [streamId, Dexie.maxKey], true, true)
        .last()
      const latestBoardRailEvent = await table
        .where("[streamId+eventType]")
        .anyOf(BOARD_RAIL_EVENT_TYPES.map((eventType) => [streamId, eventType]))
        .first()
      const latestMessage = await table.where("[streamId+eventType]").equals([streamId, "message_created"]).last()
      const rowsToTouch = new Map<string, CachedEvent>()
      if (latest) rowsToTouch.set(latest.id, latest)
      if (latestBoardRailEvent) rowsToTouch.set(latestBoardRailEvent.id, latestBoardRailEvent)
      if (latestMessage) rowsToTouch.set(latestMessage.id, latestMessage)
      for (const event of rowsToTouch.values()) {
        await table.put({ ...event, _cachedAt: Math.max(Date.now(), event._cachedAt + 1) })
      }
    }
  })
}
