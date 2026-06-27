import { useCallback, useRef } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useWorkspaceService, useStreamService } from "@/contexts"
import { workspaceKeys } from "./use-workspaces"
import { streamKeys } from "./use-streams"
import { useWorkspaceUnreadState } from "@/stores/workspace-store"
import { db } from "@/db"
import { deriveActivityCounts } from "@/sync/unread-counters"
import { SW_MSG_CLEAR_NOTIFICATIONS } from "@/lib/sw-messages"
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

      // Coupling (D2/D4): reading a stream clears its held activity rows on BOTH
      // the partial and full paths — activity (e.g. a reaction) is read by opening
      // the stream regardless of message scroll position. The derived activity/
      // mention counts follow the rows.
      //
      // Message unread (`unreadCounts`) is separate and stays on the FULL path
      // only: a partial read advances the read pointer to a mid-window event with
      // unread still below it. Zeroing it optimistically would be wrong AND
      // sticky — the ordinal read position MAX-merges (see `applyStreamReadOrdinal`),
      // so once forced to "read = latest" the server's `stream:read` for the mid
      // event can never restore the remaining count. So for a partial read only
      // the read POINTER moves; the badge resolves to the true remainder on the
      // `stream:read` round-trip.
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        if (!old) return old
        const rows = (old.unreadActivities ?? []).filter((a) => a.streamId !== streamId)
        const messageCounters = partial ? {} : { unreadCounts: { ...old.unreadCounts, [streamId]: 0 } }
        return {
          ...old,
          unreadActivities: rows,
          ...deriveActivityCounts(rows),
          ...messageCounters,
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
        if (state) {
          // Activity drop applies on both paths; `unreadCounts` only on the full
          // path (mirrors the query-cache branch above).
          const rows = (state.unreadActivities ?? []).filter((a) => a.streamId !== streamId)
          await db.unreadState.put({
            ...state,
            unreadActivities: rows,
            ...deriveActivityCounts(rows),
            ...(partial ? {} : { unreadCounts: { ...state.unreadCounts, [streamId]: 0 } }),
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
      // Mark-all-read clears every stream's message unread AND the held activity
      // set (the derived activity/mention counts follow to zero).
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        if (!old) return old
        const newUnread = { ...old.unreadCounts }
        for (const streamId of updatedStreamIds) {
          newUnread[streamId] = 0
        }
        return {
          ...old,
          unreadCounts: newUnread,
          unreadActivities: [],
          ...deriveActivityCounts([]),
        }
      })

      db.transaction("rw", [db.unreadState], async () => {
        const state = await db.unreadState.get(workspaceId)
        if (!state) return
        const newUnread = { ...state.unreadCounts }
        for (const streamId of updatedStreamIds) {
          newUnread[streamId] = 0
        }
        await db.unreadState.put({
          ...state,
          unreadCounts: newUnread,
          unreadActivities: [],
          ...deriveActivityCounts([]),
          _cachedAt: Date.now(),
        })
      })
    },
  })

  const markAsRead = useCallback(
    (streamId: string, lastEventId: string, opts?: { partial?: boolean }) => {
      // Never advance the read pointer to an optimistic event: its temp_ id has no
      // server stream_events row, so persisting it pins the watermark to sequence 0
      // and reports the whole stream — including the user's own messages — as
      // unread. The auto-read effect re-fires with the real id once the server echo
      // swaps it in.
      if (lastEventId.startsWith("temp_")) return
      markAsReadMutation.mutate({ streamId, lastEventId, partial: opts?.partial })
      // Dismiss any push notification for this stream — advancing the read pointer
      // (auto-read, manual "Mark as read", or Escape) means the user is here, so
      // the banner is noise. Centralized on this single read-advance funnel so
      // every caller clears locally, not just auto-read; the backend stream:read
      // round-trip also fans a clear out to the user's other devices.
      navigator.serviceWorker?.controller?.postMessage({ type: SW_MSG_CLEAR_NOTIFICATIONS, streamId })
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
