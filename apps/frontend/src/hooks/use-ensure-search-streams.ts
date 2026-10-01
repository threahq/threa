import { useEffect, useMemo, useRef, useState } from "react"
import { ApiError } from "@/api"
import { useStreamService } from "@/contexts"
import { persistStreamByRevision } from "@/lib/title-merge"
import { useWorkspaceStreams } from "@/stores/workspace-store"

const MAX_HYDRATION_ATTEMPTS = 3

/**
 * Hydrates result streams absent from the workspace cache. Requests are
 * deduplicated while in flight; terminal misses stop and transient failures
 * retry at most three times as the reactive workspace cache changes.
 */
export function useEnsureSearchStreams(workspaceId: string, streamIds: readonly string[]): ReadonlySet<string> {
  const streamService = useStreamService()
  const streams = useWorkspaceStreams(workspaceId)
  const attemptCounts = useRef(new Map<string, number>())
  const terminalIds = useRef(new Set<string>())
  const inFlightIds = useRef(new Set<string>())
  const [resolvingIds, setResolvingIds] = useState<ReadonlySet<string>>(() => new Set())
  const cachedIds = useMemo(() => new Set(streams.map((stream) => stream.id)), [streams])
  const streamIdsKey = useMemo(() => [...new Set(streamIds)].sort().join("\u0000"), [streamIds])

  useEffect(() => {
    if (!workspaceId) return

    const missingIds = [...new Set(streamIds)].filter((id) => {
      const attempts = attemptCounts.current.get(id) ?? 0
      return (
        !cachedIds.has(id) &&
        !terminalIds.current.has(id) &&
        !inFlightIds.current.has(id) &&
        attempts < MAX_HYDRATION_ATTEMPTS
      )
    })
    if (missingIds.length === 0) return

    for (const id of missingIds) {
      attemptCounts.current.set(id, (attemptCounts.current.get(id) ?? 0) + 1)
      inFlightIds.current.add(id)
    }
    setResolvingIds((current) => new Set([...current, ...missingIds]))

    for (const streamId of missingIds) {
      void streamService
        .get(workspaceId, streamId)
        .then(persistStreamByRevision)
        .catch((error: unknown) => {
          if (ApiError.isApiError(error) && (error.status === 403 || error.status === 404)) {
            terminalIds.current.add(streamId)
          }
          console.warn(`[search] Failed to hydrate result stream ${streamId}`, error)
        })
        .finally(() => {
          inFlightIds.current.delete(streamId)
          setResolvingIds((current) => {
            if (!current.has(streamId)) return current
            const next = new Set(current)
            next.delete(streamId)
            return next
          })
        })
    }
  }, [workspaceId, streamIdsKey, cachedIds, streamIds, streamService])

  return resolvingIds
}
