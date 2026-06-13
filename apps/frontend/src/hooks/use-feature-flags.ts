import { useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  defaultFeatureFlagValue,
  FEATURE_FLAG_KEYS,
  type FeatureFlagKey,
  type FeatureFlags,
  type FeatureFlagValue,
  type WorkspaceBootstrap,
} from "@threa/types"
import { workspaceKeys } from "@/hooks/use-workspaces"

/**
 * The current viewer's value for a feature flag once it has actually been
 * delivered, or null while it is still unknown (no bootstrap cached yet).
 * Reads the bootstrap cache via the cache-only observer pattern; the
 * `feature_flags:updated` socket event keeps the value live, so a backoffice
 * change flips this hook without a reload.
 *
 * Most callers want {@link useFeatureFlag} instead — reach for this variant
 * only when "not yet delivered" must be distinguished from "set to the
 * default" (e.g. the sync-v2 mode resolution, which substitutes its own
 * fallback during the unknown window).
 */
export function useFeatureFlagWhenKnown<K extends FeatureFlagKey>(
  workspaceId: string,
  key: K
): FeatureFlagValue<K> | null {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: workspaceKeys.bootstrap(workspaceId),
    queryFn: () => queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId)) ?? null,
    enabled: false,
    staleTime: Infinity,
    select: (bootstrap) => bootstrap?.featureFlags?.[key] ?? null,
  })
  return data ?? null
}

/**
 * The current viewer's value for a feature flag. Returns the flag's default
 * (first declared value) until the bootstrap is cached — "unknown yet" and
 * "default" render the same.
 */
export function useFeatureFlag<K extends FeatureFlagKey>(workspaceId: string, key: K): FeatureFlagValue<K> {
  return useFeatureFlagWhenKnown(workspaceId, key) ?? defaultFeatureFlagValue(key)
}

export interface OverriddenFeatureFlag {
  key: FeatureFlagKey
  value: FeatureFlagValue
  defaultValue: FeatureFlagValue
}

/**
 * The viewer's feature flags that are set to a non-default value, for the
 * read-only flags view. Until the bootstrap is cached this returns `[]` —
 * same "unknown renders as default" stance as {@link useFeatureFlag}, which
 * here means showing nothing rather than leaking flag state.
 */
export function useOverriddenFeatureFlags(workspaceId: string): OverriddenFeatureFlag[] {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: workspaceKeys.bootstrap(workspaceId),
    queryFn: () => queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId)) ?? null,
    enabled: false,
    staleTime: Infinity,
    select: (bootstrap) => bootstrap?.featureFlags ?? null,
  })
  return useMemo(() => listOverriddenFlags(data), [data])
}

function listOverriddenFlags(flags: FeatureFlags | null | undefined): OverriddenFeatureFlag[] {
  if (!flags) return []
  return FEATURE_FLAG_KEYS.flatMap((key) => {
    const value = flags[key]
    const defaultValue = defaultFeatureFlagValue(key)
    return value !== undefined && value !== defaultValue ? [{ key, value, defaultValue }] : []
  })
}
