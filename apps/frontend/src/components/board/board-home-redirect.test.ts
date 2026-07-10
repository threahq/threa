import { describe, expect, it } from "vitest"
import type { BoardView } from "@threa/types"
import { boardHomeRedirectHref } from "@/components/board/board-saved-views"

const WS = "ws_1"

function view(overrides: Partial<BoardView> = {}): BoardView {
  return {
    id: "bview_1",
    name: "Channels, active",
    baseLens: "active",
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

describe("boardHomeRedirectHref", () => {
  it("expands the default view to its canonical filtered URL", () => {
    expect(boardHomeRedirectHref(WS, "bview_1", [view()], "all")).toBe(`/w/${WS}/board/active?is=channel`)
  })

  it("uses the segment-less base for a view whose lens is the viewer's home", () => {
    const v = view({ id: "bview_2", baseLens: "all", scopeStreamTypes: ["dm"] })
    expect(boardHomeRedirectHref(WS, "bview_2", [v], "all")).toBe(`/w/${WS}/board?is=dm`)
  })

  it("returns null when no default view is set", () => {
    expect(boardHomeRedirectHref(WS, null, [view()], "all")).toBeNull()
  })

  it("returns null while views are still loading", () => {
    expect(boardHomeRedirectHref(WS, "bview_1", undefined, "all")).toBeNull()
  })

  it("falls back to the lens (null) when the default id no longer resolves", () => {
    expect(boardHomeRedirectHref(WS, "bview_gone", [view()], "all")).toBeNull()
  })

  it("returns null when the view expands to the bare home URL (no redirect loop)", () => {
    // A view on the home lens with no filters would address `/board` itself —
    // redirecting there from bare `/board` would loop, so the helper declines.
    const bare = view({ id: "bview_bare", baseLens: "all", scopeStreamTypes: [] })
    expect(boardHomeRedirectHref(WS, "bview_bare", [bare], "all")).toBeNull()
  })
})
