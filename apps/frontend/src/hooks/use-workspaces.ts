import { useCallback, useMemo } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useLiveQuery } from "dexie-react-hooks"
import { useSocket, useWorkspaceService } from "@/contexts"
import { useUser } from "@/auth"
import { debugBootstrap } from "@/lib/bootstrap-debug"
import { getQueryLoadState, isTerminalBootstrapError } from "@/lib/query-load-state"
import { db } from "@/db"
import { joinRoomBestEffort } from "@/lib/socket-room"
import { applyWorkspaceBootstrap } from "@/sync/workspace-sync"
import { useWorkspaceUsers, upsertWorkspaceUserInCache } from "@/stores/workspace-store"
import type { WorkspaceBootstrap, User } from "@threa/types"
import type { WorkspaceListResult } from "@/api/workspaces"

// Query keys for cache management
export const workspaceKeys = {
  all: ["workspaces"] as const,
  lists: () => [...workspaceKeys.all, "list"] as const,
  list: () => [...workspaceKeys.lists()] as const,
  details: () => [...workspaceKeys.all, "detail"] as const,
  detail: (id: string) => [...workspaceKeys.details(), id] as const,
  bootstrap: (id: string) => [...workspaceKeys.all, "bootstrap", id] as const,
}

export function useWorkspaces() {
  const workspaceService = useWorkspaceService()

  const query = useQuery({
    queryKey: workspaceKeys.list(),
    queryFn: async () => {
      const result = await workspaceService.list()

      // Cache to IndexedDB
      const now = Date.now()
      await db.workspaces.bulkPut(result.workspaces.map((w) => ({ ...w, _cachedAt: now })))

      return result
    },
  })

  // Read back the IDB cache the query above writes — this closes the
  // previously write-only loop so a returning user can render their
  // workspaces instantly while the list query revalidates in the background.
  const cachedWorkspaces = useLiveQuery(() => db.workspaces.toArray(), [])

  return {
    ...query,
    workspaces: query.data?.workspaces,
    cachedWorkspaces,
    pendingInvitations: query.data?.pendingInvitations ?? [],
  }
}

export function useAcceptInvitation() {
  const workspaceService = useWorkspaceService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (invitationId: string) => workspaceService.acceptInvitation(invitationId),
    onSuccess: () => {
      // Fire-and-forget: don't await so per-call onSuccess (navigate) fires promptly
      // and races don't cause the workspace-select auto-redirect to win
      queryClient.invalidateQueries({ queryKey: workspaceKeys.list() })
    },
  })
}

export function useWorkspace(workspaceId: string) {
  const workspaceService = useWorkspaceService()

  return useQuery({
    queryKey: workspaceKeys.detail(workspaceId),
    queryFn: async () => {
      const workspace = await workspaceService.get(workspaceId)

      // Cache to IndexedDB
      await db.workspaces.put({ ...workspace, _cachedAt: Date.now() })

      return workspace
    },
    enabled: !!workspaceId,
  })
}

export function useWorkspaceBootstrap(workspaceId: string) {
  const socket = useSocket()
  const workspaceService = useWorkspaceService()
  const queryClient = useQueryClient()

  // Check if this query has already errored - don't re-enable if so
  // This prevents continuous refetching when the server is down
  const existingQueryState = queryClient.getQueryState(workspaceKeys.bootstrap(workspaceId))
  const hasTerminalError = existingQueryState?.status === "error" && isTerminalBootstrapError(existingQueryState.error)
  const query = useQuery({
    queryKey: workspaceKeys.bootstrap(workspaceId),
    queryFn: async () => {
      debugBootstrap("Workspace bootstrap queryFn start", { workspaceId, hasSocket: !!socket })
      if (!socket) {
        debugBootstrap("Workspace bootstrap missing socket", { workspaceId })
        throw new Error("Socket not available for workspace subscription")
      }
      await joinRoomBestEffort(socket, `ws:${workspaceId}`, "WorkspaceBootstrap")

      // Capture timestamp BEFORE fetch — any socket writes during the fetch
      // will have _cachedAt > fetchStartedAt and survive stale cleanup.
      const fetchStartedAt = Date.now()

      const bootstrap = await workspaceService.bootstrap(workspaceId)
      debugBootstrap("Workspace bootstrap fetch success", {
        workspaceId,
        streamCount: bootstrap.streams.length,
        userCount: bootstrap.users.length,
      })
      // Shred bootstrap into individual IDB tables (including unreadState + userPreferences)
      await applyWorkspaceBootstrap(workspaceId, bootstrap, fetchStartedAt)

      return bootstrap
    },
    // Keep terminal auth/not-found errors disabled to avoid loops.
    // Non-terminal errors can recover automatically on future attempts.
    enabled: !!workspaceId && !!socket && !hasTerminalError,
    // Prevent automatic refetching - socket events handle updates
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  const loadState = getQueryLoadState(query.status, query.fetchStatus)

  debugBootstrap("Workspace bootstrap observer state", {
    workspaceId,
    enabled: !!workspaceId && !!socket && !hasTerminalError,
    hasTerminalError,
    loadState,
    status: query.status,
    fetchStatus: query.fetchStatus,
    isPending: query.isPending,
    isLoading: query.isLoading,
    isError: query.isError,
  })

  // Manual retry that resets error state first
  const retryBootstrap = useCallback(() => {
    queryClient.resetQueries({ queryKey: workspaceKeys.bootstrap(workspaceId) })
  }, [queryClient, workspaceId])

  return { ...query, loadState, retryBootstrap }
}

/**
 * Cache-only observer for the workspace bootstrap. Returns the cached value
 * (or `null`) without ever fetching — pair with `useWorkspaceBootstrap` higher
 * in the tree to populate the cache. Use this in surfaces that only need to
 * read bootstrap-derived state (e.g. `viewerPermissions`, `streams`).
 */
export function useCachedWorkspaceBootstrap(workspaceId: string): WorkspaceBootstrap | null {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: workspaceKeys.bootstrap(workspaceId),
    queryFn: () => queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId)) ?? null,
    enabled: false,
    staleTime: Infinity,
  })
  return data ?? null
}

export function useRegions() {
  const workspaceService = useWorkspaceService()

  return useQuery({
    queryKey: ["regions"] as const,
    queryFn: () => workspaceService.listRegions(),
    staleTime: 5 * 60 * 1000, // 5 minutes
  })
}

export function useCreateWorkspace() {
  const workspaceService = useWorkspaceService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: { name: string; slug: string; region?: string }) => workspaceService.create(data),
    onSuccess: (newWorkspace) => {
      // Update cache with correct WorkspaceListResult shape
      queryClient.setQueryData<WorkspaceListResult>(workspaceKeys.list(), (old) => ({
        workspaces: old ? [...old.workspaces, newWorkspace] : [newWorkspace],
        pendingInvitations: old?.pendingInvitations ?? [],
      }))

      // Cache to IndexedDB
      db.workspaces.put({ ...newWorkspace, _cachedAt: Date.now() })
    },
  })
}

function updateUserInBootstrap(queryClient: ReturnType<typeof useQueryClient>, workspaceId: string, updatedUser: User) {
  queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
    if (!old) return old
    const users = old.users
    return {
      ...old,
      users: users.map((u) => (u.id === updatedUser.id ? updatedUser : u)),
    }
  })

  const cachedUser = { ...updatedUser, _cachedAt: Date.now() }
  db.workspaceUsers.put(cachedUser)
  upsertWorkspaceUserInCache(workspaceId, cachedUser)
}

export function useUpdateProfile(workspaceId: string) {
  const workspaceService = useWorkspaceService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: {
      name?: string
      description?: string | null
      pronouns?: string | null
      phone?: string | null
      githubUsername?: string | null
    }) => workspaceService.updateProfile(workspaceId, data),
    onSuccess: (user) => updateUserInBootstrap(queryClient, workspaceId, user),
  })
}

export function useSetStatus(workspaceId: string) {
  const workspaceService = useWorkspaceService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: {
      emoji: string | null
      text: string | null
      expiresAt: string | null
      pausesNotifications: boolean
    }) => workspaceService.setStatus(workspaceId, data),
    onSuccess: (user) => updateUserInBootstrap(queryClient, workspaceId, user),
  })
}

export function useClearStatus(workspaceId: string) {
  const workspaceService = useWorkspaceService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => workspaceService.clearStatus(workspaceId),
    onSuccess: (user) => updateUserInBootstrap(queryClient, workspaceId, user),
  })
}

/** Pause notifications (do-not-disturb): `until` is an ISO instant, or null for indefinite. */
export function usePauseNotifications(workspaceId: string) {
  const workspaceService = useWorkspaceService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (until: string | null) => workspaceService.pauseNotifications(workspaceId, until),
    onSuccess: (user) => updateUserInBootstrap(queryClient, workspaceId, user),
  })
}

export function useResumeNotifications(workspaceId: string) {
  const workspaceService = useWorkspaceService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => workspaceService.resumeNotifications(workspaceId),
    onSuccess: (user) => updateUserInBootstrap(queryClient, workspaceId, user),
  })
}

export function useUploadAvatar(workspaceId: string) {
  const workspaceService = useWorkspaceService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (file: File) => workspaceService.uploadAvatar(workspaceId, file),
    onSuccess: (user) => updateUserInBootstrap(queryClient, workspaceId, user),
  })
}

/** Returns the workspace-scoped user ID for the current WorkOS user, or null if not found. */
export function useWorkspaceUserId(workspaceId: string): string | null {
  const user = useUser()
  const users = useWorkspaceUsers(workspaceId)
  return useMemo(() => users.find((u) => u.workosUserId === user?.id)?.id ?? null, [users, user?.id])
}

/** Returns the full workspace-scoped User for the current WorkOS user, or null if not found. */
export function useCurrentWorkspaceUser(workspaceId: string): User | null {
  const user = useUser()
  const users = useWorkspaceUsers(workspaceId)
  return useMemo(() => (users.find((u) => u.workosUserId === user?.id) as User | undefined) ?? null, [users, user?.id])
}

export function useRemoveAvatar(workspaceId: string) {
  const workspaceService = useWorkspaceService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => workspaceService.removeAvatar(workspaceId),
    onSuccess: (user) => updateUserInBootstrap(queryClient, workspaceId, user),
  })
}
