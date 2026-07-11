import { api } from "./client"
import type { PersonaConfigPatch, PersonaConfigResponse, PersonaDraftState, PersonaListItem } from "@threa/types"

/**
 * The stored override as it rides on a `PERSONA_OVERRIDE_CONFLICT` (409)
 * `details.current`: the patch another admin just committed and the timestamp to
 * re-assert against. Mirrors the backend `AgentConfigOverrideDetail` — `patch` is
 * opaque JSONB on the wire, validated by the editor against the shared schema
 * before it is trusted.
 */
export interface PersonaOverrideConflict {
  patch: PersonaConfigPatch
  updatedAt: string
}

/**
 * Persona (built-in agent) config editing (roadmap 7.1/7.2). The list is
 * member-visible; config read and every write are admin-gated at the route
 * layer, so a non-admin caller gets a 403 surfaced as an `ApiError`. A
 * `PERSONA_OVERRIDE_CONFLICT` (409) on `putOverride` carries `details.current`
 * for inline conflict handling (INV-63 — no toast).
 */
export const personasApi = {
  async list(workspaceId: string): Promise<PersonaListItem[]> {
    const { personas } = await api.get<{ personas: PersonaListItem[] }>(`/api/workspaces/${workspaceId}/personas`)
    return personas
  },

  getConfig(workspaceId: string, personaId: string): Promise<PersonaConfigResponse> {
    return api.get<PersonaConfigResponse>(`/api/workspaces/${workspaceId}/personas/${personaId}/config`)
  },

  /**
   * Commit the workspace override with optimistic concurrency. `expectedUpdatedAt`
   * is the `overrideUpdatedAt` the caller last read (`null` asserts no override
   * exists yet); a mismatch throws an `ApiError` (`PERSONA_OVERRIDE_CONFLICT`)
   * whose `details.current` is a {@link PersonaOverrideConflict}.
   */
  putOverride(
    workspaceId: string,
    personaId: string,
    input: { patch: PersonaConfigPatch; expectedUpdatedAt: string | null }
  ): Promise<{ persona: PersonaListItem; updatedAt: string }> {
    return api.put<{ persona: PersonaListItem; updatedAt: string }>(
      `/api/workspaces/${workspaceId}/personas/${personaId}/override`,
      input
    )
  },

  async putDraft(workspaceId: string, personaId: string, patch: PersonaConfigPatch): Promise<PersonaDraftState> {
    const { draft } = await api.put<{ draft: PersonaDraftState }>(
      `/api/workspaces/${workspaceId}/personas/${personaId}/draft`,
      { patch }
    )
    return draft
  },

  async deleteDraft(workspaceId: string, personaId: string): Promise<void> {
    await api.delete<void>(`/api/workspaces/${workspaceId}/personas/${personaId}/draft`)
  },

  createTestStream(workspaceId: string, personaId: string): Promise<{ streamId: string }> {
    return api.post<{ streamId: string }>(`/api/workspaces/${workspaceId}/personas/${personaId}/draft/test-stream`)
  },
}
