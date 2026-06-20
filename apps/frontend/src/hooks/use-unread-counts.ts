import { useCallback, useRef } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useWorkspaceService, useStreamService } from "@/contexts"
import { workspaceKeys } from "./use-workspaces"
import { streamKeys } from "./use-streams"
import { useWorkspaceUnreadState } from "@/stores/workspace-store"
import { db } from "@/db"
import type { WorkspaceBootstrap } from "@threa/types"

export function useUnreadCounts(workspaceId: string) {
  const queryClient = useQueryClient()
  const streamService = useStreamService()
  const workspaceService = useWorkspaceService()

  // Read from IDB via useLiveQuery — reactive and offline-capable.
  // Use refs so callback identity stays stable; the sidebar memos that
  // depend on these callbacks won't recompute on every IDB write.
  const unreadState = useWorkspaceUnreadState(workspaceId)
  const unreadCounts = unreadState?.unreadCounts ?? {}
  const unreadCountsRef = useRef(unreadCounts)
  unreadCountsRef.current = unreadCounts

  const getUnreadCount = useCallback((streamId: string): number => unreadCountsRef.current[streamId] ?? 0, [])

  const getTotalUnreadCount = useCallback(
    (): number => Object.values(unreadCountsRef.current).reduce((sum, count) => sum + count, 0),
    []
  )

  const markAsReadMutation = useMutation({
    mutationFn: ({ streamId, lastEventId }: { streamId: string; lastEventId: string; partial?: boolean }) =>
      streamService.markAsRead(workspaceId, streamId, lastEventId),
    onSuccess: async (membership, { streamId, lastEventId, partial }) => {
      const current = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId))
      const hadActivity = (current?.activityCounts[streamId] ?? 0) > 0

      // A partial read advances the read pointer to a mid-window event with
      // unread still below it. Zeroing the counters optimistically would be
      // wrong AND sticky: the ordinal read position MAX-merges (see
      // `applyStreamReadOrdinal`), so once forced to "read = latest" the
      // server's `stream:read` for the mid event can never restore the
      // remaining count. So for a partial read only the read POINTER moves
      // optimistically; the badge resolves to the true remainder on the
      // `stream:read` round-trip.
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        if (!old) return old
        const clearedActivity = old.activityCounts[streamId] ?? 0
        const counters = partial
          ? {}
          : {
              unreadCounts: { ...old.unreadCounts, [streamId]: 0 },
              mentionCounts: { ...old.mentionCounts, [streamId]: 0 },
              activityCounts: { ...old.activityCounts, [streamId]: 0 },
              unreadActivityCount: Math.max(0, (old.unreadActivityCount ?? 0) - clearedActivity),
            }
        return {
          ...old,
          ...counters,
          streamMemberships: old.streamMemberships.map((existingMembership) =>
            existingMembership.streamId === streamId ? { ...existingMembership, ...membership } : existingMembership
          ),
        }
      })

      queryClient.setQueryData(
        streamKeys.bootstrap(workspaceId, streamId),
        (old: import("@threa/types").StreamBootstrap | undefined) => {
          if (!old) return old
          return { ...old, membership: { ...old.membership, lastReadEventId: lastEventId } }
        }
      )

      // Keep both the denormalized stream row and the membership row in sync:
      // stream-content derives the unread divider from membership state.
      await db.transaction("rw", [db.unreadState, db.streams, db.streamMemberships], async () => {
        const now = Date.now()
        const state = await db.unreadState.get(workspaceId)
        if (state && !partial) {
          const clearedActivity = state.activityCounts[streamId] ?? 0
          await db.unreadState.put({
            ...state,
            unreadCounts: { ...state.unreadCounts, [streamId]: 0 },
            mentionCounts: { ...state.mentionCounts, [streamId]: 0 },
            activityCounts: { ...state.activityCounts, [streamId]: 0 },
            unreadActivityCount: Math.max(0, state.unreadActivityCount - clearedActivity),
            _cachedAt: now,
          })
        }

        await db.streams.update(streamId, { lastReadEventId: lastEventId, _cachedAt: now })

        const membershipId = `${workspaceId}:${streamId}`
        const existingMembership = await db.streamMemberships.get(membershipId)
        if (existingMembership) {
          await db.streamMemberships.put({
            ...existingMembership,
            ...membership,
            id: membershipId,
            workspaceId,
            _cachedAt: now,
          })
        } else {
          await db.streamMemberships.put({
            ...membership,
            id: membershipId,
            workspaceId,
            _cachedAt: now,
          })
        }
      })

      if (hadActivity) {
        queryClient.invalidateQueries({ queryKey: ["activity", workspaceId] })
      }
    },
  })

  // Mark a message (and everything after it) unread. Only the read POINTER
  // moves optimistically — the membership reseed makes the unread divider
  // appear at once; the unread COUNT rises on the `stream:read_set` round-trip
  // (applyStreamReadSet SETs it, which is allowed to move backward). Mirrors the
  // partial markAsRead path, which likewise defers the count to the round-trip.
  const markUnreadMutation = useMutation({
    mutationFn: ({ streamId, messageId }: { streamId: string; messageId: string }) =>
      streamService.markUnread(workspaceId, streamId, messageId),
    onSuccess: async (membership, { streamId }) => {
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        if (!old) return old
        return {
          ...old,
          streamMemberships: old.streamMemberships.map((existingMembership) =>
            existingMembership.streamId === streamId ? { ...existingMembership, ...membership } : existingMembership
          ),
        }
      })

      queryClient.setQueryData(
        streamKeys.bootstrap(workspaceId, streamId),
        (old: import("@threa/types").StreamBootstrap | undefined) => {
          if (!old) return old
          return { ...old, membership: { ...old.membership, lastReadEventId: membership.lastReadEventId } }
        }
      )

      await db.transaction("rw", [db.streams, db.streamMemberships], async () => {
        const now = Date.now()
        await db.streams.update(streamId, { lastReadEventId: membership.lastReadEventId, _cachedAt: now })

        const membershipId = `${workspaceId}:${streamId}`
        const existingMembership = await db.streamMemberships.get(membershipId)
        if (existingMembership) {
          await db.streamMemberships.put({
            ...existingMembership,
            ...membership,
            id: membershipId,
            workspaceId,
            _cachedAt: now,
          })
        } else {
          await db.streamMemberships.put({
            ...membership,
            id: membershipId,
            workspaceId,
            _cachedAt: now,
          })
        }
      })
    },
  })

  const markAllAsReadMutation = useMutation({
    mutationFn: () => workspaceService.markAllAsRead(workspaceId),
    onSuccess: (updatedStreamIds) => {
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        if (!old) return old
        const newUnread = { ...old.unreadCounts }
        const newMention = { ...old.mentionCounts }
        const newActivity = { ...old.activityCounts }
        for (const streamId of updatedStreamIds) {
          newUnread[streamId] = 0
          newMention[streamId] = 0
          newActivity[streamId] = 0
        }
        return {
          ...old,
          unreadCounts: newUnread,
          mentionCounts: newMention,
          activityCounts: newActivity,
          unreadActivityCount: 0,
        }
      })

      db.transaction("rw", [db.unreadState], async () => {
        const state = await db.unreadState.get(workspaceId)
        if (!state) return
        const newUnread = { ...state.unreadCounts }
        const newMention = { ...state.mentionCounts }
        const newActivity = { ...state.activityCounts }
        for (const streamId of updatedStreamIds) {
          newUnread[streamId] = 0
          newMention[streamId] = 0
          newActivity[streamId] = 0
        }
        await db.unreadState.put({
          ...state,
          unreadCounts: newUnread,
          mentionCounts: newMention,
          activityCounts: newActivity,
          unreadActivityCount: 0,
          _cachedAt: Date.now(),
        })
      })
    },
  })

  const markAsRead = useCallback(
    (streamId: string, lastEventId: string, opts?: { partial?: boolean }) => {
      markAsReadMutation.mutate({ streamId, lastEventId, partial: opts?.partial })
    },
    [markAsReadMutation]
  )

  const markAllAsRead = useCallback(() => {
    markAllAsReadMutation.mutate()
  }, [markAllAsReadMutation])

  const markUnread = useCallback(
    (streamId: string, messageId: string) => {
      markUnreadMutation.mutate({ streamId, messageId })
    },
    [markUnreadMutation]
  )

  return {
    unreadCounts,
    getUnreadCount,
    getTotalUnreadCount,
    markAsRead,
    markUnread,
    markAllAsRead,
    isMarkingAsRead: markAsReadMutation.isPending,
    isMarkingAllAsRead: markAllAsReadMutation.isPending,
  }
}
