import { describe, expect, it } from "vitest"
import { MAX_BOARD_SCOPE_STREAMS } from "@threa/types"
import {
  clearAxisSearch,
  clearDraftsSearch,
  clearFiltersSearch,
  draftsFocusSearch,
  focusScopeSearch,
  isSoleInclude,
  labelFocusSearch,
  parseIdListParam,
  parseTypeListParam,
  removeAxisValueSearch,
  scopeAllSearch,
  toggleExclude,
  toggleExcludeSearch,
  toggleInclude,
  toggleIncludeSearch,
} from "./board-filter-params"

describe("clearFiltersSearch", () => {
  it("strips every filter param, resets the lens to all, and keeps unrelated URL state", () => {
    const search = "?lens=active&in=a,b&not-in=c&is=dm&not-is=system&label=l1&not-label=l2&panel=conv_1"
    expect(clearFiltersSearch(search)).toBe("?lens=all&panel=conv_1")
  })

  it("is never the bare (query-less) URL — the explicit lens survives", () => {
    // Bare `/board` is the home-redirect entry alias; emitting it from a clear
    // affordance is the filters-bounce this scheme exists to prevent.
    expect(clearFiltersSearch("?in=a")).toBe("?lens=all")
    expect(clearFiltersSearch("")).toBe("?lens=all")
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

describe("isSoleInclude", () => {
  it("is true only when `in` is exactly the one stream", () => {
    expect(isSoleInclude("?in=a", "a")).toBe(true)
    expect(isSoleInclude("?in=a,b", "a")).toBe(false)
    expect(isSoleInclude("?in=b", "a")).toBe(false)
    expect(isSoleInclude("", "a")).toBe(false)
  })
})

describe("focusScopeSearch", () => {
  it("replaces the whole `in` scope with the clicked stream, preserving other axes", () => {
    const next = focusScopeSearch("?in=a,b&is=dm&label=l1&panel=conv_1", "c")
    const params = new URLSearchParams(next)
    expect(params.get("in")).toBe("c")
    expect(params.get("is")).toBe("dm")
    expect(params.get("label")).toBe("l1")
    expect(params.get("panel")).toBe("conv_1")
  })

  it("drops the clicked stream from `not-in` when focusing it", () => {
    const next = focusScopeSearch("?not-in=a,b", "a")
    const params = new URLSearchParams(next)
    expect(params.get("in")).toBe("a")
    expect(params.get("not-in")).toBe("b")
  })

  it("clears `in` when the clicked stream is already the sole include", () => {
    expect(focusScopeSearch("?in=a&is=dm", "a")).toBe("?is=dm")
  })
})

describe("toggleIncludeSearch / toggleExcludeSearch", () => {
  it("adds to `in` additively and moves an id across from `not-in`", () => {
    expect(new URLSearchParams(toggleIncludeSearch("?in=a", "b")).get("in")).toBe("a,b")
    const moved = new URLSearchParams(toggleIncludeSearch("?not-in=a", "a"))
    expect(moved.get("in")).toBe("a")
    expect(moved.get("not-in")).toBeNull()
  })

  it("removes an id from `in` when it is already included", () => {
    expect(new URLSearchParams(toggleIncludeSearch("?in=a,b", "a")).get("in")).toBe("b")
  })

  it("toggles the exclude axis and clears the param when it empties", () => {
    expect(new URLSearchParams(toggleExcludeSearch("?in=a", "a")).get("not-in")).toBe("a")
    expect(toggleExcludeSearch("?not-in=a", "a")).toBe("")
  })

  it("no-ops a new include past MAX_BOARD_SCOPE_STREAMS but still toggles an existing id off", () => {
    const ids = Array.from({ length: MAX_BOARD_SCOPE_STREAMS }, (_, i) => `s${i}`)
    const search = `?in=${ids.join(",")}`
    expect(new URLSearchParams(toggleIncludeSearch(search, "overflow")).get("in")).toBe(ids.join(","))
    expect(new URLSearchParams(toggleIncludeSearch(search, ids[0])).get("in")).toBe(ids.slice(1).join(","))
  })

  it("no-ops a new exclude past MAX_BOARD_SCOPE_STREAMS", () => {
    const ids = Array.from({ length: MAX_BOARD_SCOPE_STREAMS }, (_, i) => `x${i}`)
    const search = `?not-in=${ids.join(",")}`
    expect(new URLSearchParams(toggleExcludeSearch(search, "overflow")).get("not-in")).toBe(ids.join(","))
  })
})

describe("scopeAllSearch", () => {
  it("replaces the whole `in` scope with the section's ids, preserving other axes", () => {
    const next = scopeAllSearch("?in=x&is=dm&label=l1&panel=conv_1", ["a", "b", "c"])
    const params = new URLSearchParams(next)
    expect(params.get("in")).toBe("a,b,c")
    expect(params.get("is")).toBe("dm")
    expect(params.get("label")).toBe("l1")
    expect(params.get("panel")).toBe("conv_1")
  })

  it("dedupes and preserves first-seen order", () => {
    expect(new URLSearchParams(scopeAllSearch("", ["a", "b", "a", "c", "b"])).get("in")).toBe("a,b,c")
  })

  it("caps at MAX_BOARD_SCOPE_STREAMS, keeping the first ids", () => {
    const ids = Array.from({ length: MAX_BOARD_SCOPE_STREAMS + 5 }, (_, i) => `s${i}`)
    const kept = ids.slice(0, MAX_BOARD_SCOPE_STREAMS)
    expect(new URLSearchParams(scopeAllSearch("", ids)).get("in")).toBe(kept.join(","))
  })

  it("drops the scoped ids from `not-in` and keeps the rest", () => {
    const params = new URLSearchParams(scopeAllSearch("?not-in=a,b,z", ["a", "b"]))
    expect(params.get("in")).toBe("a,b")
    expect(params.get("not-in")).toBe("z")
  })

  it("clears `in` for an empty id list while keeping other axes", () => {
    expect(scopeAllSearch("?in=a&is=dm", [])).toBe("?is=dm")
  })
})

describe("labelFocusSearch", () => {
  it("replaces the label include axis with the one label, preserving other axes", () => {
    const next = labelFocusSearch("?label=l1,l2&in=a&is=dm&panel=conv_1", "l3")
    const params = new URLSearchParams(next)
    expect(params.get("label")).toBe("l3")
    expect(params.get("in")).toBe("a")
    expect(params.get("is")).toBe("dm")
    expect(params.get("panel")).toBe("conv_1")
  })

  it("drops the focused label from `not-label`", () => {
    const params = new URLSearchParams(labelFocusSearch("?not-label=l1,l2", "l1"))
    expect(params.get("label")).toBe("l1")
    expect(params.get("not-label")).toBe("l2")
  })
})

describe("removeAxisValueSearch", () => {
  it("drops one value from a list param and keeps the others and unrelated params", () => {
    expect(removeAxisValueSearch("?in=a,b,c&is=dm", "in", "b")).toBe("?in=a%2Cc&is=dm")
    expect(removeAxisValueSearch("?not-label=l1&panel=x", "not-label", "l1")).toBe("?panel=x")
  })
})

describe("drafts filter", () => {
  it("focuses the drafts axis without touching any other", () => {
    expect(draftsFocusSearch("?lens=mine&in=a&panel=x")).toBe("?lens=mine&in=a&panel=x&drafts=true")
  })

  it("is idempotent — re-focusing an already-on drafts filter changes nothing", () => {
    expect(draftsFocusSearch("?drafts=true&lens=all")).toBe("?drafts=true&lens=all")
  })

  it("clears only the drafts axis", () => {
    expect(clearDraftsSearch("?lens=all&drafts=true&unread=true")).toBe("?lens=all&unread=true")
  })

  it("is swept by clearFiltersSearch", () => {
    expect(clearFiltersSearch("?lens=mine&drafts=true&panel=x")).toBe("?lens=all&panel=x")
  })
})

describe("clearAxisSearch", () => {
  it("drops one axis and keeps everything else", () => {
    expect(clearAxisSearch("?lens=all&label=l1&is=dm", "label")).toBe("?lens=all&is=dm")
    expect(clearAxisSearch("?in=a", "in")).toBe("")
  })
})
