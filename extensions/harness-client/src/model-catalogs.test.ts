import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claudeModelSuggestions, discoverAdditionalClaudeModels, piModelSuggestions } from "./model-catalogs"

function writeConfig(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "model-catalogs-"))
  const path = join(dir, "claude.json")
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents))
  return path
}

describe("discoverAdditionalClaudeModels", () => {
  it("reads value/label/description entries from the client's cache", () => {
    const path = writeConfig({
      additionalModelOptionsCache: [
        { value: "claude-fable-5[1m]", label: "Fable", description: "Fable 5 · Most capable" },
      ],
    })
    expect(discoverAdditionalClaudeModels(path)).toEqual([
      { value: "claude-fable-5[1m]", label: "Fable", description: "Fable 5 · Most capable" },
    ])
  })

  it("drops malformed entries but keeps valid ones", () => {
    const path = writeConfig({
      additionalModelOptionsCache: [
        null,
        "nope",
        { label: "no-value" },
        { value: "  " },
        { value: "claude-x", label: 42, description: "desc" },
      ],
    })
    expect(discoverAdditionalClaudeModels(path)).toEqual([{ value: "claude-x", description: "desc" }])
  })

  it("returns empty for a missing file, invalid JSON, or a non-array cache", () => {
    expect(discoverAdditionalClaudeModels("/nonexistent/claude.json")).toEqual([])
    expect(discoverAdditionalClaudeModels(writeConfig("{not json"))).toEqual([])
    expect(discoverAdditionalClaudeModels(writeConfig({ additionalModelOptionsCache: "fable" }))).toEqual([])
  })
})

describe("claudeModelSuggestions", () => {
  it("appends discovered models after the baseline aliases", () => {
    const path = writeConfig({
      additionalModelOptionsCache: [{ value: "claude-fable-5[1m]", label: "Fable", description: "Fable 5" }],
    })
    const suggestions = claudeModelSuggestions(path)
    const values = suggestions.map((suggestion) => suggestion.value)
    expect(values).toEqual(["default", "opus", "sonnet", "haiku", "claude-fable-5[1m]"])
    // Every entry carries display copy for the composer's arg picker.
    expect(suggestions.every((suggestion) => suggestion.label && suggestion.description)).toBe(true)
  })

  it("dedupes a discovered model whose label collides with a baseline alias", () => {
    const path = writeConfig({
      additionalModelOptionsCache: [{ value: "claude-opus-9", label: "Opus", description: "future" }],
    })
    expect(claudeModelSuggestions(path).filter((suggestion) => suggestion.label === "Opus")).toHaveLength(1)
  })

  it("falls back to baseline-only when discovery finds nothing", () => {
    expect(claudeModelSuggestions("/nonexistent/claude.json").map((suggestion) => suggestion.value)).toEqual([
      "default",
      "opus",
      "sonnet",
      "haiku",
    ])
  })
})

describe("piModelSuggestions", () => {
  it("flattens the provider-keyed store into `provider/id` options", () => {
    const path = writeConfig({
      "openai-codex": {
        models: [
          { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", input: ["text", "image"] },
          { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", input: ["text"] },
        ],
      },
      "opencode-go": { models: [{ id: "kimi-k3", name: "Kimi K3", input: ["text", "image"] }] },
    })
    expect(piModelSuggestions(path)).toEqual([
      { value: "openai-codex/gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { value: "openai-codex/gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
      { value: "opencode-go/kimi-k3", label: "Kimi K3" },
    ])
  })

  it("skips models that take no text input and malformed entries", () => {
    const path = writeConfig({
      "openai-codex": {
        models: [
          { id: "image-only", name: "Image Only", input: ["image"] },
          { id: "  ", name: "Blank" },
          null,
          { name: "No Id", input: ["text"] },
          { id: "unnamed", input: ["text"] },
        ],
      },
      "no-models": {},
    })
    expect(piModelSuggestions(path)).toEqual([{ value: "openai-codex/unnamed" }])
  })

  it("returns empty for a missing file or invalid JSON", () => {
    expect(piModelSuggestions("/nonexistent/models-store.json")).toEqual([])
    expect(piModelSuggestions(writeConfig("{not json"))).toEqual([])
  })
})
