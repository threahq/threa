// Persona config editing (roadmap 7.1/7.2). Admins patch a built-in persona's
// config additively over code defaults; only diverging fields are stored in
// `agent_config_overrides`. This module is the single source of truth (INV-31)
// for the editable-field patch schema shared by backend validation and the
// frontend editor. The model allowlist is derived server-side from the model
// registry (INV-16 enforced for overrides) and rides on the config response as
// `availableModels`; built-in defaults stay legal even if the registry lacks them.

import { z } from "zod"
import { AGENT_TOOL_NAMES, TONE_PRESETS, BREVITY_PRESETS, type PersonaStatus } from "./constants"

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
 * Upper bounds on a persona's display name and description (mirrors the bot
 * name/description caps). A custom persona's name/description are fully
 * user-authored and persist verbatim to the row and every list/bootstrap
 * payload, so they are bounded on the write path (INV-55).
 */
export const PERSONA_NAME_MAX_CHARS = 100
export const PERSONA_DESCRIPTION_MAX_CHARS = 500

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
 * Every editable persona field's validator and bounds, in one place (INV-31) —
 * the shared base both write schemas derive from so a cap, enum, or range change
 * can't drift the built-in patch and the custom full-config apart. Field types
 * mirror the backend's full built-in config schema exactly so a patch that
 * validates also survives the merge-and-reparse in `applyBuiltInAgentPatch`. The
 * two style PRESET keys are built-in-only, so they are extended onto the patch
 * schema below rather than living here; the free-text style SLOTS
 * (`tonePrompt`/`brevityPrompt`) are shared and stay on the base.
 */
const personaConfigBaseSchema = z.object({
  name: z.string().min(1).max(PERSONA_NAME_MAX_CHARS),
  description: z.string().max(PERSONA_DESCRIPTION_MAX_CHARS).nullable(),
  avatarEmoji: z.string().nullable(),
  systemPrompt: z.string().min(1).max(PERSONA_SYSTEM_PROMPT_MAX_CHARS),
  model: z.string().min(1),
  escalationModel: z.string().min(1).nullable(),
  // Provider sampling range; 0.7 is the built-in default. Bounded so a stray
  // form value can't reach the model provider verbatim.
  temperature: z.number().min(0).max(2).nullable(),
  maxTokens: z.number().int().positive().nullable(),
  enabledTools: z.array(z.enum(AGENT_TOOL_NAMES)),
  // Free-text style slots (roadmap 7.1). Custom personas carry these instead of
  // the preset keys (a fork materializes the source preset into text); a
  // custom's revision snapshot and draft patch ride the patch schema, so the
  // slot text lives here too. `SYSTEM_PERSONA_EDITABLE_FIELDS` keeps built-ins
  // from ever setting them (they use presets).
  tonePrompt: z.string().max(PERSONA_SLOT_MAX_CHARS).nullable(),
  brevityPrompt: z.string().max(PERSONA_SLOT_MAX_CHARS).nullable(),
})

/**
 * The editable fields of a persona config, as a sparse patch: the shared base
 * plus the built-in-only style presets. `.strict()` means any extra key (notably
 * `status`, which the API surface must not let the editor set) is rejected. The
 * backend re-uses this schema and extends it with `status` for internal override
 * resolution, so there is one definition of the editable fields.
 */
export const personaConfigPatchSchema = personaConfigBaseSchema
  .extend({
    // Style presets (roadmap 7.1). Built-in personas only carry preset keys.
    // Null = no preset = that aspect keeps its default guidance.
    tonePreset: z.enum(TONE_PRESETS).nullable(),
    brevityPreset: z.enum(BREVITY_PRESETS).nullable(),
  })
  .partial()
  .strict()

export type PersonaConfigPatch = z.infer<typeof personaConfigPatchSchema>

/**
 * The full editable config of a CUSTOM (workspace) persona, as the PUT-update
 * body: the shared base, every field required (no `.partial()`). Unlike
 * {@link personaConfigPatchSchema} (a sparse patch over built-in defaults) a
 * custom has no defaults baseline, so its editor submits every field and the
 * write always persists it verbatim (no reset-to-default / v0 floor). Style is
 * free text (`tonePrompt`/`brevityPrompt`); the preset keys and `slug` are
 * intentionally absent (`.strict()` rejects them — presets are built-in only,
 * slug is not editable). Single source of truth (INV-31) shared by backend
 * validation and the frontend custom editor.
 */
export const personaCustomConfigSchema = personaConfigBaseSchema.strict()

export type PersonaCustomConfig = z.infer<typeof personaCustomConfigSchema>

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
  // Null for a built-in (system) persona; the workspace id for a custom. Widened
  // from `z.null()` when custom personas landed (roadmap 7.1 step 2) so one
  // resolved-config shape serves both kinds on the wire.
  workspaceId: z.string().nullable(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  avatarEmoji: z.string().nullable(),
  // Base path of an uploaded avatar image, or null. Only a custom persona can
  // carry one (set via the dedicated avatar endpoint, never the config PUT); a
  // built-in resolves this to null. Resolve to a served URL with
  // `getPersonaAvatarUrl`.
  avatarUrl: z.string().nullable(),
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
  // `user` is a personal persona (user-scoped-personas), resolved only for its
  // owner; a built-in is `system`, a workspace custom is `workspace`.
  managedBy: z.enum(["system", "workspace", "user"]),
  status: personaConfigStatusSchema,
  visibility: personaConfigVisibilitySchema,
  e2eCapable: z.boolean(),
})

export type PersonaResolvedConfig = z.infer<typeof personaResolvedConfigSchema>

/**
 * Whether a persona is a code-backed built-in, a workspace-created custom, or a
 * user-owned personal persona (user-scoped-personas). `personal` maps from
 * `managed_by = 'user'` and is visible only to its owner.
 */
export type PersonaKind = "builtin" | "custom" | "personal"

/** Light persona row for the member-visible list (no systemPrompt). */
export interface PersonaListItem {
  id: string
  slug: string
  name: string
  description: string | null
  avatarEmoji: string | null
  model: string
  /** Built-in vs custom vs personal — the roster and editor branch on this. */
  kind: PersonaKind
  /**
   * Owning user for a `personal` persona; null for built-in and custom. Load-
   * bearing for delivery-group routing: the `agent_config:updated` broadcast
   * reuses this shape, and a personal persona's update must reach only its owner.
   */
  ownerUserId: string | null
  /**
   * Base path of an uploaded avatar image, or null (emoji/initials fallback).
   * Only a custom persona can carry one; a built-in always resolves to null.
   */
  avatarUrl: string | null
  /**
   * Built-in only: whether the workspace has an active override diverging from
   * code defaults. Meaningless for a custom (which has no defaults baseline) —
   * always false there.
   */
  isCustomized: boolean
  /**
   * Lifecycle status. The visible list returns `active` rows only, but the
   * `agent_config:updated` broadcast reuses this shape for archive/unarchive —
   * the field lets store-backed consumers flip their cached row without a
   * refetch.
   */
  status: PersonaStatus
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
  /** Built-in vs custom — the editor renders a restricted or full form on this. */
  kind: PersonaKind
  /**
   * The code-backed defaults a built-in's override is diffed against. Null for a
   * custom persona: it has no baseline, so there is no per-field "customized"
   * badge or reset-to-default for customs (roadmap 7.1 step 2).
   */
  defaults: PersonaResolvedConfig | null
  overridePatch: PersonaConfigPatch | null
  /**
   * The optimistic-concurrency token the next write must echo. For a built-in it
   * is the override row's `updated_at` (null when at defaults); for a custom it is
   * the persona row's `updated_at`.
   */
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

/** Request body for POST create-a-custom-persona (fork). `name` seeds a workspace-scoped slug. */
export interface ForkPersonaInput {
  /**
   * The built-in or custom persona to copy config (and materialized style slots)
   * from; `null` starts from a blank agent (starter prompt, default model, no
   * tools) instead of copying anything.
   */
  sourcePersonaId: string | null
  name: string
}

/** Request body for PUT update-a-custom-persona (full-field write + optimistic concurrency). */
export interface UpdatePersonaCustomInput {
  config: PersonaCustomConfig
  /**
   * The `overrideUpdatedAt` (the persona row's `updated_at`) the caller last read;
   * a mismatch is a 409 so a concurrent admin edit isn't clobbered.
   */
  expectedUpdatedAt: string | null
}
