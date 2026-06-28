import { useEffect, useMemo } from "react"
import { useSyncEngine } from "@/sync/sync-engine"
import type { BoardViewPost } from "./use-stable-board-view"

/**
 * Keep every on-screen board card's stream live + offline-first. Board card
 * bodies ride the `db.events` rail (see use-board-card-messages), so a card is
 * only fully reactive once its stream's history is in IDB and its room is joined.
 * Declaring the cards' stream ids drives the SyncEngine to catch up + bootstrap
 * the ones that aren't already subscribed — threads and public channels the
 * viewer never joined — while member streams (already subscribed at bootstrap)
 * skip through as no-ops.
 *
 * The declaration is cleared on unmount so a closed board doesn't widen the
 * reconnect catch-up set; the engine never tears the subscriptions down (see
 * SyncEngine.setBoardStreamIds for why per-card teardown would be unsafe).
 */
export function useBoardStreamSubscriptions(posts: BoardViewPost[]): void {
  const syncEngine = useSyncEngine()

  const streamIds = useMemo(() => {
    const seen = new Set<string>()
    const ids: string[] = []
    for (const post of posts) {
      const streamId = post.conversation.streamId
      if (seen.has(streamId)) continue
      seen.add(streamId)
      ids.push(streamId)
    }
    return ids
  }, [posts])

  // The frozen board view hands back a fresh array on every commit even when the
  // same streams are on screen; key the declaration on the stream set itself so
  // it only re-fires when which streams are visible actually changes.
  const streamSetKey = streamIds.join(",")

  useEffect(() => {
    syncEngine.setBoardStreamIds(streamIds)
  }, [syncEngine, streamSetKey])

  useEffect(() => {
    return () => syncEngine.setBoardStreamIds([])
  }, [syncEngine])
}
