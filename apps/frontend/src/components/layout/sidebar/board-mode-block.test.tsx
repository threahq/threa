import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter, useLocation } from "react-router-dom"
import { render, screen, userEvent } from "@/test"
import type { BoardView } from "@threa/types"
import * as Contexts from "@/contexts"
import * as BoardViewsHooks from "@/hooks/use-board-views"
import * as ConversationsHooks from "@/hooks/use-conversations"
import * as WorkspaceStore from "@/stores/workspace-store"
import * as BoardExclusions from "@/stores/board-exclusions-store"
import * as InputMode from "@/hooks/use-input-mode"
import { BoardModeBlock } from "./board-mode-block"

const WS = "workspace_1"

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

interface Mocks {
  updatePreferences: ReturnType<typeof vi.fn>
  update: { mutate: ReturnType<typeof vi.fn> }
  remove: { mutate: ReturnType<typeof vi.fn> }
}

/** Stub the ambient hooks the block reads: sidebar (collapseOnMobile), the
 *  board-views query, the board home, the preferences (home lens + writer), the
 *  view mutations, and the filter-group's workspace stores + mute mutations. */
function stub(
  opts: {
    views?: BoardView[]
    homeView?: BoardView | null
    boardDefaultLens?: string | null
  } = {}
): Mocks {
  const updatePreferences = vi.fn()
  const update = { mutate: vi.fn() }
  const remove = { mutate: vi.fn() }

  vi.spyOn(Contexts, "useSidebar").mockReturnValue({
    collapseOnMobile: vi.fn(),
  } as unknown as ReturnType<typeof Contexts.useSidebar>)
  vi.spyOn(Contexts, "usePreferencesOptional").mockReturnValue(
    opts.boardDefaultLens === undefined
      ? null
      : ({ preferences: { boardDefaultLens: opts.boardDefaultLens }, updatePreferences } as unknown as ReturnType<
          typeof Contexts.usePreferencesOptional
        >)
  )
  vi.spyOn(BoardViewsHooks, "useBoardViews").mockReturnValue({
    data: opts.views ?? [],
  } as unknown as ReturnType<typeof BoardViewsHooks.useBoardViews>)
  vi.spyOn(BoardViewsHooks, "useBoardHome").mockReturnValue({
    view: opts.homeView ?? null,
  })
  vi.spyOn(BoardViewsHooks, "useUpdateBoardView").mockReturnValue(
    update as unknown as ReturnType<typeof BoardViewsHooks.useUpdateBoardView>
  )
  vi.spyOn(BoardViewsHooks, "useDeleteBoardView").mockReturnValue(
    remove as unknown as ReturnType<typeof BoardViewsHooks.useDeleteBoardView>
  )

  vi.spyOn(InputMode, "useInputMode").mockReturnValue("mouse")
  vi.spyOn(ConversationsHooks, "useMuteStream").mockReturnValue({ mutate: vi.fn() } as never)
  vi.spyOn(ConversationsHooks, "useUnmuteStream").mockReturnValue({ mutate: vi.fn() } as never)
  vi.spyOn(WorkspaceStore, "useWorkspaceStreams").mockReturnValue([] as never)
  vi.spyOn(WorkspaceStore, "useWorkspaceUsers").mockReturnValue([] as never)
  vi.spyOn(WorkspaceStore, "useWorkspaceDmPeers").mockReturnValue([] as never)
  vi.spyOn(WorkspaceStore, "useWorkspaceLabels").mockReturnValue([] as never)
  vi.spyOn(BoardExclusions, "useBoardMutedStreamIds").mockReturnValue(new Set())

  return { updatePreferences, update, remove }
}

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>
}

function currentLoc(): string {
  return screen.getByTestId("loc").textContent ?? ""
}

function mountAt(path: string, props: Partial<Parameters<typeof BoardModeBlock>[0]> = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <BoardModeBlock workspaceId={WS} {...props} />
    </MemoryRouter>
  )
}

function hrefOf(name: RegExp | string): string {
  return screen.getByRole("link", { name }).getAttribute("href") ?? ""
}

beforeEach(() => {
  localStorage.clear()
  // Radix menus/popovers need these in jsdom (they aren't implemented there).
  Element.prototype.scrollIntoView ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
})
afterEach(() => vi.restoreAllMocks())

describe("BoardModeBlock", () => {
  it("renders the Lenses section and every lens", () => {
    stub()
    mountAt(`/w/${WS}/board`)

    expect(screen.getByText("Lenses")).toBeInTheDocument()
    for (const label of ["All", "Decisions", "Mine"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument()
    }
  })

  it("hides the Views section when the viewer has no saved views", () => {
    stub({ views: [] })
    mountAt(`/w/${WS}/board`)

    expect(screen.queryByText("Views")).not.toBeInTheDocument()
  })

  it("carries the current filters across every lens link", () => {
    stub()
    mountAt(`/w/${WS}/board?lens=mine&in=stream_1&label=label_a`)

    const all = new URL(hrefOf("All"), "http://x")
    expect(all.searchParams.get("lens")).toBe("all")
    expect(all.searchParams.get("in")).toBe("stream_1")
    expect(all.searchParams.get("label")).toBe("label_a")

    const decisions = new URL(hrefOf("Decisions"), "http://x")
    expect(decisions.pathname).toBe(`/w/${WS}/board`)
    expect(decisions.searchParams.get("lens")).toBe("decisions")
    expect(decisions.searchParams.get("in")).toBe("stream_1")
  })

  it("every lens link carries an explicit ?lens=, never the bare entry alias", () => {
    stub()
    mountAt(`/w/${WS}/board?lens=all`)

    const all = new URL(hrefOf("All"), "http://x")
    expect(all.pathname).toBe(`/w/${WS}/board`)
    expect(all.searchParams.get("lens")).toBe("all")
    const mine = new URL(hrefOf("Mine"), "http://x")
    expect(mine.searchParams.get("lens")).toBe("mine")
  })

  it("marks the current lens active", () => {
    stub()
    mountAt(`/w/${WS}/board?lens=mine`)

    expect(screen.getByRole("link", { name: "Mine" })).toHaveAttribute("aria-current", "true")
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
    expect(hrefOf("First")).toContain(`/w/${WS}/board?lens=mine`)
  })

  it("marks the matching saved view active and no lens active", () => {
    const v = view({ baseLens: "mine", scopeStreamIds: ["stream_1"] })
    stub({ views: [v] })
    mountAt(`/w/${WS}/board?lens=mine&in=stream_1`)

    expect(screen.getByRole("link", { name: /Design work/ })).toHaveAttribute("aria-current", "true")
    // The view is the selection, so the underlying Mine lens is NOT marked active.
    expect(screen.getByRole("link", { name: "Mine" })).not.toHaveAttribute("aria-current")
  })

  it("shows the board-home indicator on the pinned view", () => {
    const v = view()
    stub({ views: [v], homeView: v })
    mountAt(`/w/${WS}/board`)

    expect(screen.getByLabelText("Board home")).toBeInTheDocument()
  })

  it("renders per-lens counts from lensTotals, right-aligned inside each lens row", () => {
    stub()
    mountAt(`/w/${WS}/board`, {
      lensTotals: { all: 14, decisions: 3, mine: 0 },
    })

    const all = screen.getByRole("link", { name: "All" })
    expect(all).toHaveTextContent("14")
    // A real zero is a computed count — shown, not hidden.
    expect(screen.getByRole("link", { name: "Mine" })).toHaveTextContent("0")
  })

  it("renders no lens counts when lensTotals is null (stats not loaded)", () => {
    stub()
    mountAt(`/w/${WS}/board`, { lensTotals: null })

    expect(screen.getByRole("link", { name: "Decisions" })).toHaveTextContent(/^Decisions$/)
  })

  it("renders the Filters group with the stream and type pickers", () => {
    stub()
    mountAt(`/w/${WS}/board?lens=all`)

    expect(screen.getByText("Filters")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Filter the board by streams" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Filter the board by stream types" })).toBeInTheDocument()
  })

  it("opens the streams picker on click", async () => {
    const user = userEvent.setup()
    stub()
    mountAt(`/w/${WS}/board?lens=all`)

    await user.click(screen.getByRole("button", { name: "Filter the board by streams" }))
    expect(await screen.findByPlaceholderText("Find a stream")).toBeInTheDocument()
  })

  it("the Unread only toggle flips ?unread=true and back", async () => {
    const user = userEvent.setup()
    stub()
    mountAt(`/w/${WS}/board?lens=all`)

    await user.click(screen.getByRole("button", { name: "Unread only" }))
    expect(new URL(currentLoc(), "http://x").searchParams.get("unread")).toBe("true")

    await user.click(screen.getByRole("button", { name: "Unread only" }))
    expect(new URL(currentLoc(), "http://x").searchParams.get("unread")).toBeNull()
  })

  it("the Archived toggle flips ?archived=true", async () => {
    const user = userEvent.setup()
    stub()
    mountAt(`/w/${WS}/board?lens=all`)

    await user.click(screen.getByRole("button", { name: "Archived" }))
    expect(new URL(currentLoc(), "http://x").searchParams.get("archived")).toBe("true")
  })

  it("pinning a lens writes the home-lens preference and clears any view home", async () => {
    const user = userEvent.setup()
    const { updatePreferences } = stub({ boardDefaultLens: "all" })
    mountAt(`/w/${WS}/board?lens=all`)

    await user.click(screen.getByRole("button", { name: "Set Mine as board home" }))
    expect(updatePreferences).toHaveBeenCalledWith({ boardDefaultLens: "mine", boardDefaultViewId: null })
  })

  it("pinning a saved view writes the home-view preference", async () => {
    const user = userEvent.setup()
    const { updatePreferences } = stub({ views: [view()], boardDefaultLens: "all" })
    mountAt(`/w/${WS}/board`)

    await user.click(screen.getByRole("button", { name: "Actions for Design work" }))
    await user.click(await screen.findByRole("menuitem", { name: /Set as board home/ }))
    expect(updatePreferences).toHaveBeenCalledWith({ boardDefaultViewId: "boardview_1" })
  })

  it("renaming a saved view fires the update mutation with the new name", async () => {
    const user = userEvent.setup()
    const { update } = stub({ views: [view()], boardDefaultLens: "all" })
    mountAt(`/w/${WS}/board`)

    await user.click(screen.getByRole("button", { name: "Actions for Design work" }))
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }))
    const input = await screen.findByPlaceholderText("View name")
    await user.clear(input)
    await user.type(input, "Renamed")
    await user.click(screen.getByRole("button", { name: "Rename" }))

    expect(update.mutate).toHaveBeenCalledWith({ id: "boardview_1", input: { name: "Renamed" } })
  })

  it("deleting a saved view fires the delete mutation", async () => {
    const user = userEvent.setup()
    const { remove } = stub({ views: [view()], boardDefaultLens: "all" })
    mountAt(`/w/${WS}/board`)

    await user.click(screen.getByRole("button", { name: "Actions for Design work" }))
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }))

    expect(remove.mutate).toHaveBeenCalledWith("boardview_1")
  })
})
