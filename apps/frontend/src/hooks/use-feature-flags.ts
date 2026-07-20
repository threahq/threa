import { useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  defaultFeatureFlagValue,
  FEATURE_FLAG_KEYS,
  resolveFeatureFlags,
  type FeatureFlagKey,
  type FeatureFlags,
  type FeatureFlagValue,
  type WorkspaceBootstrap,
} from "@threa/types"
import { workspaceKeys } from "@/hooks/use-workspaces"

/**
 * The viewer's resolved flag map, or null until the bootstrap (with its raw
 * layers) is cached. Reads the bootstrap cache via the cache-only observer
 * pattern and resolves the workspace + user layers through the shared registry
 * resolver — the same one the backend runs — so a flag means the same thing on
 * both sides. The resolve is memoized on the layers reference (kept stable by
 * the query's structural sharing), so it runs on a real change, not per render.
 */
function useResolvedFeatureFlags(workspaceId: string): FeatureFlags | null {
  const queryClient = useQueryClient()
  const { data: layers } = useQuery({
    queryKey: workspaceKeys.bootstrap(workspaceId),
    queryFn: () => queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId)) ?? null,
    enabled: false,
    staleTime: Infinity,
    select: (bootstrap) => bootstrap?.featureFlags ?? null,
  })
  return useMemo(() => (layers ? resolveFeatureFlags(layers) : null), [layers])
}

/**
 * The current viewer's value for a feature flag once it has actually been
 * delivered, or null while it is still unknown (no bootstrap cached yet).
 * The `feature_flags:updated` / `feature_flags:workspace_updated` socket events
 * keep the layers live, so a backoffice change flips this hook without a reload.
 *
 * Most callers want {@link useFeatureFlag} instead — reach for this variant
 * only when "not yet delivered" must be distinguished from "set to the
 * default" during a flag's pre-bootstrap window.
 */
export function useFeatureFlagWhenKnown<K extends FeatureFlagKey>(
  workspaceId: string,
  key: K
): FeatureFlagValue<K> | null {
  const flags = useResolvedFeatureFlags(workspaceId)
  return flags?.[key] ?? null
}

/**
 * The current viewer's value for a feature flag. Returns the flag's declared
 * default until the bootstrap is cached — "unknown yet" and "default" render
 * the same.
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
  const flags = useResolvedFeatureFlags(workspaceId)
  return useMemo(() => listOverriddenFlags(flags), [flags])
}

function listOverriddenFlags(flags: FeatureFlags | null | undefined): OverriddenFeatureFlag[] {
  if (!flags) return []
  return FEATURE_FLAG_KEYS.flatMap((key) => {
    const value = flags[key]
    const defaultValue = defaultFeatureFlagValue(key)
    return value !== undefined && value !== defaultValue ? [{ key, value, defaultValue }] : []
  })
}
