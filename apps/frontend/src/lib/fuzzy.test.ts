import { describe, expect, it } from "vitest"
import { foldSeparators, fuzzyQuality, isWordEnd, isWordStart, splitTokens, typoBudget, typoDistance } from "./fuzzy"

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

describe("splitTokens", () => {
  it("splits on whitespace, underscore, dash and colon, dropping empties", () => {
    expect(splitTokens("Heart_eyes-cat  face:2")).toEqual(["heart", "eyes", "cat", "face", "2"])
    expect(splitTokens("__ - ")).toEqual([])
  })
})

describe("word boundaries", () => {
  it("marks the text edges and every separator side", () => {
    expect(isWordStart("no_entry", 0)).toBe(true)
    expect(isWordStart("no_entry", 3)).toBe(true)
    expect(isWordStart("notebook", 2)).toBe(false)
    expect(isWordEnd("no_entry", 2)).toBe(true)
    expect(isWordEnd("no_entry", 8)).toBe(true)
    expect(isWordEnd("notebook", 2)).toBe(false)
  })
})

describe("typoBudget", () => {
  it("spends nothing below four characters and grows once past seven", () => {
    expect(typoBudget(3)).toBe(0)
    expect(typoBudget(4)).toBe(1)
    expect(typoBudget(7)).toBe(1)
    expect(typoBudget(8)).toBe(2)
  })
})

describe("typoDistance", () => {
  it("counts an adjacent transposition as a single edit", () => {
    expect(typoDistance("thubms", "thumbs", 1)).toBe(1)
    expect(typoDistance("recieve", "receive", 1)).toBe(1)
  })

  it("counts substitution, insertion and deletion as single edits", () => {
    expect(typoDistance("smole", "smile", 1)).toBe(1)
    expect(typoDistance("smiile", "smile", 1)).toBe(1)
    expect(typoDistance("smle", "smile", 1)).toBe(1)
  })

  it("matches any single whole token of the text", () => {
    expect(typoDistance("hart", "heart_eyes", 1)).toBe(1)
    expect(typoDistance("eyez", "heart_eyes", 1)).toBe(1)
  })

  it("refuses a match that would land mid-word", () => {
    // A window-based matcher finds "ello" inside "hello" and calls this one
    // edit; anchoring to whole tokens costs it the leading "h" as well.
    expect(typoDistance("ellow", "say_hello_now", 1)).toBe(2)
  })

  it("returns budget + 1 rather than the true distance once past the cap", () => {
    expect(typoDistance("abcdef", "zzzzzz", 1)).toBe(2)
    expect(typoDistance("abcdef", "zzzzzz", 2)).toBe(3)
  })

  it("never matches on a zero budget", () => {
    expect(typoDistance("cat", "cat", 0)).toBe(1)
  })
})
