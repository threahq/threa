import { useCallback, useMemo } from "react"
import { useWorkspaceDmPeers, useWorkspaceStreams, useWorkspaceUsers } from "@/stores/workspace-store"
import { resolveStreamName, type StreamNameCaches } from "@/lib/streams"
import { useEnsureSearchStreams } from "@/hooks/use-ensure-search-streams"

export interface SearchStreamLabels {
  label: (streamId: string) => string
  isResolving: (streamId: string) => boolean
  isArchived: (streamId: string) => boolean
}

/** Stream labels for a result list, hydrating streams the workspace cache is missing. */
export function useSearchStreamLabels(workspaceId: string, streamIds: readonly string[]): SearchStreamLabels {
  const users = useWorkspaceUsers(workspaceId)
  const streams = useWorkspaceStreams(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  const resolvingStreamIds = useEnsureSearchStreams(workspaceId, streamIds)
  const streamsById = useMemo(() => new Map(streams.map((stream) => [stream.id, stream])), [streams])
  const label = useMemo(() => {
    const caches: StreamNameCaches = { streams, users, dmPeers }
    return (streamId: string) => resolveStreamName(streamId, caches, "breadcrumb") ?? "Unknown stream"
  }, [streams, users, dmPeers])
  const isResolving = useCallback((streamId: string) => resolvingStreamIds.has(streamId), [resolvingStreamIds])
  const isArchived = useCallback(
    (streamId: string) => {
      const stream = streamsById.get(streamId)
      const rootStreamId = stream?.rootStreamId ?? stream?.id
      return rootStreamId ? streamsById.get(rootStreamId)?.archivedAt != null : false
    },
    [streamsById]
  )
  return { label, isResolving, isArchived }
}
