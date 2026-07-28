import { describe, test, expect } from "bun:test"
import { AGENT_TOOL_NAMES } from "./constants"
import { TOOL_TIERS_BY_NAME, ToolTiers } from "./tool-tiers"
import {
  MUTATING_TOOLS,
  resolveToolEffects,
  EFFECT_LABEL_MAX_CHARS,
  EFFECTS_PER_SESSION_MAX,
  type AgentToolEffect,
} from "./tool-effects"

describe("MUTATING_TOOLS", () => {
  test("answers the question for every agent tool", () => {
    const unanswered = AGENT_TOOL_NAMES.filter((name) => typeof MUTATING_TOOLS[name] !== "boolean")
    expect(unanswered).toEqual([])
  })

  test("every guarded tool is mutating", () => {
    const guardedButInert = AGENT_TOOL_NAMES.filter(
      (name) => TOOL_TIERS_BY_NAME[name] >= ToolTiers.GUARDED && !MUTATING_TOOLS[name]
    )
    expect(guardedButInert).toEqual([])
  })
})

describe("resolveToolEffects", () => {
  test("returns a declared array verbatim", () => {
    const declared: AgentToolEffect[] = [
      { kind: "settings", label: "Theme", target: "theme", before: "light", after: "dark" },
    ]
    expect(resolveToolEffects("update_user_settings", declared)).toEqual(declared)
  })

  test("an empty declaration wins over the mutating fallback", () => {
    expect(resolveToolEffects("update_user_settings", [])).toEqual([])
  })

  test("a mutating tool that declares nothing gets the shapeless fallback", () => {
    expect(resolveToolEffects("save_memo", undefined)).toEqual([{ kind: "other" }])
  })

  test("a non-mutating tool gets no effects", () => {
    expect(resolveToolEffects("send_message", undefined)).toEqual([])
  })

  test("an unregistered host-local tool gets no effects", () => {
    expect(resolveToolEffects("enclave_read_local_thing", undefined)).toEqual([])
  })

  test("truncates label, before and after", () => {
    const long = "x".repeat(EFFECT_LABEL_MAX_CHARS + 40)
    expect(resolveToolEffects("save_memo", [{ kind: "memo", label: long, before: long, after: long }])).toEqual([
      {
        kind: "memo",
        label: "x".repeat(EFFECT_LABEL_MAX_CHARS),
        before: "x".repeat(EFFECT_LABEL_MAX_CHARS),
        after: "x".repeat(EFFECT_LABEL_MAX_CHARS),
      },
    ])
  })

  test("caps the array", () => {
    const declared: AgentToolEffect[] = Array.from({ length: EFFECTS_PER_SESSION_MAX + 5 }, (_, i) => ({
      kind: "memo" as const,
      label: `memo ${i}`,
    }))
    expect(resolveToolEffects("save_memo", declared)).toEqual(declared.slice(0, EFFECTS_PER_SESSION_MAX))
  })
})
