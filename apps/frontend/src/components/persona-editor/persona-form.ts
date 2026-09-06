import {
  SYSTEM_PERSONA_EDITABLE_FIELDS,
  type AgentToolName,
  type BrevityPreset,
  type PersonaConfigPatch,
  type PersonaCustomConfig,
  type PersonaModelOption,
  type PersonaResolvedConfig,
  type TonePreset,
} from "@threahq/types"

/**
 * The registry-derived assignable models with any off-allowlist ids (a current
 * or default value) folded in so a legal-but-unlisted model still renders as an
 * item instead of a blank Select trigger. Shared by both editors' model /
 * escalation pickers. A folded-in id has no registry label, so it renders raw.
 */
export function buildModelOptions(
  available: PersonaModelOption[],
  extras: (string | null | undefined)[]
): PersonaModelOption[] {
  const options: PersonaModelOption[] = available.map((option) => ({ id: option.id, label: option.label }))
  for (const id of extras) {
    if (id && !options.some((option) => option.id === id)) options.unshift({ id, label: id })
  }
  return options
}

/**
 * The full editable field set the editor holds. Mirrors {@link PersonaResolvedConfig}'s
 * editable fields, but every field is concrete (the form always shows a resolved
 * value). Two editors read from this one shape: the restricted BUILT-IN editor
 * (only the `SYSTEM_PERSONA_EDITABLE_FIELDS` subset is writable — its save is the
 * SPARSE diff against the built-in defaults) and the full CUSTOM editor (writes
 * every custom field verbatim). Presets are built-in-only; the free-text slots
 * (`tonePrompt`/`brevityPrompt`) are custom-only — a given form only ever edits
 * one of the two style shapes, so the other stays at its baseline (null).
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
  tonePreset: TonePreset | null
  brevityPreset: BrevityPreset | null
  tonePrompt: string | null
  brevityPrompt: string | null
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
  "tonePreset",
  "brevityPreset",
  "tonePrompt",
  "brevityPrompt",
] as const satisfies readonly PersonaFormField[]

// Compile error if PersonaFormValues gains a field the list above lacks.
const _exhaustive: PersonaFormField extends (typeof PERSONA_FORM_FIELDS)[number] ? true : never = true
void _exhaustive

/**
 * The fields a BUILT-IN persona's editor may write — the only keys allowed into
 * its sparse override patch (the backend 400s `PERSONA_FIELD_LOCKED` on any
 * other). Same source of truth as the backend restriction ({@link SYSTEM_PERSONA_EDITABLE_FIELDS}).
 */
export const BUILTIN_EDITABLE_FIELDS = SYSTEM_PERSONA_EDITABLE_FIELDS as readonly PersonaFormField[]

/**
 * The fields a CUSTOM persona's editor writes — every key of {@link PersonaCustomConfig}
 * (the full-field PUT body and the draft sparse-diff domain). Presets are absent
 * (a custom uses free-text slots); `slug` is not editable.
 */
export const CUSTOM_EDITABLE_FIELDS = [
  "name",
  "description",
  "avatarEmoji",
  "systemPrompt",
  "model",
  "escalationModel",
  "temperature",
  "maxTokens",
  "enabledTools",
  "tonePrompt",
  "brevityPrompt",
] as const satisfies readonly PersonaFormField[]

// Ties the array to the schema: a key added to PersonaCustomConfig that is
// missing here becomes a compile error, so a new custom field can't silently
// drop out of dirty-tracking / patch inclusion.
const _customExhaustive: keyof PersonaCustomConfig extends (typeof CUSTOM_EDITABLE_FIELDS)[number] ? true : never = true
void _customExhaustive

/** Project the form values onto a custom persona's full PUT config (INV-31 field set). */
export function toCustomConfig(values: PersonaFormValues): PersonaCustomConfig {
  return {
    name: values.name,
    description: values.description,
    avatarEmoji: values.avatarEmoji,
    systemPrompt: values.systemPrompt,
    model: values.model,
    escalationModel: values.escalationModel,
    temperature: values.temperature,
    maxTokens: values.maxTokens,
    enabledTools: values.enabledTools,
    tonePrompt: values.tonePrompt,
    brevityPrompt: values.brevityPrompt,
  }
}

/** Whether two form value sets agree on every field in `fields` (order-insensitive tools). */
export function valuesEqual(a: PersonaFormValues, b: PersonaFormValues, fields: readonly PersonaFormField[]): boolean {
  for (const field of fields) {
    if (field === "enabledTools") {
      if (!toolsEqual(a.enabledTools, b.enabledTools)) return false
      continue
    }
    if (!Object.is(a[field], b[field])) return false
  }
  return true
}

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
 * The sparse override/draft patch: only the fields (of `fields`) that diverge
 * from the baseline. An empty object means "identical to baseline" (no override).
 * `fields` restricts which keys may enter the patch — a built-in editor passes
 * {@link BUILTIN_EDITABLE_FIELDS} so a locked field can never leak in (the
 * backend 400s on any non-editable key); it defaults to the full field set.
 */
export function computeSparsePatch(
  values: PersonaFormValues,
  baseline: PersonaResolvedConfig,
  fields: readonly PersonaFormField[] = PERSONA_FORM_FIELDS
): PersonaConfigPatch {
  const patch = {} as Record<PersonaFormField, unknown>
  for (const field of fields) {
    if (isFieldOverridden(values, baseline, field)) patch[field] = cloneField(values[field])
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
  tonePreset: "tone",
  brevityPreset: "brevity",
  tonePrompt: "tone",
  brevityPrompt: "brevity",
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
