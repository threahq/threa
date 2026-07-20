import { useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  defaultFeatureFlagValue,
  flagAllowsScope,
  isFeatureFlagValue,
  resolveFeatureFlags,
  type FeatureFlagKey,
  type FeatureFlagLayers,
  type FeatureFlags,
  type FeatureFlagScope,
  type FeatureFlagValue,
  type WorkspaceBootstrap,
} from "@threa/types"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { useWorkspaceMetadata } from "@/stores/workspace-store"

/**
 * The viewer's raw override layers, preferring the live bootstrap query cache
 * (kept socket-patched by chunk 3) and falling back to the layers persisted in
 * `workspaceMetadata` when the query cache is still empty. The fallback is what
 * makes a warm start correct: the coordinated-loading gate opens off IDB while
 * the network bootstrap is still in flight, so without it every flag would read
 * its registry default for a frame band. Returns null only when neither source
 * has layers yet (a first cold load before any bootstrap).
 */
function useFeatureFlagLayers(workspaceId: string): FeatureFlagLayers | null {
  const queryClient = useQueryClient()
  const { data: cached } = useQuery({
    queryKey: workspaceKeys.bootstrap(workspaceId),
    queryFn: () => queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId)) ?? null,
    enabled: false,
    staleTime: Infinity,
    // Wrap so a cached bootstrap that carries no layers is still distinguishable
    // from "no bootstrap": the former is authoritative (all defaults), the latter
    // is the warm-start window where the persisted row must fill in.
    select: (bootstrap) => (bootstrap ? { layers: bootstrap.featureFlags ?? null } : null),
  })
  const persistedLayers = useWorkspaceMetadata(workspaceId)?.featureFlags ?? null
  // A cached bootstrap wins even when its layers are null — an authoritative
  // server snapshot with no overrides must not be shadowed by a stale IDB row.
  // Fall back to the persisted row only when no bootstrap is cached at all.
  return cached ? cached.layers : persistedLayers
}

/**
 * The viewer's resolved flag map, or null until layers are available from the
 * query cache or the persisted metadata row. Resolves the workspace + user
 * layers through the shared registry resolver — the same one the backend runs —
 * so a flag means the same thing on both sides. The resolve is memoized on the
 * layers reference (kept stable by structural sharing / the store snapshot), so
 * it runs on a real change, not per render.
 */
function useResolvedFeatureFlags(workspaceId: string): FeatureFlags | null {
  const layers = useFeatureFlagLayers(workspaceId)
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
  /** Which layer supplied the winning value — "user" wins over "workspace". */
  scope: FeatureFlagScope
}

/**
 * The viewer's feature flags that are set to a non-default value, for the
 * read-only flags view. Until layers are available this returns `[]` — same
 * "unknown renders as default" stance as {@link useFeatureFlag}, which here
 * means showing nothing rather than leaking flag state. Each row carries the
 * winning scope so the tab can show whether a flag is on for the workspace or
 * for this user.
 */
export function useOverriddenFeatureFlags(workspaceId: string): OverriddenFeatureFlag[] {
  const layers = useFeatureFlagLayers(workspaceId)
  return useMemo(() => listOverriddenFlags(layers), [layers])
}

function listOverriddenFlags(layers: FeatureFlagLayers | null): OverriddenFeatureFlag[] {
  if (!layers) return []
  const flags = resolveFeatureFlags(layers)
  // Iterate the resolved map (registry-backed keys) rather than FEATURE_FLAG_KEYS
  // so the injected-registry test seam sees flags — the resolver is the shared
  // authority for which keys exist.
  return (Object.keys(flags) as FeatureFlagKey[]).flatMap((key) => {
    const value = flags[key]
    const defaultValue = defaultFeatureFlagValue(key)
    if (value === defaultValue) return []
    return [{ key, value, defaultValue, scope: winningScope(key, layers) }]
  })
}

// A non-default resolved value always came from a layer that contributed a valid
// applied override; the user layer applies last, so it wins when both did. If the
// user layer did not contribute, the workspace layer must have — hence the fallback.
function winningScope(key: FeatureFlagKey, layers: FeatureFlagLayers): FeatureFlagScope {
  return layerContributes(key, "user", layers.user) ? "user" : "workspace"
}

function layerContributes(key: FeatureFlagKey, scope: FeatureFlagScope, overrides: Record<string, string>): boolean {
  const value = overrides[key]
  return value !== undefined && flagAllowsScope(key, scope) && isFeatureFlagValue(key, value)
}
