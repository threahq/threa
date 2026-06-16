import { useEffect, useMemo } from "react"
import { useAuth } from "@/auth"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { getLastStreamId, setLastStreamId, clearLastStreamId } from "@/lib/last-stream"
import type { CachedStream } from "@/db"

interface UseLastStreamResult {
  /** Stream ID to redirect to, or null if no stream is available */
  redirectStreamId: string | null
  /** True when bootstrap is loaded and the workspace has zero streams */
  shouldOpenSidebar: boolean
}

/**
 * Resolves which stream to show when the workspace index route loads.
 *
 * Priority:
 * 1. Stored last-stream from localStorage (validated against bootstrap)
 * 2. Most recently active stream from bootstrap data
 * 3. First available stream
 *
 * Evicts stale localStorage entries when the stored stream no longer
 * exists in the user's workspace (deleted, lost access, etc).
 *
 * Returns `shouldOpenSidebar: true` only after bootstrap has loaded
 * and confirmed the workspace has no streams — avoids premature
 * sidebar mutations while async data is still in flight.
 */
export function useLastStream(workspaceId: string): UseLastStreamResult {
  const { user } = useAuth()
  const streams = useWorkspaceStreams(workspaceId)

  const result = useMemo(() => {
    const storedId = user ? getLastStreamId(user.id, workspaceId) : null

    if (storedId) {
      const stillExists = streams.some((s) => s.id === storedId)
      if (stillExists) {
        return { redirectStreamId: storedId, shouldOpenSidebar: false, staleStoredId: false }
      }
      // Mark as stale — eviction happens in useEffect below
      return {
        redirectStreamId: streams.length > 0 ? getMostRecentStreamId(streams) : null,
        shouldOpenSidebar: streams.length === 0,
        staleStoredId: true,
      }
    }

    if (streams.length > 0) {
      return { redirectStreamId: getMostRecentStreamId(streams), shouldOpenSidebar: false, staleStoredId: false }
    }

    return { redirectStreamId: null, shouldOpenSidebar: true, staleStoredId: false }
  }, [user, workspaceId, streams])

  useEffect(() => {
    if (result.staleStoredId && user) {
      clearLastStreamId(user.id, workspaceId)
    }
  }, [result.staleStoredId, user, workspaceId])

  return result
}

/** Persists the currently viewed stream to localStorage for restore-on-return. */
export function usePersistLastStream(workspaceId: string | undefined, streamId: string | undefined) {
  const { user } = useAuth()

  useEffect(() => {
    if (streamId && user && workspaceId) {
      setLastStreamId(user.id, workspaceId, streamId)
    }
  }, [streamId, user, workspaceId])
}

function getMostRecentStreamId(streams: CachedStream[]): string {
  const sorted = [...streams].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return sorted[0]?.id ?? streams[0].id
}
