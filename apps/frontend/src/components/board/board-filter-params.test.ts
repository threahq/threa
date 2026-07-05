import { describe, expect, it } from "vitest"
import {
  boardHomeSearch,
  parseIdListParam,
  parseTypeListParam,
  toggleExclude,
  toggleInclude,
} from "./board-filter-params"

describe("boardHomeSearch", () => {
  it("strips every filter param and keeps unrelated URL state", () => {
    const search = "?in=a,b&not-in=c&is=dm&not-is=system&label=l1&not-label=l2&panel=conv_1"
    expect(boardHomeSearch(search)).toBe("?panel=conv_1")
  })

  it("returns an empty string when nothing survives", () => {
    expect(boardHomeSearch("?in=a")).toBe("")
  })
})

describe("parseIdListParam", () => {
  it("splits, trims, dedupes, and preserves order", () => {
    expect(parseIdListParam(" a , b,a,,c ")).toEqual(["a", "b", "c"])
  })

  it("returns empty for null or blank", () => {
    expect(parseIdListParam(null)).toEqual([])
    expect(parseIdListParam("")).toEqual([])
  })
})

describe("parseTypeListParam", () => {
  it("keeps only the board's root grains — `thread` and junk drop silently", () => {
    expect(parseTypeListParam("dm,thread,channel,bogus")).toEqual(["dm", "channel"])
  })
})

describe("toggleInclude / toggleExclude", () => {
  it("adds to include and removes the same id from exclude", () => {
    expect(toggleInclude("a", [], ["a", "b"])).toEqual({ include: ["a"], exclude: ["b"] })
  })

  it("removes from include when already included", () => {
    expect(toggleInclude("a", ["a", "b"], [])).toEqual({ include: ["b"], exclude: [] })
  })

  it("adds to exclude and removes the same id from include", () => {
    expect(toggleExclude("a", ["a", "b"], [])).toEqual({ include: ["b"], exclude: ["a"] })
  })

  it("removes from exclude when already excluded", () => {
    expect(toggleExclude("a", [], ["a", "b"])).toEqual({ include: [], exclude: ["b"] })
  })
})
