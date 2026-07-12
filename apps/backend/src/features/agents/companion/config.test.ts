import { describe, expect, test } from "bun:test"
import { TONE_PRESETS, BREVITY_PRESETS } from "@threa/types"
import type { Persona } from "../persona-repository"
import { TONE_PRESET_FRAGMENTS, BREVITY_PRESET_FRAGMENTS, resolvePersonaStyleSlots } from "./config"

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "persona_x",
    workspaceId: null,
    slug: "x",
    name: "X",
    description: null,
    avatarEmoji: null,
    avatarUrl: null,
    systemPrompt: "base",
    model: "m",
    escalationModel: null,
    temperature: null,
    maxTokens: null,
    enabledTools: null,
    tonePreset: null,
    brevityPreset: null,
    tonePrompt: null,
    brevityPrompt: null,
    managedBy: "system",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

describe("style preset fragments", () => {
  test("every preset key has an authored, non-empty fragment", () => {
    for (const key of TONE_PRESETS) {
      expect(TONE_PRESET_FRAGMENTS[key].trim().length).toBeGreaterThan(0)
    }
    for (const key of BREVITY_PRESETS) {
      expect(BREVITY_PRESET_FRAGMENTS[key].trim().length).toBeGreaterThan(0)
    }
  })
})

describe("resolvePersonaStyleSlots", () => {
  test("built-in presets resolve to their authored fragments", () => {
    const slots = resolvePersonaStyleSlots(persona({ tonePreset: "direct", brevityPreset: "brief" }))
    expect(slots).toEqual({ tone: TONE_PRESET_FRAGMENTS.direct, brevity: BREVITY_PRESET_FRAGMENTS.brief })
  })

  test("custom free-text slot content passes straight through", () => {
    const slots = resolvePersonaStyleSlots(
      persona({ managedBy: "workspace", tonePrompt: "Sound like a pirate.", brevityPrompt: "Two words max." })
    )
    expect(slots).toEqual({ tone: "Sound like a pirate.", brevity: "Two words max." })
  })

  test("unset slots resolve to undefined (default guidance stays)", () => {
    expect(resolvePersonaStyleSlots(persona())).toEqual({ tone: undefined, brevity: undefined })
  })

  test("free text wins over a preset if both are somehow present", () => {
    const slots = resolvePersonaStyleSlots(persona({ tonePreset: "warm", tonePrompt: "Custom tone." }))
    expect(slots.tone).toBe("Custom tone.")
  })
})
