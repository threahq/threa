import { describe, it, expect } from "vitest"
import type { BoardView } from "@threa/types"
import { savedViewHref, isViewActive, type BoardViewSelection } from "./board-saved-views"

const view = (over: Partial<BoardView> = {}): BoardView => ({
  id: "boardview_1",
  name: "Design work",
  baseLens: "mine",
  scopeStreamIds: ["stream_1"],
  scopeStreamTypes: [],
  scopeLabelIds: [],
  excludeStreamIds: [],
  excludeStreamTypes: [],
  excludeLabelIds: [],
  sortOrder: 0,
  ...over,
})

describe("isViewActive", () => {
  const selection = (over: Partial<BoardViewSelection> = {}): BoardViewSelection => ({
    lens: "mine",
    scopeStreamIds: ["stream_1"],
    scopeStreamTypes: [],
    scopeLabelIds: [],
    excludeStreamIds: [],
    excludeStreamTypes: [],
    excludeLabelIds: [],
    ...over,
  })

  it("matches when the lens and every filter axis agree, order-independent", () => {
    expect(isViewActive(view({ scopeStreamIds: ["a", "b"] }), selection({ scopeStreamIds: ["b", "a"] }))).toBe(true)
  })

  it("is inactive when the lens differs", () => {
    expect(isViewActive(view(), selection({ lens: "all" }))).toBe(false)
  })

  it("is inactive when a filter axis differs", () => {
    expect(isViewActive(view(), selection({ scopeStreamIds: ["stream_2"] }))).toBe(false)
    expect(isViewActive(view(), selection({ excludeStreamTypes: ["system"] }))).toBe(false)
  })
})

describe("savedViewHref", () => {
  it("expands a saved view into its canonical query URL, lens included", () => {
    const href = savedViewHref("ws_1", view({ scopeStreamIds: ["s1", "s2"], scopeStreamTypes: ["channel"] }))
    const url = new URL(href, "http://x")
    expect(url.pathname).toBe("/w/ws_1/board")
    expect(url.searchParams.get("lens")).toBe("mine")
    expect(url.searchParams.get("in")).toBe("s1,s2")
    expect(url.searchParams.get("is")).toBe("channel")
  })

  it("never emits the bare entry alias, even for an unfiltered all-lens view", () => {
    expect(savedViewHref("ws_1", view({ baseLens: "all", scopeStreamIds: [], scopeStreamTypes: [] }))).toBe(
      "/w/ws_1/board?lens=all"
    )
  })

  it("expands the exclude and label axes into their params", () => {
    const href = savedViewHref(
      "ws_1",
      view({
        baseLens: "all",
        scopeStreamIds: [],
        scopeLabelIds: ["label_a"],
        excludeStreamIds: ["s9"],
        excludeStreamTypes: ["system"],
        excludeLabelIds: ["label_b"],
      })
    )
    const url = new URL(href, "http://x")
    expect(url.pathname).toBe("/w/ws_1/board")
    expect(url.searchParams.get("lens")).toBe("all")
    expect(url.searchParams.get("label")).toBe("label_a")
    expect(url.searchParams.get("not-in")).toBe("s9")
    expect(url.searchParams.get("not-is")).toBe("system")
    expect(url.searchParams.get("not-label")).toBe("label_b")
  })
})
