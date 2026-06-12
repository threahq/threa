import { useQuery, useQueryClient } from "@tanstack/react-query"
import { type WorkspaceBootstrap, type FeatureFlagKey } from "@threa/types"
import { workspaceKeys } from "@/hooks/use-workspaces"

/**
 * Whether a feature flag is on for the current viewer. Reads the bootstrap
 * cache via the cache-only observer pattern; the `feature_flags:updated`
 * socket event keeps the value live, so a backoffice toggle flips this hook
 * without a reload. Returns false until the bootstrap is cached — flags
 * default to off, so "unknown yet" and "off" render the same.
 */
export function useFeatureFlag(workspaceId: string, key: FeatureFlagKey): boolean {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: workspaceKeys.bootstrap(workspaceId),
    queryFn: () => queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId)) ?? null,
    enabled: false,
    staleTime: Infinity,
    select: (bootstrap) => bootstrap?.featureFlags?.[key] ?? false,
  })
  return data ?? false
}
