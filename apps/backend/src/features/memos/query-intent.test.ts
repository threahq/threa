import { describe, expect, it } from "bun:test"
import { classifyMemoQueryIntent } from "./query-intent"

describe("classifyMemoQueryIntent", () => {
  it("treats a short query with no digits as an entity lookup (vector-leaning)", () => {
    const result = classifyMemoQueryIntent("billing migration")
    expect(result.intent).toBe("entity")
    expect(result.semanticWeight).toBeGreaterThan(result.keywordWeight)
  })

  it("treats a single token as an entity lookup", () => {
    const result = classifyMemoQueryIntent("Stripe")
    expect(result.intent).toBe("entity")
    expect(result.semanticWeight).toBeGreaterThan(result.keywordWeight)
  })

  it("treats a query with a year as temporal (keyword-leaning)", () => {
    const result = classifyMemoQueryIntent("what did we decide in 2024")
    expect(result.intent).toBe("temporal")
    expect(result.keywordWeight).toBeGreaterThan(result.semanticWeight)
  })

  it("treats an ISO date query as temporal", () => {
    const result = classifyMemoQueryIntent("incident on 2025-01-15")
    expect(result.intent).toBe("temporal")
    expect(result.keywordWeight).toBeGreaterThan(result.semanticWeight)
  })

  it("detects non-ASCII numerals as temporal (script-neutral digits, INV-54)", () => {
    // Arabic-Indic 2024 and Devanagari 2025 must classify like ASCII digits.
    for (const q of ["مذكرة ٢٠٢٤", "निर्णय २०२५"]) {
      const result = classifyMemoQueryIntent(q)
      expect(result.intent).toBe("temporal")
      expect(result.keywordWeight).toBeGreaterThan(result.semanticWeight)
    }
  })

  it("treats a longer conceptual query as general (balanced)", () => {
    const result = classifyMemoQueryIntent("how do we handle workspace access derivation")
    expect(result.intent).toBe("general")
    expect(result.keywordWeight).toBe(result.semanticWeight)
  })

  it("always returns positive weights that sum to 1", () => {
    for (const q of ["", "x", "a b c d e f", "release 2023-09 rollback plan", "auth"]) {
      const { keywordWeight, semanticWeight } = classifyMemoQueryIntent(q)
      expect(keywordWeight).toBeGreaterThan(0)
      expect(semanticWeight).toBeGreaterThan(0)
      expect(keywordWeight + semanticWeight).toBeCloseTo(1, 5)
    }
  })

  it("is deterministic and language-neutral (no natural-language keyword lists)", () => {
    // Same structural shape in a non-English script must classify identically
    // to its ASCII analogue: two short tokens, no digits -> entity.
    const ascii = classifyMemoQueryIntent("project roadmap")
    const cjk = classifyMemoQueryIntent("プロジェクト 計画")
    expect(cjk.intent).toBe(ascii.intent)
    expect(classifyMemoQueryIntent("project roadmap")).toEqual(ascii)
  })
})
