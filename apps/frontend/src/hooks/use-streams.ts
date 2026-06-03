import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useSocket, useStreamService } from "@/contexts"
import { debugBootstrap } from "@/lib/bootstrap-debug"
import { getQueryLoadState, isTerminalBootstrapError } from "@/lib/query-load-state"
import { STREAM_BOOTSTRAP_QUERY_OPTIONS } from "@/lib/stream-bootstrap-query"
import { db } from "@/db"
import { joinRoomBestEffort } from "@/lib/socket-room"
import { applyStreamBootstrap, toCachedStreamBootstrap, type CachedStreamBootstrap } from "@/sync/stream-sync"
import type {
  Stream,
  StreamMember,
  StreamType,
  StreamBootstrap,
  WorkspaceBootstrap,
  NotificationLevel,
  CompanionMode,
} from "@threa/types"
import type { CreateStreamInput, UpdateStreamInput } from "@/api"
import { workspaceKeys } from "./use-workspaces"
import { useSyncEngine } from "@/sync/sync-engine"

// Query keys for cache management
export const streamKeys = {
  all: ["streams"] as const,
  lists: () => [...streamKeys.all, "list"] as const,
  list: (workspaceId: string, filters?: { type?: StreamType }) =>
    [...streamKeys.lists(), workspaceId, filters] as const,
  details: () => [...streamKeys.all, "detail"] as const,
  detail: (workspaceId: string, streamId: string) => [...streamKeys.details(), workspaceId, streamId] as const,
  bootstrap: (workspaceId: string, streamId: string) =>
    [...streamKeys.all, "bootstrap", workspaceId, streamId] as const,
  events: (workspaceId: string, streamId: string) => [...streamKeys.all, "events", workspaceId, streamId] as const,
}

export function useStreams(workspaceId: string, filters?: { type?: StreamType }) {
  const streamService = useStreamService()

  return useQuery({
    queryKey: streamKeys.list(workspaceId, filters),
    queryFn: async () => {
      const streams = await streamService.list(workspaceId, filters)

      // Cache to IndexedDB
      const now = Date.now()
      await db.streams.bulkPut(streams.map((s) => ({ ...s, _cachedAt: now })))

      return streams
    },
    enabled: !!workspaceId,
  })
}

export function useStream(workspaceId: string, streamId: string) {
  const streamService = useStreamService()

  return useQuery({
    queryKey: streamKeys.detail(workspaceId, streamId),
    queryFn: async () => {
      const stream = await streamService.get(workspaceId, streamId)

      // Cache to IndexedDB
      await db.streams.put({ ...stream, _cachedAt: Date.now() })

      return stream
    },
    enabled: !!workspaceId && !!streamId,
  })
}

export function useStreamBootstrap(workspaceId: string, streamId: string, options?: { enabled?: boolean }) {
  const socket = useSocket()
  const streamService = useStreamService()
  const queryClient = useQueryClient()

  // Check if this query has already errored - don't re-enable if so
  // This prevents continuous refetching when a stream doesn't exist
  const existingQueryState = queryClient.getQueryState(streamKeys.bootstrap(workspaceId, streamId))
  const hasTerminalError = existingQueryState?.status === "error" && isTerminalBootstrapError(existingQueryState.error)

  const query = useQuery({
    queryKey: streamKeys.bootstrap(workspaceId, streamId),
    queryFn: async () => {
      debugBootstrap("Stream bootstrap queryFn start", { workspaceId, streamId, hasSocket: !!socket })
      if (!socket) {
        debugBootstrap("Stream bootstrap missing socket", { workspaceId, streamId })
        throw new Error("Socket not available for stream subscription")
      }
      await joinRoomBestEffort(socket, `ws:${workspaceId}:stream:${streamId}`, "StreamBootstrap")

      const bootstrap = await streamService.bootstrap(workspaceId, streamId)
      debugBootstrap("Stream bootstrap fetch success", {
        workspaceId,
        streamId,
        eventCount: bootstrap.events.length,
      })

      // Write events and stream metadata to IndexedDB.
      // The sync module handles optimistic event cleanup.
      await applyStreamBootstrap(workspaceId, streamId, bootstrap)

      return toCachedStreamBootstrap(
        bootstrap,
        queryClient.getQueryData<CachedStreamBootstrap>(streamKeys.bootstrap(workspaceId, streamId)),
        { incrementWindowVersionOnReplace: bootstrap.syncMode === "replace" }
      )
    },
    // Terminal 403/404 disables the query to prevent loops; recoverable errors
    // self-heal via STREAM_BOOTSTRAP_QUERY_OPTIONS.retry.
    enabled: (options?.enabled ?? true) && !!workspaceId && !!streamId && !!socket && !hasTerminalError,
    ...STREAM_BOOTSTRAP_QUERY_OPTIONS,
  })

  const loadState = getQueryLoadState(query.status, query.fetchStatus)

  debugBootstrap("Stream bootstrap observer state", {
    workspaceId,
    streamId,
    enabled: (options?.enabled ?? true) && !!workspaceId && !!streamId && !!socket && !hasTerminalError,
    hasTerminalError,
    loadState,
    status: query.status,
    fetchStatus: query.fetchStatus,
    isPending: query.isPending,
    isLoading: query.isLoading,
    isError: query.isError,
  })

  return { ...query, loadState }
}

export function useCreateStream(workspaceId: string) {
  const streamService = useStreamService()
  const queryClient = useQueryClient()
  const syncEngine = useSyncEngine()

  return useMutation({
    mutationFn: (data: CreateStreamInput) => streamService.create(workspaceId, data),
    onSuccess: async (newStream) => {
      const membership: StreamMember = {
        streamId: newStream.id,
        memberId: newStream.createdBy,
        pinned: false,
        pinnedAt: null,
        notificationLevel: null,
        lastReadEventId: null,
        lastReadAt: null,
        joinedAt: newStream.createdAt,
      }

      // Register the new stream with the sync engine immediately so the
      // creator gets stream-level realtime before the workspace socket echo
      // or next bootstrap catches up.
      void syncEngine.subscribeStream(newStream.id)

      // Update workspace bootstrap cache so sidebar shows the new stream immediately
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        if (!old) return old
        if (old.streams.some((s) => s.id === newStream.id)) return old

        return {
          ...old,
          streams: [...old.streams, { ...newStream, lastMessagePreview: null }],
          streamMemberships: [...old.streamMemberships, membership],
        }
      })

      // Invalidate stream lists to refetch
      queryClient.invalidateQueries({ queryKey: streamKeys.lists() })

      const now = Date.now()
      await Promise.all([
        db.streams.put({ ...newStream, _cachedAt: now }),
        db.streamMemberships.put({
          id: `${workspaceId}:${newStream.id}`,
          workspaceId,
          streamId: newStream.id,
          memberId: newStream.createdBy,
          pinned: false,
          pinnedAt: null,
          notificationLevel: null,
          lastReadEventId: null,
          lastReadAt: null,
          joinedAt: newStream.createdAt,
          _cachedAt: now,
        }),
      ])
    },
  })
}

export function useUpdateStream(workspaceId: string, streamId: string) {
  const streamService = useStreamService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: UpdateStreamInput) => streamService.update(workspaceId, streamId, data),
    onSuccess: (updatedStream) => {
      // Update detail cache
      queryClient.setQueryData<Stream>(streamKeys.detail(workspaceId, streamId), updatedStream)

      // Update stream-specific bootstrap cache (preserving events, members, etc.)
      queryClient.setQueryData(streamKeys.bootstrap(workspaceId, streamId), (old: unknown) => {
        if (!old || typeof old !== "object") return old
        return { ...old, stream: updatedStream }
      })

      // Update workspace bootstrap cache (sidebar uses this)
      queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), (old: unknown) => {
        if (!old || typeof old !== "object") return old
        const bootstrap = old as { streams?: Stream[] }
        if (!bootstrap.streams) return old
        return {
          ...bootstrap,
          streams: bootstrap.streams.map((s) => (s.id === streamId ? updatedStream : s)),
        }
      })

      // Invalidate lists as fallback
      queryClient.invalidateQueries({ queryKey: streamKeys.lists() })

      // Cache to IndexedDB
      db.streams.put({ ...updatedStream, _cachedAt: Date.now() })
    },
  })
}

export function useUpdateCompanionMode(workspaceId: string, streamId: string) {
  const streamService = useStreamService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (companionMode: CompanionMode) =>
      streamService.updateCompanionMode(workspaceId, streamId, { companionMode }),
    onSuccess: (updatedStream) => {
      queryClient.setQueryData<Stream>(streamKeys.detail(workspaceId, streamId), updatedStream)

      queryClient.setQueryData(streamKeys.bootstrap(workspaceId, streamId), (old: unknown) => {
        if (!old || typeof old !== "object") return old
        return { ...old, stream: updatedStream }
      })

      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        if (!old) return old
        return {
          ...old,
          streams: old.streams.map((s) =>
            s.id === streamId ? { ...s, ...updatedStream, lastMessagePreview: s.lastMessagePreview } : s
          ),
        }
      })

      db.streams.put({ ...updatedStream, _cachedAt: Date.now() })
    },
  })
}

export function useArchiveStream(workspaceId: string) {
  const streamService = useStreamService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (streamId: string) => streamService.archive(workspaceId, streamId),
    onSuccess: (_, streamId) => {
      // Remove from stream-specific caches
      queryClient.removeQueries({ queryKey: streamKeys.detail(workspaceId, streamId) })
      queryClient.removeQueries({ queryKey: streamKeys.bootstrap(workspaceId, streamId) })

      // Remove from workspace bootstrap cache (sidebar)
      queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), (old: unknown) => {
        if (!old || typeof old !== "object") return old
        const bootstrap = old as { streams?: Stream[] }
        if (!bootstrap.streams) return old
        return {
          ...bootstrap,
          streams: bootstrap.streams.filter((s) => s.id !== streamId),
        }
      })

      // Invalidate lists as fallback
      queryClient.invalidateQueries({ queryKey: streamKeys.lists() })

      // Remove from IndexedDB
      db.streams.delete(streamId)
    },
  })
}

// Backwards compatibility alias
export const useDeleteStream = useArchiveStream

export function useUnarchiveStream(workspaceId: string) {
  const streamService = useStreamService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (streamId: string) => streamService.unarchive(workspaceId, streamId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: streamKeys.lists() })
      queryClient.invalidateQueries({ queryKey: workspaceKeys.bootstrap(workspaceId) })
    },
  })
}

export function useSetNotificationLevel(workspaceId: string, streamId: string) {
  const streamService = useStreamService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (notificationLevel: NotificationLevel | null) =>
      streamService.setNotificationLevel(workspaceId, streamId, notificationLevel),
    onSuccess: (membership) => {
      // Update stream bootstrap membership
      queryClient.setQueryData<StreamBootstrap>(streamKeys.bootstrap(workspaceId, streamId), (old) => {
        if (!old) return old
        return { ...old, membership }
      })

      // Update workspace bootstrap streamMemberships
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        if (!old) return old
        return {
          ...old,
          streamMemberships: old.streamMemberships.map((sm) =>
            sm.streamId === streamId ? { ...sm, notificationLevel: membership.notificationLevel } : sm
          ),
        }
      })
    },
  })
}

/**
 * Pin / unpin a stream for the viewer. Pinning is a per-membership setting that
 * drives the sidebar's "Pinned" section, which reads memberships straight from
 * IDB — so this writes the new state to IDB optimistically (reverting on error)
 * for an instant sidebar update, then reconciles with the server's authoritative
 * `pinnedAt` and keeps the workspace bootstrap query cache in sync.
 */
export function usePinStream(workspaceId: string) {
  const queryClient = useQueryClient()
  const streamService = useStreamService()

  return useMutation({
    mutationFn: ({ streamId, pinned }: { streamId: string; pinned: boolean }) =>
      streamService.pin(workspaceId, streamId, pinned),
    onMutate: async ({ streamId, pinned }) => {
      const membershipId = `${workspaceId}:${streamId}`
      const previous = await db.streamMemberships.get(membershipId)
      if (previous) {
        await db.streamMemberships.put({
          ...previous,
          pinned,
          pinnedAt: pinned ? (previous.pinnedAt ?? new Date().toISOString()) : null,
          _cachedAt: Date.now(),
        })
      }
      return { previous }
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) void db.streamMemberships.put(context.previous)
    },
    onSuccess: async (membership, { streamId }) => {
      const membershipId = `${workspaceId}:${streamId}`
      const current = await db.streamMemberships.get(membershipId)
      if (current) {
        await db.streamMemberships.put({
          ...current,
          ...membership,
          id: membershipId,
          workspaceId,
          _cachedAt: Date.now(),
        })
      }

      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        if (!old) return old
        return {
          ...old,
          streamMemberships: old.streamMemberships.map((sm) =>
            sm.streamId === streamId ? { ...sm, pinned: membership.pinned, pinnedAt: membership.pinnedAt } : sm
          ),
        }
      })
    },
  })
}

export function useAddStreamMember(workspaceId: string, streamId: string) {
  const streamService = useStreamService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (memberId: string) => streamService.addMember(workspaceId, streamId, memberId),
    onSuccess: (membership) => {
      queryClient.setQueryData(streamKeys.bootstrap(workspaceId, streamId), (old: unknown) => {
        if (!old || typeof old !== "object") return old
        const bootstrap = old as { members?: StreamMember[] }
        if (!bootstrap.members) return old
        const exists = bootstrap.members.some((m) => m.memberId === membership.memberId)
        if (exists) return old
        return { ...bootstrap, members: [...bootstrap.members, membership] }
      })
    },
  })
}

export function useRemoveStreamMember(workspaceId: string, streamId: string) {
  const streamService = useStreamService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (memberId: string) => streamService.removeMember(workspaceId, streamId, memberId),
    onSuccess: (_, memberId) => {
      queryClient.setQueryData(streamKeys.bootstrap(workspaceId, streamId), (old: unknown) => {
        if (!old || typeof old !== "object") return old
        const bootstrap = old as { members?: StreamMember[] }
        if (!bootstrap.members) return old
        return { ...bootstrap, members: bootstrap.members.filter((m) => m.memberId !== memberId) }
      })
    },
  })
}
