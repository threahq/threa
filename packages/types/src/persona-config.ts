// Persona config editing (roadmap 7.1/7.2). Admins patch a built-in persona's
// config additively over code defaults; only diverging fields are stored in
// `agent_config_overrides`. This module is the single source of truth (INV-31)
// for the editable-field patch schema shared by backend validation and the
// frontend editor, plus the curated model allowlist (INV-16 enforced for
// overrides — built-in defaults stay legal even if not listed).

import { z } from "zod"
import { AGENT_TOOL_NAMES } from "./constants"

/**
 * Curated chat models offered in the persona editor's model / escalation-model
 * pickers. Drawn from the inference models in `docs/model-reference.md`
 * (embeddings, speech-to-text, and deprecated generations excluded). A
 * built-in default model outside this list is still legal — the allowlist gates
 * only what an admin may newly select.
 */
export const PERSONA_MODEL_OPTIONS = [
  { id: "openrouter:anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "openrouter:anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
  { id: "openrouter:anthropic/claude-opus-4.8", label: "Claude Opus 4.8" },
  { id: "openrouter:anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "openrouter:anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
  { id: "openrouter:openai/gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { id: "openrouter:openai/gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { id: "openrouter:openai/gpt-5.4-nano", label: "GPT-5.4 Nano" },
] as const satisfies readonly { id: string; label: string }[]

export type PersonaModelOption = (typeof PERSONA_MODEL_OPTIONS)[number]

/**
 * Upper bound on an edited persona system prompt. Generous — a persona's
 * standing instructions are longer than a stream brief but still bounded so a
 * runaway paste can't reach the model provider or the override store verbatim.
 * Enforced by {@link personaConfigPatchSchema} (write path) and surfaced as the
 * editor's character counter. Built-in defaults are unaffected: a code default
 * is never submitted as a patch.
 */
export const PERSONA_SYSTEM_PROMPT_MAX_CHARS = 8000

export const PERSONA_MODEL_OPTION_IDS: ReadonlySet<string> = new Set(PERSONA_MODEL_OPTIONS.map((option) => option.id))

export function isPersonaModelId(id: string): boolean {
  return PERSONA_MODEL_OPTION_IDS.has(id)
}

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
  })
  .partial()
  .strict()

export type PersonaConfigPatch = z.infer<typeof personaConfigPatchSchema>

/**
 * The write-path variant used to validate an override/draft patch from the API:
 * identical to {@link personaConfigPatchSchema} plus enforcement that any
 * selected `model` / `escalationModel` is in {@link PERSONA_MODEL_OPTIONS}. A
 * null `escalationModel` (escalation disabled) is always allowed.
 */
export const personaConfigWritePatchSchema = personaConfigPatchSchema.superRefine((patch, ctx) => {
  if (patch.model !== undefined && !isPersonaModelId(patch.model)) {
    ctx.addIssue({ code: "custom", path: ["model"], message: "Model is not an allowed persona model" })
  }
  if (patch.escalationModel != null && !isPersonaModelId(patch.escalationModel)) {
    ctx.addIssue({
      code: "custom",
      path: ["escalationModel"],
      message: "Escalation model is not an allowed persona model",
    })
  }
})

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
