/**
 * Each runtime's own on-disk model catalog. Read here, not from a live session,
 * so a Claude desk can offer Pi's models when it spawns Pi and back again.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface ModelSuggestion {
  value: string
  label?: string
  description?: string
}

/**
 * Claude Code's built-in `/model` aliases. Only the stable aliases live here —
 * models beyond them (e.g. Fable) arrive via `discoverAdditionalClaudeModels`,
 * so a new release shows up without a code change.
 *
 * The copy names the role, never the version: the alias is stable but the model
 * behind it moves every release, and a hardcoded "Opus 4.8" here outlived the
 * client by two minor versions while claiming to describe it. Version-bearing
 * copy comes only from the client's own cache, which updates with the client.
 */
const CLAUDE_BASELINE_MODELS: ModelSuggestion[] = [
  {
    value: "default",
    label: "Default",
    description: "Recommended · whatever the client picks by default",
  },
  {
    value: "opus",
    label: "Opus",
    description: "Most capable · best for everyday, complex tasks",
  },
  {
    value: "sonnet",
    label: "Sonnet",
    description: "Efficient for routine tasks",
  },
  {
    value: "haiku",
    label: "Haiku",
    description: "Fastest for quick answers",
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
export function discoverAdditionalClaudeModels(configPath = join(homedir(), ".claude.json")): ModelSuggestion[] {
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

/** Claude Code's baseline aliases plus its cached extras, deduped by display label so a model never lists twice. */
export function claudeModelSuggestions(configPath = join(homedir(), ".claude.json")): ModelSuggestion[] {
  const seen = new Set(CLAUDE_BASELINE_MODELS.map((model) => (model.label ?? model.value).toLowerCase()))
  const discovered = discoverAdditionalClaudeModels(configPath).filter((model) => {
    const key = (model.label ?? model.value).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return [...CLAUDE_BASELINE_MODELS, ...discovered]
}

interface PiStoreProvider {
  models?: unknown
}

/**
 * Pi caches every model its configured providers offer in
 * `~/.pi/agent/models-store.json`, keyed by provider. The key plus the model id
 * is exactly what `pi --model` takes (`openai-codex/gpt-5.6-sol`). Models that
 * accept text input are kept; the store is Pi's own refresh cache, so a model
 * added since its last refresh is missing here but still launches when typed.
 */
export function piModelSuggestions(
  storePath = join(homedir(), ".pi", "agent", "models-store.json")
): ModelSuggestion[] {
  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, PiStoreProvider>
    const result: ModelSuggestion[] = []
    for (const [provider, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== "object" || !Array.isArray(entry.models)) continue
      for (const model of entry.models) {
        if (!model || typeof model !== "object") continue
        const candidate = model as Record<string, unknown>
        if (typeof candidate.id !== "string" || !candidate.id.trim()) continue
        if (!Array.isArray(candidate.input) || !candidate.input.includes("text")) continue
        result.push({
          value: `${provider}/${candidate.id}`,
          ...(typeof candidate.name === "string" && candidate.name.trim() ? { label: candidate.name } : {}),
        })
      }
    }
    return result
  } catch {
    return []
  }
}
