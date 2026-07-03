import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverAdditionalModels, modelSuggestions, THINKING_LEVELS } from "./model-catalog"

function writeConfig(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "model-catalog-"))
  const path = join(dir, "claude.json")
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents))
  return path
}

describe("discoverAdditionalModels", () => {
  it("reads value/label/description entries from the client's cache", () => {
    const path = writeConfig({
      additionalModelOptionsCache: [
        { value: "claude-fable-5[1m]", label: "Fable", description: "Fable 5 · Most capable" },
      ],
    })
    expect(discoverAdditionalModels(path)).toEqual([
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
    expect(discoverAdditionalModels(path)).toEqual([{ value: "claude-x", description: "desc" }])
  })

  it("returns empty for a missing file, invalid JSON, or a non-array cache", () => {
    expect(discoverAdditionalModels("/nonexistent/claude.json")).toEqual([])
    expect(discoverAdditionalModels(writeConfig("{not json"))).toEqual([])
    expect(discoverAdditionalModels(writeConfig({ additionalModelOptionsCache: "fable" }))).toEqual([])
  })
})

describe("modelSuggestions", () => {
  it("appends discovered models after the baseline aliases", () => {
    const path = writeConfig({
      additionalModelOptionsCache: [{ value: "claude-fable-5[1m]", label: "Fable", description: "Fable 5" }],
    })
    const suggestions = modelSuggestions(path)
    const values = suggestions.map((suggestion) => suggestion.value)
    expect(values).toEqual(["default", "opus", "sonnet", "haiku", "claude-fable-5[1m]"])
    // Every entry carries display copy for the composer's arg picker.
    expect(suggestions.every((suggestion) => suggestion.label && suggestion.description)).toBe(true)
  })

  it("dedupes a discovered model whose label collides with a baseline alias", () => {
    const path = writeConfig({
      additionalModelOptionsCache: [{ value: "claude-opus-9", label: "Opus", description: "future" }],
    })
    expect(modelSuggestions(path).filter((suggestion) => suggestion.label === "Opus")).toHaveLength(1)
  })

  it("falls back to baseline-only when discovery finds nothing", () => {
    expect(modelSuggestions("/nonexistent/claude.json").map((suggestion) => suggestion.value)).toEqual([
      "default",
      "opus",
      "sonnet",
      "haiku",
    ])
  })
})

describe("THINKING_LEVELS", () => {
  it("matches the /effort levels Claude Code accepts", () => {
    expect([...THINKING_LEVELS]).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"])
  })
})
