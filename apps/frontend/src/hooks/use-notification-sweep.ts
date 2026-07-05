import { useEffect } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { WorkspaceBootstrap } from "@threa/types"
import { workspaceKeys } from "./use-workspaces"
import { sweepStaleStreamNotifications } from "@/lib/notification-sweep"

/**
 * Closes stale OS notifications once the workspace bootstrap knows what is
 * unread — the closed-app counterpart of the socket clear fast-path (see
 * lib/notification-sweep.ts for why no push-based clear exists).
 *
 * Safe against stale data by construction: the bootstrap query cache is
 * in-memory and only ever filled by a network fetch this page load (IDB
 * hydration goes to Dexie, not this query), so `data` here always reflects the
 * server's current unread state. Reconnect invalidation (INV-53) refetches and
 * re-runs the sweep, and socket read-state updates rewrite the cached bootstrap,
 * so a stream read elsewhere while this app is open sweeps promptly too.
 */
export function useNotificationSweep(workspaceId: string): void {
  const queryClient = useQueryClient()
  // Cache-only observer — useWorkspaceBootstrap higher in the tree owns the fetch.
  const { data } = useQuery({
    queryKey: workspaceKeys.bootstrap(workspaceId),
    queryFn: () => queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId)) ?? null,
    enabled: false,
    staleTime: Infinity,
  })

  // Key on the unread-stream signature, not the data reference: bootstrap cache
  // writes happen on every message, and only changes to WHAT is unread can make
  // a displayed notification stale.
  const unreadSignature = data ? buildUnreadSignature(data) : null

  useEffect(() => {
    if (unreadSignature === null) return
    const unreadStreamIds = new Set(unreadSignature.split(" ").filter(Boolean))
    void sweepStaleStreamNotifications(unreadStreamIds)
  }, [unreadSignature])
}

function buildUnreadSignature(bootstrap: WorkspaceBootstrap): string {
  const unread = new Set<string>()
  for (const [streamId, count] of Object.entries(bootstrap.unreadCounts ?? {})) {
    if (count > 0) unread.add(streamId)
  }
  // Activity rows (mentions, reactions, fired reminders) keep a stream's
  // notification alive even when its message watermark is caught up.
  for (const activity of bootstrap.unreadActivities ?? []) {
    if (activity.streamId) unread.add(activity.streamId)
  }
  return [...unread].sort().join(" ")
}
