/**
 * Workspace-facing view of built-in persona configuration (roadmap 7.1 subset).
 *
 * Built-in defaults live in backend code; a workspace may carry a sparse
 * override patch (`agent_config_overrides`). This surface exposes the merged
 * result plus which fields the workspace has overridden, so the settings UI
 * can render effective values and offer a reset-to-default.
 */

export interface WorkspacePersonaSummary {
  id: string
  slug: string
  name: string
  description: string | null
  avatarEmoji: string | null
  /** Effective model for this workspace (default unless overridden). */
  model: string
  /** The code-backed default model, for the "reset to default" affordance. */
  defaultModel: string
  status: "active" | "disabled" | "archived"
  /** Patch keys the workspace has overridden (e.g. ["model"]). */
  overriddenFields: string[]
}

/** A model the workspace may assign to a persona (from the capability registry). */
export interface AvailablePersonaModel {
  id: string
  name: string
}

export interface ListWorkspacePersonasResponse {
  personas: WorkspacePersonaSummary[]
  availableModels: AvailablePersonaModel[]
}

/** `model: null` clears the workspace override back to the code-backed default. */
export interface UpdatePersonaConfigInput {
  model: string | null
}
