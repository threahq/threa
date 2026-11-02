/**
 * Regression tests for from: filter extension.
 *
 * The trigger should work with just "from:" without requiring "@".
 * This is more user-friendly and matches the pattern of other filters like "is:".
 */
import { describe, it, expect } from "vitest"

// Simulating the match logic from from-filter-extension.ts
function findFromFilterMatch(textBefore: string) {
  // Current implementation - requires from:@
  const matchWithAt = textBefore.match(/(?:^|\s)(from:@)(\S*)$/)
  return matchWithAt
}

// Expected implementation - just from: followed by optional @
function findFromFilterMatchExpected(textBefore: string) {
  const match = textBefore.match(/(?:^|\s)(from:@?)(\S*)$/)
  return match
}

describe("from: filter trigger - current behavior (with @)", () => {
  it("should match from:@martin", () => {
    const match = findFromFilterMatch("from:@martin")
    expect(match).not.toBeNull()
    expect(match?.[2]).toBe("martin")
  })

  it("should match from:@ alone", () => {
    const match = findFromFilterMatch("from:@")
    expect(match).not.toBeNull()
    expect(match?.[2]).toBe("")
  })

  it("should NOT match from: without @", () => {
    const match = findFromFilterMatch("from:")
    expect(match).toBeNull()
  })

  it("should NOT match from:martin without @", () => {
    const match = findFromFilterMatch("from:martin")
    expect(match).toBeNull()
  })
})

describe("from: filter trigger - expected behavior (with or without @)", () => {
  it("should match from:@martin", () => {
    const match = findFromFilterMatchExpected("from:@martin")
    expect(match).not.toBeNull()
    expect(match?.[2]).toBe("martin")
  })

  it("should match from:@ alone", () => {
    const match = findFromFilterMatchExpected("from:@")
    expect(match).not.toBeNull()
    expect(match?.[2]).toBe("")
  })

  it("should ALSO match from: without @ to trigger suggestions", () => {
    const match = findFromFilterMatchExpected("from:")
    expect(match).not.toBeNull()
    expect(match?.[2]).toBe("")
  })

  it("should match from:mar without @", () => {
    const match = findFromFilterMatchExpected("from:mar")
    expect(match).not.toBeNull()
    expect(match?.[2]).toBe("mar")
  })
})
