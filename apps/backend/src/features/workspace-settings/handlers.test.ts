import { describe, expect, it } from "bun:test"
import { VOICE_STEERING_WORDS_MAX, VOICE_STEERING_WORD_MAX_LENGTH } from "@threa/types"
import { updateWorkspaceSettingsSchema } from "./handlers"

describe("updateWorkspaceSettingsSchema voiceSteeringWords", () => {
  it("accepts a list and trims each entry", () => {
    const parsed = updateWorkspaceSettingsSchema.parse({ voiceSteeringWords: ["  Acme  ", "pgvector"] })
    expect(parsed.voiceSteeringWords).toEqual(["Acme", "pgvector"])
  })

  it("rejects a blank entry and over-length entries", () => {
    expect(updateWorkspaceSettingsSchema.safeParse({ voiceSteeringWords: ["ok", "  "] }).success).toBe(false)
    const tooLong = "x".repeat(VOICE_STEERING_WORD_MAX_LENGTH + 1)
    expect(updateWorkspaceSettingsSchema.safeParse({ voiceSteeringWords: [tooLong] }).success).toBe(false)
  })

  it("rejects more than the max number of words", () => {
    const tooMany = Array.from({ length: VOICE_STEERING_WORDS_MAX + 1 }, (_, i) => `t${i}`)
    expect(updateWorkspaceSettingsSchema.safeParse({ voiceSteeringWords: tooMany }).success).toBe(false)
  })

  it("treats the field as optional", () => {
    expect(updateWorkspaceSettingsSchema.parse({}).voiceSteeringWords).toBeUndefined()
  })
})

describe("updateWorkspaceSettingsSchema defaultCompanionPersonaId", () => {
  it("accepts a persona id", () => {
    expect(
      updateWorkspaceSettingsSchema.parse({ defaultCompanionPersonaId: "persona_1" }).defaultCompanionPersonaId
    ).toBe("persona_1")
  })

  it("accepts null to clear back to Ariadne", () => {
    expect(
      updateWorkspaceSettingsSchema.parse({ defaultCompanionPersonaId: null }).defaultCompanionPersonaId
    ).toBeNull()
  })

  it("rejects an empty or over-long id", () => {
    expect(updateWorkspaceSettingsSchema.safeParse({ defaultCompanionPersonaId: "" }).success).toBe(false)
    expect(updateWorkspaceSettingsSchema.safeParse({ defaultCompanionPersonaId: "x".repeat(65) }).success).toBe(false)
  })

  it("treats the field as optional", () => {
    expect(updateWorkspaceSettingsSchema.parse({}).defaultCompanionPersonaId).toBeUndefined()
  })
})

describe("updateWorkspaceSettingsSchema billingTimezone", () => {
  it("accepts an IANA zone", () => {
    expect(updateWorkspaceSettingsSchema.parse({ billingTimezone: "Europe/Stockholm" }).billingTimezone).toBe(
      "Europe/Stockholm"
    )
    expect(updateWorkspaceSettingsSchema.parse({ billingTimezone: "UTC" }).billingTimezone).toBe("UTC")
  })

  it("rejects a zone Intl cannot resolve", () => {
    expect(updateWorkspaceSettingsSchema.safeParse({ billingTimezone: "Mars/Olympus" }).success).toBe(false)
    expect(updateWorkspaceSettingsSchema.safeParse({ billingTimezone: "UTC+1" }).success).toBe(false)
    expect(updateWorkspaceSettingsSchema.safeParse({ billingTimezone: "" }).success).toBe(false)
  })

  it("treats the field as optional", () => {
    expect(updateWorkspaceSettingsSchema.parse({}).billingTimezone).toBeUndefined()
  })
})
