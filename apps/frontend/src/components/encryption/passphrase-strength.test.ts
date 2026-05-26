import { describe, expect, it } from "vitest"
import { scorePassphrase } from "./passphrase-strength"

describe("scorePassphrase", () => {
  it("scores an empty passphrase at the bottom", () => {
    expect(scorePassphrase("").level).toBe(0)
  })

  it("scores a short single-class passphrase as weak", () => {
    expect(scorePassphrase("abcdefghij").level).toBeLessThanOrEqual(1)
  })

  it("rewards length even for a single character class", () => {
    expect(scorePassphrase("aaaaaaaaaaaaaaaaaaaaaaaa").level).toBeGreaterThan(scorePassphrase("aaaaaaaaaa").level)
  })

  it("rewards mixing character classes", () => {
    const sameLengthSimple = scorePassphrase("aaaaaaaaaaaaaa").level
    const sameLengthMixed = scorePassphrase("Aa1!Aa1!Aa1!Aa").level
    expect(sameLengthMixed).toBeGreaterThan(sameLengthSimple)
  })

  it("caps at level 4 (strong)", () => {
    expect(scorePassphrase("AbCdEf1!".repeat(8)).level).toBe(4)
  })

  it("always returns a non-empty label and description", () => {
    for (const pw of ["", "x", "xxxxxxxxxx", "Aa1!Aa1!Aa1!"]) {
      const s = scorePassphrase(pw)
      expect(s.label.length).toBeGreaterThan(0)
      expect(s.description.length).toBeGreaterThan(0)
    }
  })
})
