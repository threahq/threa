import type { AgentToolName, PersonaConfigPatch, PersonaResolvedConfig } from "@threa/types"

/**
 * The full editable field set the editor holds. Mirrors {@link PersonaConfigPatch}'s
 * fields, but every field is concrete (the form always shows a resolved value):
 * the patch sent to the server is the SPARSE diff of these against the built-in
 * defaults (only diverging fields — additive override, per roadmap 7.1).
 */
export interface PersonaFormValues {
  name: string
  description: string | null
  avatarEmoji: string | null
  systemPrompt: string
  model: string
  escalationModel: string | null
  temperature: number | null
  maxTokens: number | null
  enabledTools: AgentToolName[]
}

export type PersonaFormField = keyof PersonaFormValues

/**
 * The single field list every helper below iterates — add a field here (and on
 * {@link PersonaFormValues}) and seeding, patch application, and sparse-diffing
 * all pick it up; the `_exhaustive` guard makes a missed entry a compile error.
 */
export const PERSONA_FORM_FIELDS = [
  "name",
  "description",
  "avatarEmoji",
  "systemPrompt",
  "model",
  "escalationModel",
  "temperature",
  "maxTokens",
  "enabledTools",
] as const satisfies readonly PersonaFormField[]

// Compile error if PersonaFormValues gains a field the list above lacks.
const _exhaustive: PersonaFormField extends (typeof PERSONA_FORM_FIELDS)[number] ? true : never = true
void _exhaustive

/**
 * Draft-sync lifecycle shared by the editor form (which owns the debounce and
 * drives it) and the test-chat pane (which mirrors it as a "saving/saved"
 * indicator so the tester sees the chat is running the latest edits).
 */
export type SyncState = "idle" | "syncing" | "synced" | "error"

export function syncHintText(sync: SyncState): string {
  switch (sync) {
    case "syncing":
      return "Syncing draft…"
    case "synced":
      return "Draft synced — Save applies it"
    case "error":
      return "Draft not synced"
    default:
      return ""
  }
}

/** Clone a field value so arrays never share identity with their source. */
function cloneField(value: unknown): unknown {
  return Array.isArray(value) ? [...value] : value
}

/** The editable slice of the resolved config (defaults or resolved). */
export function toFormValues(config: PersonaResolvedConfig): PersonaFormValues {
  const values = {} as Record<PersonaFormField, unknown>
  for (const field of PERSONA_FORM_FIELDS) values[field] = cloneField(config[field])
  return values as PersonaFormValues
}

/** Defaults with a sparse patch (draft or override) applied over them. */
export function applyPatch(defaults: PersonaResolvedConfig, patch: PersonaConfigPatch | null): PersonaFormValues {
  const base = toFormValues(defaults) as Record<PersonaFormField, unknown>
  if (!patch) return base as PersonaFormValues
  for (const field of PERSONA_FORM_FIELDS) {
    const value = patch[field]
    if (value !== undefined) base[field] = cloneField(value)
  }
  return base as PersonaFormValues
}

function toolsEqual(a: AgentToolName[], b: readonly AgentToolName[]): boolean {
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((tool) => bSet.has(tool))
}

/** Whether a single field diverges from the built-in default. */
export function isFieldOverridden(
  values: PersonaFormValues,
  defaults: PersonaResolvedConfig,
  field: PersonaFormField
): boolean {
  if (field === "enabledTools") return !toolsEqual(values.enabledTools, defaults.enabledTools)
  return !Object.is(values[field], defaults[field])
}

/**
 * The sparse override/draft patch: only the fields that diverge from the
 * built-in defaults. An empty object means "identical to defaults" (no override).
 */
export function computeSparsePatch(values: PersonaFormValues, defaults: PersonaResolvedConfig): PersonaConfigPatch {
  const patch = {} as Record<PersonaFormField, unknown>
  for (const field of PERSONA_FORM_FIELDS) {
    if (isFieldOverridden(values, defaults, field)) patch[field] = cloneField(values[field])
  }
  return patch as PersonaConfigPatch
}

/** Human labels for the editable fields — the revision history change summary
 *  renders these (INV-46: the frontend owns display text). */
export const PERSONA_FIELD_LABELS: Record<PersonaFormField, string> = {
  name: "name",
  description: "description",
  avatarEmoji: "avatar",
  systemPrompt: "system prompt",
  model: "model",
  escalationModel: "escalation model",
  temperature: "temperature",
  maxTokens: "max tokens",
  enabledTools: "tools",
}

/**
 * The editable fields whose value differs between two sparse patches (an absent
 * field means "default"). Powers the revision history change summary — which
 * fields a revision changed relative to the previous (older) one. Iterates the
 * single field list so a new field is covered automatically.
 */
export function changedPatchFields(prev: PersonaConfigPatch, next: PersonaConfigPatch): PersonaFormField[] {
  const changed: PersonaFormField[] = []
  for (const field of PERSONA_FORM_FIELDS) {
    if (field === "enabledTools") {
      const a = prev.enabledTools
      const b = next.enabledTools
      if ((a === undefined) !== (b === undefined) || (a && b && !toolsEqual([...a], b))) changed.push(field)
      continue
    }
    if (!Object.is(prev[field], next[field])) changed.push(field)
  }
  return changed
}

/** Whether the form matches the saved baseline (defaults + committed override).
 *  Defined via {@link changedPatchFields} so the per-field equality rule (notably
 *  the order-insensitive `enabledTools` compare) lives in exactly one place. */
export function patchesEqual(a: PersonaConfigPatch, b: PersonaConfigPatch): boolean {
  return changedPatchFields(a, b).length === 0
}
