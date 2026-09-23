import { useEffect, useMemo } from "react"
import { useSyncEngine } from "@/sync/sync-engine"

/**
 * Keep the streams a surface shows hover cards for synced into the local store, so
 * a card renders from socket-synced history the moment it opens. Every hover-card
 * surface declares its rows here; pass an empty list where hover cards are off.
 */
export function useStreamWarmup(streamIds: string[]): void {
  const syncEngine = useSyncEngine()
  // Sorted so a reorder of the same rows doesn't re-declare.
  const key = useMemo(() => [...new Set(streamIds)].sort().join(","), [streamIds])

  useEffect(() => {
    if (key) syncEngine.warmStreams(key.split(","))
  }, [syncEngine, key])
}
