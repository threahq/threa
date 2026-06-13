import { describe, it, expect } from "vitest"
import { scoreMatch, rankMatches } from "./match-score"

describe("scoreMatch", () => {
  it("returns 0 for an empty query (no scoring required)", () => {
    expect(scoreMatch("", ["View Saved"], ["bookmark"])).toBe(0)
  })

  it("tiers label matches: exact < prefix < contains", () => {
    expect(scoreMatch("view saved", ["View Saved"])).toBe(0)
    expect(scoreMatch("view", ["View Saved"])).toBe(1)
    expect(scoreMatch("saved", ["View Saved"])).toBe(2)
  })

  it("tiers keyword matches a whole band below label matches", () => {
    expect(scoreMatch("saved", ["Add To-do"], ["saved"])).toBe(3)
    expect(scoreMatch("sav", ["Add To-do"], ["saved"])).toBe(4)
    expect(scoreMatch("ave", ["Add To-do"], ["saved"])).toBe(5)
  })

  it("ranks any label match above any keyword match", () => {
    const labelContains = scoreMatch("saved", ["View Saved"], [])
    const keywordExact = scoreMatch("saved", ["Add To-do"], ["saved"])
    expect(labelContains).toBeLessThan(keywordExact)
  })

  it("takes the best score across multiple labels", () => {
    expect(scoreMatch("alice", ["Alice Smith", "alice"])).toBe(0)
  })

  it("returns Infinity when nothing matches", () => {
    expect(scoreMatch("zzz", ["View Saved"], ["bookmark"])).toBe(Infinity)
  })

  it("is case-insensitive on both sides", () => {
    expect(scoreMatch("SAVED", ["view saved"])).toBe(2)
    expect(scoreMatch("saved", ["VIEW SAVED"])).toBe(2)
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
})
