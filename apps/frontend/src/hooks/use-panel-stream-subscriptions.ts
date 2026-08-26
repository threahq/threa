import { useEffect, useMemo } from "react"
import { useSyncEngine } from "@/sync/sync-engine"

/**
 * Keep an open conversation panel's streams live + offline-first. The panel body
 * reads message rows off the `db.events` rail (use-board-card-messages), so a
 * conversation is only fully reactive once each of its streams — its root and any
 * threads it spans (one root) — is caught up and its room
 * joined. Declaring them drives the SyncEngine to do that for the ones not already
 * subscribed (a thread the viewer never opened), via its own panel slot so it
 * composes with the board feed's declaration rather than clobbering it.
 *
 * Cleared on unmount so a closed panel doesn't widen the reconnect catch-up set;
 * the engine never tears the subscriptions down (a card click may navigate into
 * one), exactly as the board declaration behaves.
 */
export function usePanelStreamSubscriptions(streamIds: string[]): void {
  const syncEngine = useSyncEngine()

  // Stable, sorted, deduped key so the declaration effect only re-fires when the
  // set of streams changes — not when a parent hands back a fresh array identity.
  const key = useMemo(() => [...new Set(streamIds)].sort().join(","), [streamIds])
  const ids = useMemo(() => (key ? key.split(",") : []), [key])

  useEffect(() => {
    syncEngine.setPanelStreamIds(ids)
  }, [syncEngine, ids])

  useEffect(() => {
    return () => syncEngine.setPanelStreamIds([])
  }, [syncEngine])
}
