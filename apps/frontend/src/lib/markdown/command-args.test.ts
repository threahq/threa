import { describe, it, expect } from "vitest"
import { scanCommandArgs, leadingValueSpan } from "./command-args"
import type { CommandArgNames } from "./command-list-context"

const SPAWN_ARGS: CommandArgNames = {
  flags: new Map([
    ["model", new Set(["opus", "openai-codex/gpt-5.6-luna"])],
    ["thinking", new Set(["low", "high"])],
  ]),
  values: new Set(["claude", "pi"]),
}

describe("scanCommandArgs", () => {
  it("claims the value a flag advertises", () => {
    expect(scanCommandArgs("pi /model opus", SPAWN_ARGS)).toEqual([{ from: 3, to: 14, name: "model", value: "opus" }])
  })

  it("claims the flag alone when the value is not advertised", () => {
    expect(scanCommandArgs("pi /model whatever", SPAWN_ARGS)).toEqual([{ from: 3, to: 9, name: "model" }])
  })

  it("ignores a flag the command does not declare", () => {
    expect(scanCommandArgs("pi /verbose opus", SPAWN_ARGS)).toEqual([])
  })

  it("leaves a path segment alone", () => {
    expect(scanCommandArgs("pi /model/checkpoints", SPAWN_ARGS)).toEqual([])
  })

  it("claims two flags in a row without eating the next as a value", () => {
    expect(scanCommandArgs("/model opus /thinking high", SPAWN_ARGS)).toEqual([
      { from: 0, to: 11, name: "model", value: "opus" },
      { from: 12, to: 26, name: "thinking", value: "high" },
    ])
  })

  it("finds nothing for a command with no flags", () => {
    expect(scanCommandArgs("/model opus", { flags: new Map(), values: new Set() })).toEqual([])
  })
})

describe("leadingValueSpan", () => {
  it("claims a first word the command advertises", () => {
    expect(leadingValueSpan(" pi /model opus", SPAWN_ARGS)).toEqual({ from: 1, to: 3 })
  })

  it("claims nothing when the first word is free text", () => {
    expect(leadingValueSpan(" fix the thing", SPAWN_ARGS)).toBeNull()
    expect(leadingValueSpan("   ", SPAWN_ARGS)).toBeNull()
  })
})
