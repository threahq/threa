import { describe, it, expect } from "vitest"
import type { CommandArgumentInfo, CommandArgumentSuggestion } from "@threahq/types"
import { pickableArgs, resolveActiveArg, filterArgSuggestions } from "./use-command-arg-picker"
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

describe("pickableArgs", () => {
  it("returns the command's arguments when one of them carries suggestions", () => {
    expect(pickableArgs(MODEL_COMMAND)?.map((arg) => arg.name)).toEqual(["model"])
  })

  it("returns null when the command has no arguments", () => {
    expect(pickableArgs({ name: "reload", description: "Reload" })).toBeNull()
  })

  it("returns null when arguments carry no suggestions", () => {
    const cmd: CommandItem = {
      name: "invite",
      description: "Invite",
      args: [{ name: "email", required: true }],
    }
    expect(pickableArgs(cmd)).toBeNull()
  })

  it("keeps an argument whose suggestions are empty alongside a populated one", () => {
    const cmd: CommandItem = {
      name: "mixed",
      description: "x",
      args: [
        { name: "first", suggestions: [] },
        { name: "second", suggestions: MODEL_SUGGESTIONS },
      ],
    }
    expect(pickableArgs(cmd)?.map((arg) => arg.name)).toEqual(["first", "second"])
  })

  it("never opens a picker for client-action commands (they insert no chip)", () => {
    const cmd: CommandItem = {
      name: "memo",
      description: "Search and embed a memo",
      clientActionId: "memo-search",
      args: [{ name: "anything", suggestions: MODEL_SUGGESTIONS }],
    }
    expect(pickableArgs(cmd)).toBeNull()
  })
})

describe("resolveActiveArg", () => {
  const CLAUDE_MODELS: CommandArgumentSuggestion[] = [{ value: "opus", label: "Opus" }]
  const PI_MODELS: CommandArgumentSuggestion[] = [{ value: "openai-codex/gpt-5.6-luna", label: "GPT-5.6 Luna" }]
  const SPAWN_ARGS: CommandArgumentInfo[] = [
    {
      name: "runtime",
      suggestions: [
        {
          value: "claude",
          label: "Claude Code",
          args: [
            { name: "/model", suggestions: CLAUDE_MODELS },
            { name: "/thinking", suggestions: [{ value: "low" }, { value: "high" }] },
          ],
        },
        {
          value: "pi",
          label: "Pi",
          args: [
            { name: "/model", suggestions: PI_MODELS },
            { name: "/thinking", suggestions: [{ value: "off" }, { value: "medium" }] },
          ],
        },
      ],
    },
    { name: "/model", suggestions: CLAUDE_MODELS },
    { name: "/thinking", suggestions: [{ value: "low" }, { value: "high" }] },
    { name: "name", required: true },
  ]

  it("opens on the positional argument before anything is typed", () => {
    const active = resolveActiveArg(SPAWN_ARGS, "")
    expect(active).toEqual({ arg: SPAWN_ARGS[0], query: "" })
  })

  it("filters the positional argument by the first word", () => {
    expect(resolveActiveArg(SPAWN_ARGS, "p")).toEqual({ arg: SPAWN_ARGS[0], query: "p" })
  })

  it("closes once the first word is finished, so a session name lists nothing", () => {
    expect(resolveActiveArg(SPAWN_ARGS, "pi ")).toBeNull()
    expect(resolveActiveArg(SPAWN_ARGS, "pi fix-the-")).toBeNull()
  })

  it("offers the named runtime's own models under /model", () => {
    expect(resolveActiveArg(SPAWN_ARGS, "pi /model ")?.arg.suggestions).toEqual(PI_MODELS)
    expect(resolveActiveArg(SPAWN_ARGS, "claude /model ")?.arg.suggestions).toEqual(CLAUDE_MODELS)
  })

  it("falls back to the command's own list when no runtime is named", () => {
    expect(resolveActiveArg(SPAWN_ARGS, "/model ")?.arg.suggestions).toEqual(CLAUDE_MODELS)
  })

  it("takes the overrides in either order, and filters each by its own word", () => {
    expect(resolveActiveArg(SPAWN_ARGS, "pi /thinking medi")).toEqual({
      arg: { name: "/thinking", suggestions: [{ value: "off" }, { value: "medium" }] },
      query: "medi",
    })
    expect(resolveActiveArg(SPAWN_ARGS, "pi /thinking high /model gpt")).toEqual({
      arg: { name: "/model", suggestions: PI_MODELS },
      query: "gpt",
    })
  })

  it("closes on the word after a chosen override value", () => {
    expect(resolveActiveArg(SPAWN_ARGS, "pi /model opus fix")).toBeNull()
  })

  it("keeps filling the single argument of a one-argument command", () => {
    expect(resolveActiveArg(MODEL_COMMAND.args ?? [], "son")).toEqual({
      arg: MODEL_COMMAND.args?.[0],
      query: "son",
    })
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
