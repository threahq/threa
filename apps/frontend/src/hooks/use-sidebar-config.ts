import { useCallback, useMemo, useRef } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  type SidebarConfig,
  type SidebarBasePreset,
  type WorkspaceBootstrap,
  DEFAULT_SIDEBAR_CONFIG,
  sidebarConfigForPreset,
  normalizeSidebarConfig,
} from "@threa/types"
import { sidebarConfigApi } from "@/api"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { useWorkspaceSidebarConfig } from "@/stores/workspace-store"
import { db } from "@/db"

/**
 * Read + write the viewer's persisted sidebar layout for a workspace. Reads come
 * from the IDB-backed store (instant + offline, like every other sidebar entity)
 * and fall back to the default config; writes optimistically update both the
 * bootstrap query cache and IDB, then persist server-side. The server broadcasts
 * a `sidebar_config:updated` event so the user's other devices converge.
 */
export function useSidebarConfig(workspaceId: string) {
  const queryClient = useQueryClient()
  // Monotonic id so a slow earlier write can't clobber a newer choice when
  // rapid Smart↔All toggles settle out of order — only the latest mutation's
  // settlement is allowed to touch the cache / rollback.
  const latestMutationIdRef = useRef(0)
  const cached = useWorkspaceSidebarConfig(workspaceId)
  // Normalize so a document persisted before quick links were configurable (or
  // any partial list) reads back with the full, ordered quick-link set. Memoized
  // on the cached row so the reference stays stable for downstream `useMemo` deps.
  const config = useMemo(() => normalizeSidebarConfig(cached?.config ?? DEFAULT_SIDEBAR_CONFIG), [cached])

  const mutation = useMutation({
    mutationFn: (next: SidebarConfig) => sidebarConfigApi.update(workspaceId, next),
    onMutate: async (next) => {
      const mutationId = ++latestMutationIdRef.current
      await queryClient.cancelQueries({ queryKey: workspaceKeys.bootstrap(workspaceId) })
      const previousBootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId))

      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) =>
        old ? { ...old, sidebarConfig: next } : old
      )
      // Write to IDB immediately so the live-query consumers reflect the change
      // without waiting for the socket round-trip.
      db.sidebarConfigs.put({ id: workspaceId, workspaceId, config: next, _cachedAt: Date.now() })

      return { previousBootstrap, previousConfig: cached, mutationId }
    },
    onError: (_err, _next, context) => {
      // Ignore a stale failure once a newer toggle has superseded it.
      if (!context || context.mutationId !== latestMutationIdRef.current) return
      if (context.previousBootstrap) {
        queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), context.previousBootstrap)
      }
      if (context.previousConfig) {
        db.sidebarConfigs.put(context.previousConfig)
      } else {
        db.sidebarConfigs.delete(workspaceId)
      }
      toast.error("Failed to save sidebar layout")
    },
    onSuccess: (saved, _next, context) => {
      // Ignore a stale success that resolved after a newer toggle.
      if (!context || context.mutationId !== latestMutationIdRef.current) return
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) =>
        old ? { ...old, sidebarConfig: saved } : old
      )
    },
  })

  const setConfig = useCallback((next: SidebarConfig) => mutation.mutate(next), [mutation])
  const setBasePreset = useCallback(
    (preset: SidebarBasePreset) => mutation.mutate(sidebarConfigForPreset(preset)),
    [mutation]
  )

  return { config, setConfig, setBasePreset, isSaving: mutation.isPending }
}
