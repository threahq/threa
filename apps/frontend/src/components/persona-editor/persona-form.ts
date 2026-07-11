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
 * Draft-sync lifecycle shared by the editor form (which owns the debounce and
 * drives it) and the test-chat pane (which mirrors it as a "saving/saved"
 * indicator so the tester sees the chat is running the latest edits).
 */
export type SyncState = "idle" | "syncing" | "synced" | "error"

export function syncHintText(sync: SyncState): string {
  switch (sync) {
    case "syncing":
      return "Saving draft…"
    case "synced":
      return "Draft saved"
    case "error":
      return "Draft not saved"
    default:
      return ""
  }
}

/** The editable slice of the resolved config (defaults or resolved). */
export function toFormValues(config: PersonaResolvedConfig): PersonaFormValues {
  return {
    name: config.name,
    description: config.description,
    avatarEmoji: config.avatarEmoji,
    systemPrompt: config.systemPrompt,
    model: config.model,
    escalationModel: config.escalationModel,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    enabledTools: [...config.enabledTools],
  }
}

/** Defaults with a sparse patch (draft or override) applied over them. */
export function applyPatch(defaults: PersonaResolvedConfig, patch: PersonaConfigPatch | null): PersonaFormValues {
  const base = toFormValues(defaults)
  if (!patch) return base
  return {
    ...base,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.avatarEmoji !== undefined ? { avatarEmoji: patch.avatarEmoji } : {}),
    ...(patch.systemPrompt !== undefined ? { systemPrompt: patch.systemPrompt } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.escalationModel !== undefined ? { escalationModel: patch.escalationModel } : {}),
    ...(patch.temperature !== undefined ? { temperature: patch.temperature } : {}),
    ...(patch.maxTokens !== undefined ? { maxTokens: patch.maxTokens } : {}),
    ...(patch.enabledTools !== undefined ? { enabledTools: [...patch.enabledTools] } : {}),
  }
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
  const patch: PersonaConfigPatch = {}
  if (isFieldOverridden(values, defaults, "name")) patch.name = values.name
  if (isFieldOverridden(values, defaults, "description")) patch.description = values.description
  if (isFieldOverridden(values, defaults, "avatarEmoji")) patch.avatarEmoji = values.avatarEmoji
  if (isFieldOverridden(values, defaults, "systemPrompt")) patch.systemPrompt = values.systemPrompt
  if (isFieldOverridden(values, defaults, "model")) patch.model = values.model
  if (isFieldOverridden(values, defaults, "escalationModel")) patch.escalationModel = values.escalationModel
  if (isFieldOverridden(values, defaults, "temperature")) patch.temperature = values.temperature
  if (isFieldOverridden(values, defaults, "maxTokens")) patch.maxTokens = values.maxTokens
  if (isFieldOverridden(values, defaults, "enabledTools")) patch.enabledTools = [...values.enabledTools]
  return patch
}

/** Whether the form matches the saved baseline (defaults + committed override). */
export function patchesEqual(a: PersonaConfigPatch, b: PersonaConfigPatch): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<PersonaFormField>
  for (const key of keys) {
    if (key === "enabledTools") {
      const av = a.enabledTools
      const bv = b.enabledTools
      if ((av === undefined) !== (bv === undefined)) return false
      if (av && bv && !toolsEqual([...av], bv)) return false
      continue
    }
    if (!Object.is(a[key], b[key])) return false
  }
  return true
}
