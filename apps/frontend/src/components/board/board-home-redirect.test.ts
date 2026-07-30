import { describe, expect, it } from "vitest"
import type { BoardView } from "@threa/types"
import { boardHomeHref } from "@/components/board/board-saved-views"

const WS = "ws_1"

function view(overrides: Partial<BoardView> = {}): BoardView {
  return {
    id: "bview_1",
    name: "Channels, mine",
    baseLens: "mine",
    scopeStreamIds: [],
    scopeStreamTypes: ["channel"],
    scopeLabelIds: [],
    excludeStreamIds: [],
    excludeStreamTypes: [],
    excludeLabelIds: [],
    sortOrder: 0,
    ...overrides,
  }
}

describe("boardHomeHref", () => {
  it("expands the default view to its canonical query URL", () => {
    expect(boardHomeHref(WS, "bview_1", [view()], "all")).toBe(`/w/${WS}/board?lens=mine&is=channel`)
  })

  it("targets the home lens when no default view is set", () => {
    expect(boardHomeHref(WS, null, [view()], "mine")).toBe(`/w/${WS}/board?lens=mine`)
  })

  it("falls back to the home lens when the default id no longer resolves", () => {
    expect(boardHomeHref(WS, "bview_gone", [view()], "all")).toBe(`/w/${WS}/board?lens=all`)
  })

  it("targets `all` for a view stored under a retired lens — the API normalizes it at the read boundary", () => {
    // A row written with a since-retired lens can no longer reach the client as
    // that value: BoardViewRepository's row mapper degrades it to `all`, so the
    // view this helper sees is already normalized.
    const legacy = view({ id: "bview_legacy", baseLens: "all", scopeStreamTypes: [] })
    expect(boardHomeHref(WS, "bview_legacy", [legacy], "all")).toBe(`/w/${WS}/board?lens=all`)
  })

  it("never emits the bare entry alias, even for an unfiltered all-lens view", () => {
    // Bare `/board` IS the redirecting entry — targeting it would loop. The
    // explicit `?lens=` guarantees the redirect terminates in one hop.
    const bare = view({ id: "bview_bare", baseLens: "all", scopeStreamTypes: [] })
    expect(boardHomeHref(WS, "bview_bare", [bare], "all")).toBe(`/w/${WS}/board?lens=all`)
  })
})
