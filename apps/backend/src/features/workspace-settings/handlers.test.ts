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
