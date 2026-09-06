import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useActivityService } from "@/contexts"
import { workspaceKeys } from "./use-workspaces"
import { db } from "@/db"
import { deriveActivityCounts } from "@/sync/unread-counters"
import type { Activity, WorkspaceBootstrap } from "@threahq/types"

export const activityKeys = {
  all: ["activity"] as const,
  list: (workspaceId: string) => ["activity", workspaceId] as const,
  listFiltered: (workspaceId: string, filters: { unreadOnly: boolean; mineOnly: boolean; othersOnly: boolean }) =>
    ["activity", workspaceId, filters] as const,
}

/**
 * One page of the activity feed. Exported because the unread-tab reconcile
 * backstop must know whether a fetched page is the COMPLETE unread set
 * (rows < limit) — reconciling the held badge set against a truncated page
 * would clamp the count to the page size.
 */
export const ACTIVITY_FEED_PAGE_LIMIT = 50

export function useActivityFeed(
  workspaceId: string,
  opts?: { unreadOnly?: boolean; mineOnly?: boolean; othersOnly?: boolean }
) {
  const activityService = useActivityService()
  const unreadOnly = opts?.unreadOnly ?? false
  const mineOnly = opts?.mineOnly ?? false
  const othersOnly = opts?.othersOnly ?? false

  return useQuery({
    queryKey: activityKeys.listFiltered(workspaceId, { unreadOnly, mineOnly, othersOnly }),
    queryFn: () =>
      activityService.list(workspaceId, { limit: ACTIVITY_FEED_PAGE_LIMIT, unreadOnly, mineOnly, othersOnly }),
    // Subscribe-then-bootstrap: socket events invalidate; refetchOnMount picks up
    // the invalidation, staleTime: Infinity suppresses other auto-refetches.
    staleTime: Infinity,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: !!workspaceId,
  })
}

export function useMarkActivityRead(workspaceId: string) {
  const activityService = useActivityService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (activityId: string) => activityService.markAsRead(workspaceId, activityId),
    onMutate: async (activityId: string) => {
      await queryClient.cancelQueries({ queryKey: activityKeys.list(workspaceId) })

      queryClient.setQueriesData<Activity[]>({ queryKey: activityKeys.list(workspaceId) }, (old) => {
        if (!old) return old
        return old.map((a) => (a.id === activityId ? { ...a, readAt: new Date().toISOString() } : a))
      })

      // The held set is the source of truth (D3/D4): drop the read row by id and
      // re-derive the count projection. Self / already-read rows are never in the
      // set, so a no-op filter just leaves the counts where they were.
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        if (!old) return old
        const rows = (old.unreadActivities ?? []).filter((a) => a.id !== activityId)
        return { ...old, unreadActivities: rows, ...deriveActivityCounts(rows) }
      })

      const previousUnreadState = await db.unreadState.get(workspaceId)
      if (previousUnreadState) {
        const held = previousUnreadState.unreadActivities ?? []
        const removed = held.find((a) => a.id === activityId)
        const rows = held.filter((a) => a.id !== activityId)
        await db.unreadState.put({
          ...previousUnreadState,
          unreadActivities: rows,
          ...deriveActivityCounts(rows),
          // Touch stamp: an in-flight bootstrap's per-stream merge must not
          // resurrect the just-read row from its pre-read snapshot
          // (mergeBootstrapUnreadFields). Null-streamId rows can't be covered.
          counterTouchedAt: removed?.streamId
            ? { ...previousUnreadState.counterTouchedAt, [removed.streamId]: Date.now() }
            : previousUnreadState.counterTouchedAt,
          _cachedAt: Date.now(),
        })
      }

      return { previousUnreadState }
    },
    onError: (_error, _activityId, context) => {
      queryClient.invalidateQueries({ queryKey: activityKeys.list(workspaceId) })
      queryClient.invalidateQueries({ queryKey: workspaceKeys.bootstrap(workspaceId) })

      if (context?.previousUnreadState) {
        void db.unreadState.put(context.previousUnreadState)
      }
    },
  })
}

export function useMarkAllActivityRead(workspaceId: string) {
  const activityService = useActivityService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => activityService.markAllAsRead(workspaceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: activityKeys.list(workspaceId) })

      // Mark-all clears the held set; the derived counts follow to zero.
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        if (!old) return old
        return { ...old, unreadActivities: [], ...deriveActivityCounts([]) }
      })

      void db.transaction("rw", [db.unreadState], async () => {
        const state = await db.unreadState.get(workspaceId)
        if (!state) return
        const now = Date.now()
        // Touch every stream that had a held row so an in-flight bootstrap's
        // per-stream merge can't resurrect the cleared set from its snapshot.
        const counterTouchedAt = { ...state.counterTouchedAt }
        for (const a of state.unreadActivities ?? []) {
          if (a.streamId) counterTouchedAt[a.streamId] = now
        }
        await db.unreadState.put({
          ...state,
          unreadActivities: [],
          ...deriveActivityCounts([]),
          counterTouchedAt,
          _cachedAt: now,
        })
      })
    },
  })
}
