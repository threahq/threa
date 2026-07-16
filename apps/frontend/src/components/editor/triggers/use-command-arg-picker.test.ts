import { describe, it, expect } from "vitest"
import type { CommandArgumentSuggestion } from "@threa/types"
import { findPickableArg, filterArgSuggestions } from "./use-command-arg-picker"
import type { CommandItem } from "./types"

const MODEL_SUGGESTIONS: CommandArgumentSuggestion[] = [
  { value: "anthropic/claude-opus-4", label: "Claude Opus 4" },
  { value: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
  { value: "openai/gpt-5", label: "GPT-5", description: "OpenAI flagship" },
]

const MODEL_COMMAND: CommandItem = {
  name: "model",
  description: "Switch the active model",
  args: [{ name: "model", required: true, suggestions: MODEL_SUGGESTIONS }],
}

describe("findPickableArg", () => {
  it("returns the first argument carrying suggestions", () => {
    expect(findPickableArg(MODEL_COMMAND)?.name).toBe("model")
  })

  it("returns null when the command has no arguments", () => {
    expect(findPickableArg({ name: "reload", description: "Reload" })).toBeNull()
  })

  it("returns null when arguments carry no suggestions", () => {
    const cmd: CommandItem = {
      name: "invite",
      description: "Invite",
      args: [{ name: "email", required: true }],
    }
    expect(findPickableArg(cmd)).toBeNull()
  })

  it("skips an empty suggestions array and falls through to a populated one", () => {
    const cmd: CommandItem = {
      name: "mixed",
      description: "x",
      args: [
        { name: "first", suggestions: [] },
        { name: "second", suggestions: MODEL_SUGGESTIONS },
      ],
    }
    expect(findPickableArg(cmd)?.name).toBe("second")
  })

  it("never opens a picker for client-action commands (they insert no chip)", () => {
    const cmd: CommandItem = {
      name: "memo",
      description: "Search and embed a memo",
      clientActionId: "memo-search",
      args: [{ name: "anything", suggestions: MODEL_SUGGESTIONS }],
    }
    expect(findPickableArg(cmd)).toBeNull()
  })
})

describe("filterArgSuggestions", () => {
  it("returns every option for an empty query, preserving order", () => {
    expect(filterArgSuggestions(MODEL_SUGGESTIONS, "").map((s) => s.value)).toEqual([
      "anthropic/claude-opus-4",
      "anthropic/claude-sonnet-4",
      "openai/gpt-5",
    ])
  })

  it("matches on the human label, ranking it above fuzzy tail matches", () => {
    // "opus" is also an in-order subsequence of "anthropic/claude-sonnet-4",
    // so the fuzzy tier admits it — but only below the substring match.
    const values = filterArgSuggestions(MODEL_SUGGESTIONS, "opus").map((s) => s.value)
    expect(values[0]).toBe("anthropic/claude-opus-4")
    expect(values).toContain("anthropic/claude-sonnet-4")
    expect(values).not.toContain("openai/gpt-5")
  })

  it("matches on the raw value the backend resolves on", () => {
    expect(filterArgSuggestions(MODEL_SUGGESTIONS, "openai").map((s) => s.value)).toEqual(["openai/gpt-5"])
  })

  it("ranks a label match above a description-only match", () => {
    const items: CommandArgumentSuggestion[] = [
      { value: "a/flagship", label: "Aardvark", description: "the gpt flagship" },
      { value: "b/gpt", label: "GPT mini" },
    ]
    // "gpt" matches Aardvark only via its description but is GPT mini's label.
    expect(filterArgSuggestions(items, "gpt").map((s) => s.value)).toEqual(["b/gpt", "a/flagship"])
  })

  it("drops options that match nothing", () => {
    expect(filterArgSuggestions(MODEL_SUGGESTIONS, "zzz")).toEqual([])
  })
})
