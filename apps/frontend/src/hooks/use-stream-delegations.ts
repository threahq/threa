import { useQuery } from "@tanstack/react-query"
import { delegationsApi } from "@/api"

export const delegationKeys = {
  all: ["delegations"] as const,
  /** The stream-scoped list backing the "In this stream" panel — the
   *  invalidation target when a delegation socket event lands (stream-sync). */
  stream: (workspaceId: string, streamId: string) => [...delegationKeys.all, "stream", workspaceId, streamId] as const,
}

/**
 * A stream's delegations with live statuses, newest first. Authoritative read
 * (not timeline-derived): a delegation's status lives in
 * `delegation:status_changed` patch events, so a view derived from the loaded
 * window would freeze out-of-window delegations on stale status. stream-sync
 * invalidates this key on both delegation socket events, so an open panel
 * tracks transitions live.
 */
export function useStreamDelegations(workspaceId: string, streamId: string) {
  return useQuery({
    queryKey: delegationKeys.stream(workspaceId, streamId),
    queryFn: () => delegationsApi.list(workspaceId, streamId),
    enabled: !!workspaceId && !!streamId,
  })
}
