import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  defaultFeatureFlagValue,
  type FeatureFlagKey,
  type FeatureFlagValue,
  type WorkspaceBootstrap,
} from "@threa/types"
import { workspaceKeys } from "@/hooks/use-workspaces"

/**
 * The current viewer's value for a feature flag. Reads the bootstrap cache
 * via the cache-only observer pattern; the `feature_flags:updated` socket
 * event keeps the value live, so a backoffice change flips this hook without
 * a reload. Returns the flag's default (first declared value) until the
 * bootstrap is cached — "unknown yet" and "default" render the same.
 */
export function useFeatureFlag<K extends FeatureFlagKey>(workspaceId: string, key: K): FeatureFlagValue<K> {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: workspaceKeys.bootstrap(workspaceId),
    queryFn: () => queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId)) ?? null,
    enabled: false,
    staleTime: Infinity,
    select: (bootstrap) => bootstrap?.featureFlags?.[key] ?? null,
  })
  return data ?? defaultFeatureFlagValue(key)
}
