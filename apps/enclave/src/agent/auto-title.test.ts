import { describe, expect, it } from "vitest"
import { sanitizeTitle } from "./auto-title"

describe("sanitizeTitle", () => {
  it("returns a trimmed single-line title", () => {
    expect(sanitizeTitle("  Trip planning to France  ")).toBe("Trip planning to France")
  })

  it("strips surrounding quotes and a trailing period the model tends to add", () => {
    expect(sanitizeTitle('"Quarterly budget review."')).toBe("Quarterly budget review")
    expect(sanitizeTitle("“Launch checklist”")).toBe("Launch checklist")
  })

  it("collapses to the first non-empty line and normalizes whitespace", () => {
    expect(sanitizeTitle("\n\n  Onboarding   notes \nignored second line")).toBe("Onboarding notes")
  })

  it("caps overly long titles", () => {
    const long = "a".repeat(200)
    expect(sanitizeTitle(long)!.length).toBe(60)
  })

  it("returns null for empty / missing input", () => {
    expect(sanitizeTitle("")).toBeNull()
    expect(sanitizeTitle("   \n  ")).toBeNull()
    expect(sanitizeTitle(null)).toBeNull()
    expect(sanitizeTitle(undefined)).toBeNull()
  })
})
