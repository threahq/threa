import { api, postAvatarUpload } from "./client"
import type {
  ForkPersonaInput,
  PersonaAttachmentItem,
  PersonaConfigPatch,
  PersonaConfigResponse,
  PersonaConfigRevision,
  PersonaDraftState,
  PersonaListItem,
  PersonaResolvedConfig,
  UpdatePersonaCustomInput,
} from "@threa/types"

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
 * A CUSTOM persona's `PERSONA_OVERRIDE_CONFLICT` (409) `details.current`: the
 * full row config another admin just committed and the row `updatedAt` to
 * re-assert against. Unlike a built-in conflict (a sparse patch), a custom carries
 * its whole resolved config — the editor adopts it as the new saved baseline.
 */
export interface PersonaCustomConflict {
  config: PersonaResolvedConfig
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

  /** Archived custom personas (admin) — the roster's Archived disclosure. */
  async listArchived(workspaceId: string): Promise<PersonaListItem[]> {
    const { personas } = await api.get<{ personas: PersonaListItem[] }>(
      `/api/workspaces/${workspaceId}/personas/archived`
    )
    return personas
  },

  getConfig(workspaceId: string, personaId: string): Promise<PersonaConfigResponse> {
    return api.get<PersonaConfigResponse>(`/api/workspaces/${workspaceId}/personas/${personaId}/config`)
  },

  /** Fork a source persona (built-in or custom; null = blank agent) into a new workspace custom (admin). */
  async fork(workspaceId: string, input: ForkPersonaInput): Promise<PersonaListItem> {
    const { persona } = await api.post<{ persona: PersonaListItem }>(`/api/workspaces/${workspaceId}/personas`, input)
    return persona
  },

  /**
   * Full-field write of a CUSTOM persona (admin). `expectedUpdatedAt` is the
   * row's `updatedAt` the caller last read; a mismatch throws an `ApiError`
   * (`PERSONA_OVERRIDE_CONFLICT`) whose `details.current` is a {@link PersonaCustomConflict}.
   */
  updateCustom(
    workspaceId: string,
    personaId: string,
    input: UpdatePersonaCustomInput
  ): Promise<{ persona: PersonaListItem; updatedAt: string | null }> {
    return api.put<{ persona: PersonaListItem; updatedAt: string | null }>(
      `/api/workspaces/${workspaceId}/personas/${personaId}`,
      input
    )
  },

  /** Archive a custom persona (admin) — drops it from the roster/picker, keeps it resolvable for history. */
  async archive(workspaceId: string, personaId: string): Promise<PersonaListItem> {
    const { persona } = await api.post<{ persona: PersonaListItem }>(
      `/api/workspaces/${workspaceId}/personas/${personaId}/archive`
    )
    return persona
  },

  /** Restore an archived custom persona to active (admin). */
  async unarchive(workspaceId: string, personaId: string): Promise<PersonaListItem> {
    const { persona } = await api.post<{ persona: PersonaListItem }>(
      `/api/workspaces/${workspaceId}/personas/${personaId}/unarchive`
    )
    return persona
  },

  /** Upload a custom persona's avatar image (multipart, mirrors the bot avatar upload). */
  uploadAvatar(
    workspaceId: string,
    personaId: string,
    file: File
  ): Promise<{ persona: PersonaListItem; updatedAt: string }> {
    return postAvatarUpload<{ persona: PersonaListItem; updatedAt: string }>(
      `/api/workspaces/${workspaceId}/personas/${personaId}/avatar`,
      file
    )
  },

  /** Remove a custom persona's avatar image (falls back to emoji/initials). */
  removeAvatar(workspaceId: string, personaId: string): Promise<{ persona: PersonaListItem; updatedAt: string }> {
    return api.delete<{ persona: PersonaListItem; updatedAt: string }>(
      `/api/workspaces/${workspaceId}/personas/${personaId}/avatar`
    )
  },

  /**
   * Bind an already-uploaded workspace attachment to a custom/personal persona as
   * context knowledge (persona-context-attachments). The bytes reach S3 through the
   * shared composer upload transport (reserve → content); this is the persona-ness
   * step only, so there is ONE frontend upload path (INV-35/37). Returns the created
   * {@link PersonaAttachmentItem} (`processingStatus` starts `processing` until
   * extraction lands). A mime/size/cap/settle rejection throws an `ApiError` whose
   * message names the constraint (INV-11).
   */
  async bindAttachment(workspaceId: string, personaId: string, attachmentId: string): Promise<PersonaAttachmentItem> {
    const { attachment } = await api.post<{ attachment: PersonaAttachmentItem }>(
      `/api/workspaces/${workspaceId}/personas/${personaId}/attachments`,
      { attachmentId }
    )
    return attachment
  },

  /**
   * Attach an EXISTING workspace file to a custom/personal persona by COPYING it
   * (knowledge-by-reference). The caller picks a file they can already read; the
   * server copies its bytes + extraction into a fresh persona-owned row and binds
   * it (copy-on-attach). Returns the created {@link PersonaAttachmentItem} —
   * `processingStatus` is `ready` immediately when the source's extraction was
   * copied, else `processing` until the pipeline runs on the copy. An
   * unreadable/missing source is a 404; an ineligible source (not clean / e2e /
   * mime / size) or a full cap throws an `ApiError` whose message names the
   * constraint (INV-11).
   */
  async attachFromExisting(
    workspaceId: string,
    personaId: string,
    sourceAttachmentId: string
  ): Promise<PersonaAttachmentItem> {
    const { attachment } = await api.post<{ attachment: PersonaAttachmentItem }>(
      `/api/workspaces/${workspaceId}/personas/${personaId}/attachments/from-existing`,
      { sourceAttachmentId }
    )
    return attachment
  },

  /** Remove a persona context attachment (hard delete — the file is unbound to any message). */
  deleteAttachment(workspaceId: string, personaId: string, attachmentId: string): Promise<void> {
    return api.delete<void>(`/api/workspaces/${workspaceId}/personas/${personaId}/attachments/${attachmentId}`)
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
  ): Promise<{ persona: PersonaListItem; updatedAt: string | null }> {
    return api.put<{ persona: PersonaListItem; updatedAt: string | null }>(
      `/api/workspaces/${workspaceId}/personas/${personaId}/override`,
      input
    )
  },

  /**
   * The persona's committed override revisions, newest-first (admin-gated). Each
   * carries the sparse `patch` at that version plus `createdBy*` ids the editor
   * resolves to a display name (INV-46).
   */
  async listRevisions(workspaceId: string, personaId: string): Promise<PersonaConfigRevision[]> {
    const { revisions } = await api.get<{ revisions: PersonaConfigRevision[] }>(
      `/api/workspaces/${workspaceId}/personas/${personaId}/revisions`
    )
    return revisions
  },

  /**
   * Re-commit an older revision's patch as the current override (a new revision;
   * never destructive). `expectedUpdatedAt` is the same optimistic-concurrency
   * token as {@link putOverride}: a mismatch throws an `ApiError`
   * (`PERSONA_OVERRIDE_CONFLICT`, `details.current` a {@link PersonaOverrideConflict}).
   * A revision that no longer parses against the current schema is a 422
   * (`PERSONA_REVISION_INCOMPATIBLE`); a foreign revision is a 404.
   */
  restoreRevision(
    workspaceId: string,
    personaId: string,
    revisionId: string,
    input: { expectedUpdatedAt: string | null }
  ): Promise<{ persona: PersonaListItem; updatedAt: string | null }> {
    return api.post<{ persona: PersonaListItem; updatedAt: string | null }>(
      `/api/workspaces/${workspaceId}/personas/${personaId}/revisions/${revisionId}/restore`,
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
