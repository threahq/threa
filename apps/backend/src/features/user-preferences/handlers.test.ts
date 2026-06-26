import { describe, expect, it } from "bun:test"
import { VOICE_STEERING_WORDS_MAX, VOICE_STEERING_WORD_MAX_LENGTH } from "@threa/types"
import { updatePreferencesSchema } from "./handlers"

describe("updatePreferencesSchema voiceSteeringWords", () => {
  it("accepts a list and trims each entry", () => {
    const parsed = updatePreferencesSchema.parse({ voiceSteeringWords: ["  Langfuse  ", "pgvector"] })
    expect(parsed.voiceSteeringWords).toEqual(["Langfuse", "pgvector"])
  })

  it("rejects a blank/whitespace-only entry", () => {
    expect(updatePreferencesSchema.safeParse({ voiceSteeringWords: ["ok", "   "] }).success).toBe(false)
  })

  it("rejects an entry over the max length", () => {
    const tooLong = "x".repeat(VOICE_STEERING_WORD_MAX_LENGTH + 1)
    expect(updatePreferencesSchema.safeParse({ voiceSteeringWords: [tooLong] }).success).toBe(false)
  })

  it("rejects more than the max number of words", () => {
    const tooMany = Array.from({ length: VOICE_STEERING_WORDS_MAX + 1 }, (_, i) => `t${i}`)
    expect(updatePreferencesSchema.safeParse({ voiceSteeringWords: tooMany }).success).toBe(false)
  })

  it("treats the field as optional", () => {
    expect(updatePreferencesSchema.parse({}).voiceSteeringWords).toBeUndefined()
  })
})
