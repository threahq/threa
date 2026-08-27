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

  // The frozen board view hands back a fresh array on every commit even when the
  // same streams are on screen. Derive a stable key for the deduped stream set,
  // then derive the array FROM that key so its identity only changes when which
  // streams are visible changes — the declaration effect can then depend on the
  // array directly instead of a proxy it closes over (no stale-closure shape).
  const streamSetKey = useMemo(() => {
    const seen = new Set<string>()
    const ids: string[] = []
    const add = (streamId: string) => {
      if (seen.has(streamId)) return
      seen.add(streamId)
      ids.push(streamId)
    }
    for (const post of posts) {
      // A conversation spans its root + the root's threads (one root); declare
      // every stream the card reads so the SyncEngine catches up + joins each
      // thread's room, not just the anchor — otherwise a cross-stream reply never
      // syncs into the rail.
      add(post.conversation.streamId)
      for (const streamId of post.streamIds ?? []) add(streamId)
    }
    // Sort so the key reflects stream membership, not card order — a reorder of
    // the same visible streams mustn't re-fire setBoardStreamIds.
    ids.sort()
    return ids.join(",")
    // Stream ids are prefixed ULIDs (no commas), so join/split round-trips cleanly.
  }, [posts])

  const streamIds = useMemo(() => (streamSetKey ? streamSetKey.split(",") : []), [streamSetKey])

  useEffect(() => {
    syncEngine.setBoardStreamIds(streamIds)
  }, [syncEngine, streamIds])

  useEffect(() => {
    return () => syncEngine.setBoardStreamIds([])
  }, [syncEngine])
}
