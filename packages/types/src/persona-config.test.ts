import { describe, expect, test } from "bun:test"
import {
  personaConfigPatchSchema,
  personaResolvedConfigSchema,
  SYSTEM_PERSONA_EDITABLE_FIELDS,
  PERSONA_SLOT_MAX_CHARS,
} from "./persona-config"

describe("personaConfigPatchSchema style presets", () => {
  test("round-trips tone/brevity preset keys", () => {
    const parsed = personaConfigPatchSchema.parse({ tonePreset: "direct", brevityPreset: "brief" })
    expect(parsed).toEqual({ tonePreset: "direct", brevityPreset: "brief" })
  })

  test("accepts null presets (aspect unset)", () => {
    expect(personaConfigPatchSchema.parse({ tonePreset: null, brevityPreset: null })).toEqual({
      tonePreset: null,
      brevityPreset: null,
    })
  })

  test("rejects an unknown preset value", () => {
    expect(personaConfigPatchSchema.safeParse({ tonePreset: "chipper" }).success).toBe(false)
  })

  test("still rejects extra keys (strict)", () => {
    expect(personaConfigPatchSchema.safeParse({ bogus: true }).success).toBe(false)
  })
})

describe("personaResolvedConfigSchema style slots", () => {
  const base = {
    id: "persona_system_ariadne",
    workspaceId: null,
    slug: "ariadne",
    name: "Ariadne",
    description: null,
    avatarEmoji: null,
    systemPrompt: "You are Ariadne.",
    model: "openrouter:anthropic/claude-sonnet-5",
    escalationModel: null,
    temperature: 0.7,
    maxTokens: null,
    enabledTools: [],
    tonePreset: null,
    brevityPreset: null,
    tonePrompt: null,
    brevityPrompt: null,
    managedBy: "system" as const,
    status: "active" as const,
    visibility: "visible" as const,
    e2eCapable: true,
  }

  test("requires the four slot fields on the wire type", () => {
    expect(personaResolvedConfigSchema.parse(base)).toMatchObject({
      tonePreset: null,
      brevityPreset: null,
      tonePrompt: null,
      brevityPrompt: null,
    })
  })

  test("caps the free-text slot at PERSONA_SLOT_MAX_CHARS", () => {
    const ok = { ...base, tonePrompt: "x".repeat(PERSONA_SLOT_MAX_CHARS) }
    expect(personaResolvedConfigSchema.safeParse(ok).success).toBe(true)
    const tooLong = { ...base, tonePrompt: "x".repeat(PERSONA_SLOT_MAX_CHARS + 1) }
    expect(personaResolvedConfigSchema.safeParse(tooLong).success).toBe(false)
  })
})

describe("SYSTEM_PERSONA_EDITABLE_FIELDS", () => {
  test("is exactly toolset, model, and the two style presets", () => {
    expect([...SYSTEM_PERSONA_EDITABLE_FIELDS]).toEqual(["enabledTools", "model", "tonePreset", "brevityPreset"])
  })
})
