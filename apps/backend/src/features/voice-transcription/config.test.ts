import { describe, expect, it } from "bun:test"
import { VOICE_STEERING_BASE_TERMS, VOICE_STEERING_WORDS_MAX } from "@threa/types"
import { resolveSteeringTerms } from "./config"

describe("resolveSteeringTerms", () => {
  it("returns the baked-in product terms when the user has none", () => {
    expect(resolveSteeringTerms(null)).toEqual([...VOICE_STEERING_BASE_TERMS])
    expect(resolveSteeringTerms(undefined)).toEqual([...VOICE_STEERING_BASE_TERMS])
    expect(resolveSteeringTerms([])).toEqual([...VOICE_STEERING_BASE_TERMS])
  })

  it("unions the workspace and user sources after the baked-in terms", () => {
    // First arg = workspace-shared list, second = per-user list.
    expect(resolveSteeringTerms(["Langfuse", "pgvector"], ["Ariadne-Two"])).toEqual([
      "Threa",
      "Ariadne",
      "Langfuse",
      "pgvector",
      "Ariadne-Two",
    ])
  })

  it("trims entries and drops blank ones across sources", () => {
    expect(resolveSteeringTerms(["  Langfuse  ", "   "], ["", " pgvector "])).toEqual([
      "Threa",
      "Ariadne",
      "Langfuse",
      "pgvector",
    ])
  })

  it("dedupes case-insensitively across base, workspace, and user (earlier source wins)", () => {
    // workspace "Shared" beats user "shared"; "threa" collides with the baked-in term.
    expect(resolveSteeringTerms(["threa", "Shared"], ["shared", "Mine"])).toEqual([
      "Threa",
      "Ariadne",
      "Shared",
      "Mine",
    ])
  })

  it("keeps a full workspace list and a full user list together, on top of the baked-in terms", () => {
    const workspaceWords = Array.from({ length: VOICE_STEERING_WORDS_MAX }, (_, i) => `ws${i}`)
    const userWords = Array.from({ length: VOICE_STEERING_WORDS_MAX }, (_, i) => `user${i}`)
    const result = resolveSteeringTerms(workspaceWords, userWords)
    // Cap = baked-in + two full lists, so neither list is truncated.
    expect(result).toHaveLength(VOICE_STEERING_BASE_TERMS.length + 2 * VOICE_STEERING_WORDS_MAX)
    expect(result[0]).toBe("Threa")
    for (const w of [...workspaceWords, ...userWords]) expect(result).toContain(w)
  })

  it("caps the merged list at the baked-in terms plus two full lists", () => {
    const workspaceWords = Array.from({ length: VOICE_STEERING_WORDS_MAX }, (_, i) => `ws${i}`)
    const userWords = Array.from({ length: VOICE_STEERING_WORDS_MAX + 20 }, (_, i) => `user${i}`)
    expect(resolveSteeringTerms(workspaceWords, userWords)).toHaveLength(
      VOICE_STEERING_BASE_TERMS.length + 2 * VOICE_STEERING_WORDS_MAX
    )
  })
})
