import { describe, expect, it } from "vitest"
import { foldSeparators, fuzzyQuality } from "./fuzzy"

describe("foldSeparators", () => {
  it("removes whitespace, underscores, and dashes", () => {
    expect(foldSeparators("thumbs up")).toBe("thumbsup")
    expect(foldSeparators("thumbs_up")).toBe("thumbsup")
    expect(foldSeparators("thumbs-up")).toBe("thumbsup")
    expect(foldSeparators("a - b_c d")).toBe("abcd")
  })

  it("leaves other characters untouched", () => {
    expect(foldSeparators("+1")).toBe("+1")
    expect(foldSeparators("café")).toBe("café")
  })
})

describe("fuzzyQuality", () => {
  it("returns 0 when the query is not a subsequence", () => {
    expect(fuzzyQuality("xyz", "general")).toBe(0)
    expect(fuzzyQuality("generall", "general")).toBe(0)
  })

  it("returns 1 for a fully contiguous match from a boundary", () => {
    expect(fuzzyQuality("general", "general")).toBe(1)
    expect(fuzzyQuality("up", "thumbs_up")).toBe(1)
  })

  it("scores boundary-aligned abbreviations highly", () => {
    // t-h contiguous from start, u-p contiguous from the "_" boundary.
    expect(fuzzyQuality("thup", "thumbs_up")).toBe(1)
  })

  it("scores scattered matches below compact ones", () => {
    const scattered = fuzzyQuality("cat", "congratulations")
    const compact = fuzzyQuality("cat", "cat_face")
    expect(scattered).toBeGreaterThan(0)
    expect(compact).toBeGreaterThan(scattered)
  })

  it("matches case-insensitively against the text", () => {
    expect(fuzzyQuality("vs", "View Saved")).toBeGreaterThan(0)
  })

  it("handles empty and oversized queries", () => {
    expect(fuzzyQuality("", "anything")).toBe(0)
    expect(fuzzyQuality("abcd", "abc")).toBe(0)
  })
})
