import { TONE_PRESETS, BREVITY_PRESETS, type BrevityPreset, type TonePreset } from "@threahq/types"

/**
 * Display metadata for the built-in persona's style-preset pickers (INV-46 — the
 * frontend owns user-facing text; the backend stores only the enum key and maps
 * it to an authored prompt fragment). Each option's one-line description tells an
 * admin what picking it does to the persona's replies. `null` is the "Default"
 * option — that aspect keeps the built-in's shipped guidance (no fragment).
 */
export interface StylePresetOption<T extends string> {
  value: T | null
  label: string
  description: string
}

const DEFAULT_OPTION = {
  value: null,
  label: "Default",
  description: "Keep the built-in guidance for this aspect.",
} as const

const TONE_META: Record<TonePreset, { label: string; description: string }> = {
  warm: { label: "Warm", description: "Encouraging and personable, with a friendly bedside manner." },
  neutral: { label: "Neutral", description: "Even and professional — neither chatty nor clipped." },
  direct: { label: "Direct", description: "Blunt and to the point, no softening or small talk." },
}

const BREVITY_META: Record<BrevityPreset, { label: string; description: string }> = {
  brief: { label: "Brief", description: "The shortest useful answer; a sentence or two, minimal preamble." },
  balanced: { label: "Balanced", description: "Enough detail to be complete without padding." },
  thorough: { label: "Thorough", description: "Fuller explanations with context, caveats, and examples." },
}

export const TONE_PRESET_OPTIONS: StylePresetOption<TonePreset>[] = [
  DEFAULT_OPTION,
  ...TONE_PRESETS.map((value) => ({ value, ...TONE_META[value] })),
]

export const BREVITY_PRESET_OPTIONS: StylePresetOption<BrevityPreset>[] = [
  DEFAULT_OPTION,
  ...BREVITY_PRESETS.map((value) => ({ value, ...BREVITY_META[value] })),
]
