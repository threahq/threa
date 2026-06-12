import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useActivityService } from "@/contexts"
import { workspaceKeys } from "./use-workspaces"
import { db } from "@/db"
import type { Activity, WorkspaceBootstrap } from "@threa/types"

export const activityKeys = {
  all: ["activity"] as const,
  list: (workspaceId: string) => ["activity", workspaceId] as const,
  listFiltered: (workspaceId: string, filters: { unreadOnly: boolean; mineOnly: boolean; othersOnly: boolean }) =>
    ["activity", workspaceId, filters] as const,
}

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
    queryFn: () => activityService.list(workspaceId, { limit: 50, unreadOnly, mineOnly, othersOnly }),
    // Subscribe-then-bootstrap pattern:
    // staleTime: Infinity prevents auto-refetch; socket events invalidate when needed.
    // refetchOnMount: true triggers refetch when data is stale (after invalidation).
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
      // Optimistic update: mark as read in cache
      await queryClient.cancelQueries({ queryKey: activityKeys.list(workspaceId) })

      let target: Activity | undefined
      queryClient.setQueriesData<Activity[]>({ queryKey: activityKeys.list(workspaceId) }, (old) => {
        if (!old) return old
        return old.map((a) => {
          if (a.id !== activityId) return a
          target ??= a
          return { ...a, readAt: new Date().toISOString() }
        })
      })

      // Decrement the per-stream counts together with the workspace total:
      // absolute counter events rederive the total as Σ activityCounts
      // (sync-v2 phase 2c), so a total-only decrement would resurrect on the
      // next apply. Rows already read (or self rows) never counted. When the
      // row isn't in any cached list we can't resolve its stream — decrement
      // the total alone and let the next absolute apply settle it.
      const wasUnread = target ? !target.readAt && !target.isSelf : true
      const streamId = target?.streamId
      const isMention = target?.activityType === "mention"
      if (!wasUnread) return { previousUnreadState: undefined }

      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        if (!old) return old
        return {
          ...old,
          unreadActivityCount: Math.max(0, (old.unreadActivityCount ?? 0) - 1),
          ...(streamId
            ? {
                activityCounts: {
                  ...old.activityCounts,
                  [streamId]: Math.max(0, (old.activityCounts[streamId] ?? 0) - 1),
                },
                mentionCounts: isMention
                  ? { ...old.mentionCounts, [streamId]: Math.max(0, (old.mentionCounts[streamId] ?? 0) - 1) }
                  : old.mentionCounts,
              }
            : {}),
        }
      })

      const previousUnreadState = await db.unreadState.get(workspaceId)
      if (previousUnreadState) {
        await db.unreadState.put({
          ...previousUnreadState,
          unreadActivityCount: Math.max(0, previousUnreadState.unreadActivityCount - 1),
          ...(streamId
            ? {
                activityCounts: {
                  ...previousUnreadState.activityCounts,
                  [streamId]: Math.max(0, (previousUnreadState.activityCounts[streamId] ?? 0) - 1),
                },
                mentionCounts: isMention
                  ? {
                      ...previousUnreadState.mentionCounts,
                      [streamId]: Math.max(0, (previousUnreadState.mentionCounts[streamId] ?? 0) - 1),
                    }
                  : previousUnreadState.mentionCounts,
              }
            : {}),
          _cachedAt: Date.now(),
        })
      }

      return { previousUnreadState }
    },
    onError: (_error, _activityId, context) => {
      // Rollback: refetch on error
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
      // Clear all activity data and counts
      queryClient.invalidateQueries({ queryKey: activityKeys.list(workspaceId) })

      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        if (!old) return old
        const clearedMentionCounts: Record<string, number> = {}
        const clearedActivityCounts: Record<string, number> = {}
        for (const key of Object.keys(old.mentionCounts)) {
          clearedMentionCounts[key] = 0
        }
        for (const key of Object.keys(old.activityCounts)) {
          clearedActivityCounts[key] = 0
        }
        return {
          ...old,
          mentionCounts: clearedMentionCounts,
          activityCounts: clearedActivityCounts,
          unreadActivityCount: 0,
        }
      })

      void db.transaction("rw", [db.unreadState], async () => {
        const state = await db.unreadState.get(workspaceId)
        if (!state) return

        const clearedMentionCounts: Record<string, number> = {}
        const clearedActivityCounts: Record<string, number> = {}
        for (const key of Object.keys(state.mentionCounts)) {
          clearedMentionCounts[key] = 0
        }
        for (const key of Object.keys(state.activityCounts)) {
          clearedActivityCounts[key] = 0
        }

        await db.unreadState.put({
          ...state,
          mentionCounts: clearedMentionCounts,
          activityCounts: clearedActivityCounts,
          unreadActivityCount: 0,
          _cachedAt: Date.now(),
        })
      })
    },
  })
}
