import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { render, screen } from "@/test"
import type { BoardView } from "@threa/types"
import * as Contexts from "@/contexts"
import * as BoardViewsHooks from "@/hooks/use-board-views"
import { setLastLocation } from "@/lib/last-location"
import { BoardModeBlock } from "./board-mode-block"

const WS = "workspace_1"
const USER = "user_1"

function view(over: Partial<BoardView> = {}): BoardView {
  return {
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
  }
}

/** Stub the ambient hooks the block reads: sidebar (collapseOnMobile), the
 *  board-views query, the board home, and the preferences (home lens). */
function stub(
  opts: {
    views?: BoardView[]
    homeView?: BoardView | null
    configuredId?: string | null
    boardDefaultLens?: string | null
  } = {}
) {
  vi.spyOn(Contexts, "useSidebar").mockReturnValue({
    collapseOnMobile: vi.fn(),
  } as unknown as ReturnType<typeof Contexts.useSidebar>)
  vi.spyOn(Contexts, "usePreferencesOptional").mockReturnValue(
    opts.boardDefaultLens === undefined
      ? null
      : ({ preferences: { boardDefaultLens: opts.boardDefaultLens } } as unknown as ReturnType<
          typeof Contexts.usePreferencesOptional
        >)
  )
  vi.spyOn(BoardViewsHooks, "useBoardViews").mockReturnValue({
    data: opts.views ?? [],
  } as unknown as ReturnType<typeof BoardViewsHooks.useBoardViews>)
  vi.spyOn(BoardViewsHooks, "useBoardHome").mockReturnValue({
    view: opts.homeView ?? null,
    configuredId: opts.configuredId ?? null,
  })
}

function mountAt(path: string, props: Partial<Parameters<typeof BoardModeBlock>[0]> = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <BoardModeBlock workspaceId={WS} userId={USER} {...props} />
    </MemoryRouter>
  )
}

function hrefOf(name: RegExp | string): string {
  return screen.getByRole("link", { name }).getAttribute("href") ?? ""
}

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => vi.restoreAllMocks())

describe("BoardModeBlock", () => {
  it("renders the ← Chats link, the Lenses section, and every lens", () => {
    stub()
    mountAt(`/w/${WS}/board`)

    expect(screen.getByText("Chats")).toBeInTheDocument()
    expect(screen.getByText("Lenses")).toBeInTheDocument()
    for (const label of ["All", "Active", "Needs resolution", "Decisions", "Mine"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument()
    }
  })

  it("hides the Views section when the viewer has no saved views", () => {
    stub({ views: [] })
    mountAt(`/w/${WS}/board`)

    expect(screen.queryByText("Views")).not.toBeInTheDocument()
  })

  it("points ← Chats at the retained last stream", () => {
    stub()
    setLastLocation(USER, WS, { surface: "board", streamId: "stream_9", board: { lens: null, search: "" } })
    mountAt(`/w/${WS}/board`)
    expect(hrefOf("Chats")).toBe(`/w/${WS}/s/stream_9`)
  })

  it("falls back to the workspace home when no stream was retained", () => {
    stub()
    mountAt(`/w/${WS}/board`)
    expect(hrefOf("Chats")).toBe(`/w/${WS}`)
  })

  it("carries the current filters across every lens link", () => {
    stub()
    mountAt(`/w/${WS}/board/active?in=stream_1&label=label_a`)

    const all = new URL(hrefOf("All"), "http://x")
    expect(all.searchParams.get("in")).toBe("stream_1")
    expect(all.searchParams.get("label")).toBe("label_a")

    const decisions = new URL(hrefOf("Decisions"), "http://x")
    expect(decisions.pathname).toBe(`/w/${WS}/board/decisions`)
    expect(decisions.searchParams.get("in")).toBe("stream_1")
  })

  it("canonicalizes the home lens to bare /board and segments the others", () => {
    // Default home lens is All.
    stub()
    mountAt(`/w/${WS}/board`)

    expect(new URL(hrefOf("All"), "http://x").pathname).toBe(`/w/${WS}/board`)
    expect(new URL(hrefOf("Active"), "http://x").pathname).toBe(`/w/${WS}/board/active`)
  })

  it("segments the All lens when the viewer homes on a different lens", () => {
    stub({ boardDefaultLens: "active" })
    mountAt(`/w/${WS}/board/active`)

    expect(new URL(hrefOf("All"), "http://x").pathname).toBe(`/w/${WS}/board/all`)
    // The home lens (Active) collapses to bare /board.
    expect(new URL(hrefOf("Active"), "http://x").pathname).toBe(`/w/${WS}/board`)
  })

  it("marks the current lens active", () => {
    stub()
    mountAt(`/w/${WS}/board/active`)

    expect(screen.getByRole("link", { name: "Active" })).toHaveAttribute("aria-current", "true")
    expect(screen.getByRole("link", { name: "All" })).not.toHaveAttribute("aria-current")
  })

  it("lists saved views in sortOrder, linking each to its canonical URL", () => {
    stub({
      views: [view({ id: "v_b", name: "Second", sortOrder: 2 }), view({ id: "v_a", name: "First", sortOrder: 1 })],
    })
    mountAt(`/w/${WS}/board`)

    expect(screen.getByText("Views")).toBeInTheDocument()
    const rendered = screen
      .getAllByRole("link")
      .map((l) => l.textContent)
      .filter((t) => t === "First" || t === "Second")
    expect(rendered).toEqual(["First", "Second"])
    expect(hrefOf("First")).toContain(`/w/${WS}/board/mine`)
  })

  it("marks the matching saved view active and no lens active", () => {
    const v = view({ baseLens: "mine", scopeStreamIds: ["stream_1"] })
    stub({ views: [v] })
    mountAt(`/w/${WS}/board/mine?in=stream_1`)

    expect(screen.getByRole("link", { name: /Design work/ })).toHaveAttribute("aria-current", "true")
    // The view is the selection, so the underlying Mine lens is NOT marked active.
    expect(screen.getByRole("link", { name: "Mine" })).not.toHaveAttribute("aria-current")
  })

  it("shows the board-home indicator on the pinned view", () => {
    const v = view()
    stub({ views: [v], homeView: v, configuredId: v.id })
    mountAt(`/w/${WS}/board`)

    expect(screen.getByLabelText("Board home")).toBeInTheDocument()
  })
})
