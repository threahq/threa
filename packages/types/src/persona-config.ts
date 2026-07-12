// Persona config editing (roadmap 7.1/7.2). Admins patch a built-in persona's
// config additively over code defaults; only diverging fields are stored in
// `agent_config_overrides`. This module is the single source of truth (INV-31)
// for the editable-field patch schema shared by backend validation and the
// frontend editor. The model allowlist is derived server-side from the model
// registry (INV-16 enforced for overrides) and rides on the config response as
// `availableModels`; built-in defaults stay legal even if the registry lacks them.

import { z } from "zod"
import { AGENT_TOOL_NAMES, TONE_PRESETS, BREVITY_PRESETS } from "./constants"

/**
 * One selectable chat model for the persona editor's model / escalation-model
 * pickers. The list is derived server-side from the model registry (the
 * text-in/text-out chat models) and delivered on the config response — the
 * client never hardcodes it. `label` is the registry's display name.
 */
export interface PersonaModelOption {
  id: string
  label: string
}

/**
 * Upper bound on an edited persona system prompt. Generous — a persona's
 * standing instructions are longer than a stream brief but still bounded so a
 * runaway paste can't reach the model provider or the override store verbatim.
 * Enforced by {@link personaConfigPatchSchema} (write path) and surfaced as the
 * editor's character counter. Built-in defaults are unaffected: a code default
 * is never submitted as a patch.
 */
export const PERSONA_SYSTEM_PROMPT_MAX_CHARS = 8000

/**
 * Upper bound on a custom persona's free-text style slot (tone / brevity). A
 * slot is a short imperative style directive spliced into the `## Response
 * Style` section — not a document store — so it is bounded well below the system
 * prompt. Enforced by the custom-persona write path (roadmap 7.1 step 2) and the
 * resolved-config schema; surfaced as the slot editor's character counter.
 * Built-in personas use preset keys, not free text, so their slots are unbounded
 * by construction (the authored fragment is code, not user input).
 */
export const PERSONA_SLOT_MAX_CHARS = 500

/**
 * The fields of a system (built-in) persona an admin may edit. A `managed_by:
 * "system"` persona's identity and prompt are locked — only its toolset, model,
 * and the two style presets are configurable. The write path
 * (`PersonaConfigService.setOverride` / `saveDraft`) rejects any other patch key
 * with 400 `PERSONA_FIELD_LOCKED`; resolution of already-stored patches stays
 * permissive (a legacy override carrying `systemPrompt` keeps applying — a v0
 * restore clears it). Single source of truth so the frontend restricted editor
 * offers exactly these fields (INV-33). Each entry is a key of
 * {@link PersonaConfigPatch}.
 */
export const SYSTEM_PERSONA_EDITABLE_FIELDS = ["enabledTools", "model", "tonePreset", "brevityPreset"] as const
export type SystemPersonaEditableField = (typeof SYSTEM_PERSONA_EDITABLE_FIELDS)[number]

/**
 * The editable fields of a persona config, as a sparse patch. Field types
 * mirror the backend's full built-in config schema exactly so a patch that
 * validates here also survives the merge-and-reparse in
 * `applyBuiltInAgentPatch`. `.strict()` means any extra key (notably `status`,
 * which the API surface must not let the editor set) is rejected. The backend
 * re-uses this schema and extends it with `status` for internal override
 * resolution, so there is one definition of the editable fields.
 */
export const personaConfigPatchSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().nullable(),
    avatarEmoji: z.string().nullable(),
    systemPrompt: z.string().min(1).max(PERSONA_SYSTEM_PROMPT_MAX_CHARS),
    model: z.string().min(1),
    escalationModel: z.string().min(1).nullable(),
    // Provider sampling range; 0.7 is the built-in default. Bounded so a stray
    // form value can't reach the model provider verbatim.
    temperature: z.number().min(0).max(2).nullable(),
    maxTokens: z.number().int().positive().nullable(),
    enabledTools: z.array(z.enum(AGENT_TOOL_NAMES)),
    // Style presets (roadmap 7.1). Built-in personas only carry preset keys;
    // customs use free-text slots (`tonePrompt`/`brevityPrompt` on the row, not
    // in this patch). Null = no preset = that aspect keeps its default guidance.
    tonePreset: z.enum(TONE_PRESETS).nullable(),
    brevityPreset: z.enum(BREVITY_PRESETS).nullable(),
  })
  .partial()
  .strict()

export type PersonaConfigPatch = z.infer<typeof personaConfigPatchSchema>

/**
 * Status a stored built-in override may carry. Narrower than the workspace-wide
 * {@link PersonaStatus} (no `pending`): a code-backed built-in is never pending.
 * Exported so the backend's override-resolution patch schema single-sources it.
 */
export const personaConfigStatusSchema = z.enum(["active", "disabled", "archived"])

const personaConfigVisibilitySchema = z.enum(["visible", "internal"])

/**
 * The full resolved persona (built-in agent) config, as sent on the wire and as
 * the backend's `builtInAgentConfigSchema` (derived from this via `z.infer`, so
 * there is one definition — INV-31). The editor renders the editable fields;
 * identity fields (id/slug/visibility) drive routing and badges.
 */
export const personaResolvedConfigSchema = z.object({
  id: z.string(),
  workspaceId: z.null(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  avatarEmoji: z.string().nullable(),
  systemPrompt: z.string().min(1),
  model: z.string().min(1),
  escalationModel: z.string().min(1).nullable(),
  temperature: z.number().nullable(),
  maxTokens: z.number().int().positive().nullable(),
  enabledTools: z.array(z.enum(AGENT_TOOL_NAMES)),
  // Style slots (roadmap 7.1). A built-in persona resolves TONE/BREVITY from the
  // preset keys; a custom persona from the free-text `tonePrompt`/`brevityPrompt`
  // columns. Both shapes ride the wire type now so step 2's custom write path
  // doesn't re-touch the shared schema — for built-ins the text fields are always
  // null, for customs the preset fields are always null.
  tonePreset: z.enum(TONE_PRESETS).nullable(),
  brevityPreset: z.enum(BREVITY_PRESETS).nullable(),
  tonePrompt: z.string().max(PERSONA_SLOT_MAX_CHARS).nullable(),
  brevityPrompt: z.string().max(PERSONA_SLOT_MAX_CHARS).nullable(),
  managedBy: z.literal("system"),
  status: personaConfigStatusSchema,
  visibility: personaConfigVisibilitySchema,
  e2eCapable: z.boolean(),
})

export type PersonaResolvedConfig = z.infer<typeof personaResolvedConfigSchema>

/** Light persona row for the member-visible list (no systemPrompt). */
export interface PersonaListItem {
  id: string
  slug: string
  name: string
  description: string | null
  avatarEmoji: string | null
  model: string
  /** Whether the workspace has an active override diverging from code defaults. */
  isCustomized: boolean
}

/**
 * The caller's own server-side draft for a persona (roadmap 7.1 test-drive
 * substrate). Populated in a later step; the config endpoint types it now and
 * returns null until the draft substrate lands.
 */
export interface PersonaDraftState {
  patch: PersonaConfigPatch
  testStreamId: string | null
  updatedAt: string
}

/** Admin config response for a single persona. */
export interface PersonaConfigResponse {
  defaults: PersonaResolvedConfig
  overridePatch: PersonaConfigPatch | null
  overrideUpdatedAt: string | null
  resolved: PersonaResolvedConfig
  draft: PersonaDraftState | null
  /**
   * Registry-derived chat models an admin may assign (INV-16). The editor's
   * model pickers render these; the currently-resolved model is folded in
   * client-side even when it is not itself assignable (a built-in default).
   */
  availableModels: PersonaModelOption[]
}

/** Who committed a persona config revision. The single home for this union — the
 *  revision repository/table validate against it in app code (INV-3/33). */
export const PERSONA_REVISION_AUTHOR_KINDS = ["user", "persona"] as const
export type PersonaRevisionAuthorKind = (typeof PERSONA_REVISION_AUTHOR_KINDS)[number]

/**
 * One committed revision of a persona's override config (roadmap 7.1 history).
 * Every accepted `setOverride` (including a restore) appends one, so the list is
 * the append-only audit trail the editor renders and rolls back from. `patch` is
 * the sparse override committed at that `version`; `createdById` is resolved to a
 * display name on the frontend (INV-46). `version` is monotonic per persona.
 */
export interface PersonaConfigRevision {
  id: string
  version: number
  patch: PersonaConfigPatch
  createdByKind: PersonaRevisionAuthorKind
  createdById: string
  createdAt: string
}

/** Request body for POST restore-a-revision (same optimistic-concurrency guard as an override write). */
export interface RestorePersonaRevisionInput {
  /**
   * The `overrideUpdatedAt` the caller last read; `null` asserts no override
   * exists yet. A mismatch is a 409 so a concurrent admin edit isn't clobbered.
   */
  expectedUpdatedAt: string | null
}

/** Request body for PUT persona override. */
export interface UpdatePersonaOverrideInput {
  patch: PersonaConfigPatch
  /**
   * The `overrideUpdatedAt` the caller last read; `null` asserts no override
   * exists yet. A mismatch is a 409 so a concurrent admin edit isn't clobbered.
   */
  expectedUpdatedAt: string | null
}
