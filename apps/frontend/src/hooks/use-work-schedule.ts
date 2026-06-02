import { useQuery, useQueryClient } from "@tanstack/react-query"
import { type WorkspaceBootstrap, type WorkSchedule, DEFAULT_WORK_SCHEDULE } from "@threa/types"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { usePreferencesOptional } from "@/contexts"
import { resolveWorkSchedule } from "@/lib/work-schedule"

/**
 * The workspace-wide default working schedule (read from the bootstrap cache via
 * the cache-only observer pattern). Falls back to Mon–Fri 09:00 when absent.
 * Used by settings surfaces that need the default independently of any personal
 * override.
 */
export function useWorkspaceDefaultWorkSchedule(workspaceId: string): WorkSchedule {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: workspaceKeys.bootstrap(workspaceId),
    queryFn: () => queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId)) ?? null,
    enabled: false,
    staleTime: Infinity,
    select: (bootstrap) => bootstrap?.workspaceSettings?.defaultWorkSchedule ?? null,
  })
  return data ?? DEFAULT_WORK_SCHEDULE
}

/**
 * The working schedule that should drive schedule-aware presets for the current
 * viewer: their personal override (IDB-backed, offline-safe) layered over the
 * workspace default (read from the bootstrap cache via the cache-only observer
 * pattern). Falls back to Mon–Fri 09:00 when neither is available.
 */
export function useEffectiveWorkSchedule(workspaceId: string): WorkSchedule {
  const queryClient = useQueryClient()
  const userSchedule = usePreferencesOptional()?.preferences?.workSchedule ?? null

  const { data: workspaceDefault } = useQuery({
    queryKey: workspaceKeys.bootstrap(workspaceId),
    queryFn: () => queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId)) ?? null,
    enabled: false,
    staleTime: Infinity,
    select: (bootstrap) => bootstrap?.workspaceSettings?.defaultWorkSchedule ?? null,
  })

  return resolveWorkSchedule(userSchedule, workspaceDefault)
}
