import { describe, it, expect } from "vitest"
import { scoreMatch, rankMatches } from "./match-score"

describe("scoreMatch", () => {
  it("returns 0 for an empty query (no scoring required)", () => {
    expect(scoreMatch("", ["View Saved"], ["bookmark"])).toBe(0)
  })

  it("tiers label matches: exact < prefix < contains", () => {
    expect(scoreMatch("view saved", ["View Saved"])).toBe(0)
    expect(scoreMatch("view", ["View Saved"])).toBe(2)
    expect(scoreMatch("saved", ["View Saved"])).toBe(4)
  })

  it("treats whitespace, underscore, and dash as interchangeable separators", () => {
    expect(scoreMatch("thumbs up", ["thumbs_up"])).toBe(1)
    expect(scoreMatch("thumbsup", ["thumbs_up"])).toBe(1)
    expect(scoreMatch("thumbs-up", ["thumbs_up"])).toBe(1)
    expect(scoreMatch("thumbsu", ["thumbs_up"])).toBe(3)
    expect(scoreMatch("bs up", ["thumbs_up"])).toBe(5)
  })

  it("ranks a raw match above its separator-normalized counterpart", () => {
    expect(scoreMatch("thumbs_up", ["thumbs_up"])).toBeLessThan(scoreMatch("thumbs up", ["thumbs_up"]))
    expect(scoreMatch("thumbs", ["thumbs_up"])).toBeLessThan(scoreMatch("thumbsu", ["thumbs_up"]))
  })

  it("tiers keyword matches a whole band below label matches", () => {
    expect(scoreMatch("saved", ["Add To-do"], ["saved"])).toBe(6)
    expect(scoreMatch("sav", ["Add To-do"], ["saved"])).toBe(8)
    expect(scoreMatch("ave", ["Add To-do"], ["saved"])).toBe(10)
  })

  it("ranks any label substring match above any keyword substring match", () => {
    const labelContains = scoreMatch("saved", ["View Saved"], [])
    const keywordExact = scoreMatch("saved", ["Add To-do"], ["saved"])
    expect(labelContains).toBeLessThan(keywordExact)
  })

  it("admits fuzzy subsequence matches below every substring match", () => {
    const fuzzy = scoreMatch("thup", ["thumbs_up"])
    expect(fuzzy).not.toBe(Infinity)
    expect(fuzzy).toBeGreaterThan(scoreMatch("ave", ["Add To-do"], ["saved"]))
  })

  it("ranks a keyword substring match above a label fuzzy match", () => {
    const keywordContains = scoreMatch("humb", ["Something Else"], ["thumbs"])
    const labelFuzzy = scoreMatch("thup", ["thumbs_up"])
    expect(keywordContains).toBeLessThan(labelFuzzy)
  })

  it("ranks label fuzzy above keyword fuzzy, and compact fuzzy above scattered", () => {
    const labelFuzzy = scoreMatch("thup", ["thumbs_up"])
    const keywordFuzzy = scoreMatch("thup", ["Something Else"], ["thumbs_up"])
    expect(labelFuzzy).toBeLessThan(keywordFuzzy)

    const compact = scoreMatch("cat", ["cat_face"])
    const scattered = scoreMatch("cat", ["congratulations"])
    expect(compact).toBeLessThan(scattered)
  })

  it("takes the best score across multiple labels", () => {
    expect(scoreMatch("alice", ["Alice Smith", "alice"])).toBe(0)
  })

  it("returns Infinity when nothing matches", () => {
    expect(scoreMatch("zzz", ["View Saved"], ["bookmark"])).toBe(Infinity)
    expect(scoreMatch("vwx", ["View Saved"])).toBe(Infinity)
  })

  it("is case-insensitive on both sides", () => {
    expect(scoreMatch("SAVED", ["view saved"])).toBe(4)
    expect(scoreMatch("saved", ["VIEW SAVED"])).toBe(4)
  })

  it("handles separator-only queries without matching everything", () => {
    expect(scoreMatch("-", ["View Saved"])).toBe(Infinity)
    expect(scoreMatch("-", ["to-do"])).toBe(4)
  })
})

describe("rankMatches", () => {
  interface Item {
    label: string
    keywords?: string[]
  }
  const text = (item: Item) => ({ labels: [item.label], keywords: item.keywords })

  it("returns the input unchanged for an empty query", () => {
    const items: Item[] = [{ label: "b" }, { label: "a" }]
    expect(rankMatches(items, "", text)).toEqual(items)
  })

  it("drops non-matches", () => {
    const items: Item[] = [{ label: "View Saved" }, { label: "Open Memory" }]
    expect(rankMatches(items, "saved", text)).toEqual([{ label: "View Saved" }])
  })

  it("ranks a label match above an earlier-defined keyword-only match", () => {
    const todo: Item = { label: "Add To-do", keywords: ["saved"] }
    const saved: Item = { label: "View Saved", keywords: ["bookmark"] }
    expect(rankMatches([todo, saved], "saved", text)).toEqual([saved, todo])
  })

  it("preserves input order within a tier (stable)", () => {
    const items: Item[] = [{ label: "saver" }, { label: "saved" }]
    // Both are label-prefix matches for "save"; definition order decides.
    expect(rankMatches(items, "save", text)).toEqual(items)
  })

  it("appends fuzzy matches after substring matches", () => {
    const items: Item[] = [{ label: "thumbs_up" }, { label: "setup" }, { label: "sun_with_face" }]
    // "setup" contains "tup" raw; "thumbs_up" only matches as a subsequence.
    expect(rankMatches(items, "tup", text)).toEqual([{ label: "setup" }, { label: "thumbs_up" }])
  })
})
