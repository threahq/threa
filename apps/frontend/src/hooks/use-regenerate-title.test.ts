import { describe, expect, it } from "vitest"
import { isProtectedRegenerableTitle } from "./use-regenerate-title"

describe("isProtectedRegenerableTitle", () => {
  it("allows non-empty explicit and legacy titles, including missing legacy provenance", () => {
    expect(isProtectedRegenerableTitle("Title", "explicit")).toBe(true)
    expect(isProtectedRegenerableTitle("Title", "legacy")).toBe(true)
    expect(isProtectedRegenerableTitle("Title", null)).toBe(true)
  })

  it("hides generated and empty titles", () => {
    expect(isProtectedRegenerableTitle("Title", "generated")).toBe(false)
    expect(isProtectedRegenerableTitle(null, "explicit")).toBe(false)
  })
})
