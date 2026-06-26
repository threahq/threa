import { describe, expect, it } from "bun:test"
import { VOICE_STEERING_BASE_TERMS, VOICE_STEERING_WORDS_MAX } from "@threa/types"
import { resolveSteeringTerms } from "./config"

describe("resolveSteeringTerms", () => {
  it("returns the baked-in product terms when the user has none", () => {
    expect(resolveSteeringTerms(null)).toEqual([...VOICE_STEERING_BASE_TERMS])
    expect(resolveSteeringTerms(undefined)).toEqual([...VOICE_STEERING_BASE_TERMS])
    expect(resolveSteeringTerms([])).toEqual([...VOICE_STEERING_BASE_TERMS])
  })

  it("prepends baked-in terms and appends the user's words", () => {
    expect(resolveSteeringTerms(["Langfuse", "pgvector"])).toEqual(["Threa", "Ariadne", "Langfuse", "pgvector"])
  })

  it("trims entries and drops blank ones", () => {
    expect(resolveSteeringTerms(["  Langfuse  ", "   ", ""])).toEqual(["Threa", "Ariadne", "Langfuse"])
  })

  it("dedupes case-insensitively, keeping the baked-in spelling first", () => {
    // "threa" / "ARIADNE" collide with the baked-in terms; a user dup collapses too.
    expect(resolveSteeringTerms(["threa", "ARIADNE", "Langfuse", "langfuse"])).toEqual(["Threa", "Ariadne", "Langfuse"])
  })

  it("keeps every word of a full user list, with the baked-in terms on top (not displacing them)", () => {
    const userWords = Array.from({ length: VOICE_STEERING_WORDS_MAX }, (_, i) => `term${i}`)
    const result = resolveSteeringTerms(userWords)
    // The cap accounts for the baked-in terms, so all 50 user words survive.
    expect(result).toHaveLength(VOICE_STEERING_WORDS_MAX + VOICE_STEERING_BASE_TERMS.length)
    for (const w of userWords) expect(result).toContain(w)
    expect(result[0]).toBe("Threa")
  })

  it("caps an over-long user list at the user max plus the baked-in terms", () => {
    const many = Array.from({ length: VOICE_STEERING_WORDS_MAX + 20 }, (_, i) => `term${i}`)
    expect(resolveSteeringTerms(many)).toHaveLength(VOICE_STEERING_WORDS_MAX + VOICE_STEERING_BASE_TERMS.length)
  })
})
