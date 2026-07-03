import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface ModelSuggestion {
  value: string
  label?: string
  description?: string
}

/**
 * Effort levels the Claude Code TUI accepts as `/effort <level>` (verified
 * against v2.1.199 — the slider steps, plus `ultracode` = xhigh + workflows).
 * Advertised as `thinkingLevels` so Threa's canonical `/thinking` command
 * surfaces them as picker options; the channel actuates the pick as `/effort`.
 */
export const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultracode"] as const

/**
 * The TUI's built-in `/model` aliases with the display copy its picker shows
 * (v2.1.199). Only the stable aliases live here — models beyond them (e.g.
 * Fable) arrive via `discoverAdditionalModels`, so a new release shows up
 * without a code change.
 */
const BASELINE_MODELS: ModelSuggestion[] = [
  {
    value: "default",
    label: "Default",
    description: "Recommended · Opus 4.8 with 1M context",
  },
  {
    value: "opus",
    label: "Opus",
    description: "Opus 4.8 with 1M context · Best for everyday, complex tasks",
  },
  {
    value: "sonnet",
    label: "Sonnet",
    description: "Sonnet 5 · Efficient for routine tasks",
  },
  {
    value: "haiku",
    label: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
]

/**
 * Claude Code caches the extra model options its own /model picker offers in
 * `~/.claude.json` as `additionalModelOptionsCache: [{ value, label,
 * description }]`. Reading that cache keeps the advertised model list in step
 * with what the local client can actually switch to. The `value` is what the
 * client itself uses for model selection, so it round-trips through
 * `/model <value>` unchanged (verified live: `/model claude-fable-5[1m]`).
 */
export function discoverAdditionalModels(configPath = join(homedir(), ".claude.json")): ModelSuggestion[] {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { additionalModelOptionsCache?: unknown }
    if (!Array.isArray(parsed.additionalModelOptionsCache)) return []
    const result: ModelSuggestion[] = []
    for (const entry of parsed.additionalModelOptionsCache) {
      if (!entry || typeof entry !== "object") continue
      const candidate = entry as Record<string, unknown>
      if (typeof candidate.value !== "string" || !candidate.value.trim()) continue
      result.push({
        value: candidate.value,
        ...(typeof candidate.label === "string" && { label: candidate.label }),
        ...(typeof candidate.description === "string" && { description: candidate.description }),
      })
    }
    return result
  } catch {
    return []
  }
}

/** Baseline aliases plus discovered models, deduped by display label so a model never lists twice. */
export function modelSuggestions(configPath?: string): ModelSuggestion[] {
  const seen = new Set(BASELINE_MODELS.map((model) => (model.label ?? model.value).toLowerCase()))
  const discovered = discoverAdditionalModels(configPath).filter((model) => {
    const key = (model.label ?? model.value).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return [...BASELINE_MODELS, ...discovered]
}
