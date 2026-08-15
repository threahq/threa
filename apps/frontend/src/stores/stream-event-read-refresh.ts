import Dexie from "dexie"
import { db } from "@/db"

/**
 * Wake the main thread's event live queries after a backgrounded service worker
 * may have written rows while the page was frozen. Touching the newest row is
 * enough for Dexie to invalidate the stream's indexed ranges and re-read every
 * row the worker added; a plain read cannot restore a missed mutation signal.
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
      if (!latest) continue
      await table.put({ ...latest, _cachedAt: Math.max(Date.now(), latest._cachedAt + 1) })
    }
  })
}
