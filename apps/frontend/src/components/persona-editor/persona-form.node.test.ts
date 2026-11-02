import { describe, expect, it } from "vitest"
import type { AgentToolName, PersonaResolvedConfig } from "@threahq/types"
import { applyPatch, computeSparsePatch, isFieldOverridden, patchesEqual, toFormValues } from "./persona-form"

function defaults(overrides: Partial<PersonaResolvedConfig> = {}): PersonaResolvedConfig {
  return {
    id: "persona_system_ariadne",
    workspaceId: null,
    slug: "ariadne",
    name: "Ariadne",
    description: "Your AI thinking companion.",
    avatarEmoji: ":thread:",
    avatarUrl: null,
    systemPrompt: "You are Ariadne.",
    model: "openrouter:anthropic/claude-sonnet-4.6",
    escalationModel: "openrouter:anthropic/claude-opus-4.8",
    temperature: 0.7,
    maxTokens: null,
    enabledTools: ["send_message", "web_search", "read_url"],
    tonePreset: null,
    brevityPreset: null,
    tonePrompt: null,
    brevityPrompt: null,
    managedBy: "system",
    status: "active",
    visibility: "visible",
    e2eCapable: true,
    ...overrides,
  }
}

describe("persona-form helpers", () => {
  it("computes an empty sparse patch when values equal defaults", () => {
    const base = defaults()
    expect(computeSparsePatch(toFormValues(base), base)).toEqual({})
  })

  it("includes only the fields that diverge from defaults", () => {
    const base = defaults()
    const values = { ...toFormValues(base), name: "Ari", temperature: 0.2 }
    expect(computeSparsePatch(values, base)).toEqual({ name: "Ari", temperature: 0.2 })
  })

  it("treats enabledTools order-insensitively", () => {
    const base = defaults()
    const reorderedTools: AgentToolName[] = ["read_url", "send_message", "web_search"]
    const reordered = { ...toFormValues(base), enabledTools: reorderedTools }
    expect(isFieldOverridden(reordered, base, "enabledTools")).toBe(false)
    expect(computeSparsePatch(reordered, base)).toEqual({})

    const changedTools: AgentToolName[] = ["send_message"]
    const changed = { ...toFormValues(base), enabledTools: changedTools }
    expect(isFieldOverridden(changed, base, "enabledTools")).toBe(true)
    expect(computeSparsePatch(changed, base)).toEqual({ enabledTools: ["send_message"] })
  })

  it("resetting a field to its default drops it from the sparse patch", () => {
    const base = defaults()
    const edited = { ...toFormValues(base), name: "Ari" }
    expect(computeSparsePatch(edited, base)).toEqual({ name: "Ari" })

    const reset = { ...edited, name: base.name }
    expect(isFieldOverridden(reset, base, "name")).toBe(false)
    expect(computeSparsePatch(reset, base)).toEqual({})
  })

  it("applies a sparse patch over defaults, leaving untouched fields at default", () => {
    const base = defaults()
    const values = applyPatch(base, { name: "Ari", escalationModel: null })
    expect(values.name).toBe("Ari")
    expect(values.escalationModel).toBeNull()
    expect(values.model).toBe(base.model)
    expect(values.enabledTools).toEqual(base.enabledTools)
  })

  it("compares patches structurally including tool sets", () => {
    expect(patchesEqual({ name: "Ari" }, { name: "Ari" })).toBe(true)
    expect(patchesEqual({ name: "Ari" }, {})).toBe(false)
    expect(patchesEqual({ enabledTools: ["a", "b"] as never }, { enabledTools: ["b", "a"] as never })).toBe(true)
    expect(patchesEqual({ enabledTools: ["a"] as never }, { enabledTools: ["a", "b"] as never })).toBe(false)
  })
})
