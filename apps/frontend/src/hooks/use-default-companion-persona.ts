import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ARIADNE_PERSONA_SLUG, type PersonaListItem, type WorkspaceBootstrap } from "@threa/types"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { usePreferencesOptional } from "@/contexts"
import { usePersonas } from "@/hooks/use-personas"

export interface DefaultCompanionResolution {
  /** The default that applies to the viewer: user pref → workspace setting → Ariadne. */
  effectiveDefault: PersonaListItem | undefined
  /** The workspace-tier default alone (workspace setting → Ariadne), for the
   *  user-settings picker's "what would I inherit" synthetic option. */
  workspaceDefault: PersonaListItem | undefined
}

/**
 * Resolve the companion default a null stream pointer displays as. Precedence is
 * user preference → workspace setting → built-in Ariadne, degrading a tier when
 * its stored id is absent from the roster — the roster carries only active
 * personas, so an off-roster id is archived/inactive and falls through (the same
 * resolve-time tolerance the dispatch resolver applies, INV-11's one sanctioned
 * fallback). `workspaceDefault` is exposed separately so the user picker can name
 * the tier it would inherit independent of the viewer's own override.
 */
export function useDefaultCompanionPersona(
  workspaceId: string,
  opts?: { enabled?: boolean }
): DefaultCompanionResolution {
  const userDefaultId = usePreferencesOptional()?.preferences?.defaultCompanionPersonaId ?? null
  const workspaceDefaultId = useWorkspaceDefaultCompanionPersonaId(workspaceId)
  const { data: personas } = usePersonas(workspaceId, { enabled: opts?.enabled ?? true })
  return resolveDefaultCompanionPersona(personas, userDefaultId, workspaceDefaultId)
}

/** Pure precedence resolver (roster + stored ids → resolved rows). */
export function resolveDefaultCompanionPersona(
  personas: PersonaListItem[] | undefined,
  userDefaultId: string | null,
  workspaceDefaultId: string | null
): DefaultCompanionResolution {
  const ariadne = personas?.find((p) => p.slug === ARIADNE_PERSONA_SLUG)
  const workspacePersona = workspaceDefaultId ? personas?.find((p) => p.id === workspaceDefaultId) : undefined
  const workspaceDefault = workspacePersona ?? ariadne
  const userPersona = userDefaultId ? personas?.find((p) => p.id === userDefaultId) : undefined
  const effectiveDefault = userPersona ?? workspaceDefault
  return { effectiveDefault, workspaceDefault }
}

/**
 * The workspace-wide default companion persona id (read from the bootstrap cache
 * via the cache-only observer pattern). Rides `WorkspaceBootstrap.workspaceSettings`,
 * so a `workspace_settings:updated` broadcast re-renders callers with no extra
 * fetch. Mirrors `useWorkspaceDefaultWorkSchedule`.
 */
function useWorkspaceDefaultCompanionPersonaId(workspaceId: string): string | null {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: workspaceKeys.bootstrap(workspaceId),
    queryFn: () => queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId)) ?? null,
    enabled: false,
    staleTime: Infinity,
    select: (bootstrap) => bootstrap?.workspaceSettings?.defaultCompanionPersonaId ?? null,
  })
  return data ?? null
}
