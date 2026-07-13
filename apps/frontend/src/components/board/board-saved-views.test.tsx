import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardView } from "@threa/types"
import { ServicesProvider } from "@/contexts"
import { BoardSavedViews, savedViewHref, isViewActive, type BoardViewSelection } from "./board-saved-views"

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

function mount(boardViews: Record<string, unknown>, props: Partial<Parameters<typeof BoardSavedViews>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ServicesProvider services={{ boardViews } as never}>
        <MemoryRouter>
          <BoardSavedViews
            workspaceId="ws_1"
            lens="mine"
            activeViewId={null}
            scopeStreamIds={["stream_1"]}
            scopeStreamTypes={[]}
            scopeLabelIds={[]}
            excludeStreamIds={[]}
            excludeStreamTypes={[]}
            excludeLabelIds={[]}
            onNavigate={() => {}}
            {...props}
          />
        </MemoryRouter>
      </ServicesProvider>
    </QueryClientProvider>
  )
}

afterEach(() => vi.restoreAllMocks())

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

describe("BoardSavedViews", () => {
  const base = {
    list: vi.fn(async () => [view()]),
    create: vi.fn(async () => view()),
    update: vi.fn(async () => view()),
    remove: vi.fn(async () => undefined),
  }

  it("lists saved views linking to their expanded URL", async () => {
    mount({ ...base })
    const link = await screen.findByRole("link", { name: /Design work/ })
    expect(link.getAttribute("href")).toContain("/w/ws_1/board?lens=mine")
  })

  it("saves the current filter state as a named view", async () => {
    const user = userEvent.setup()
    const create = vi.fn(async () => view())
    mount({ ...base, list: vi.fn(async () => []), create })

    await user.click(await screen.findByText("Save current view"))
    await user.type(await screen.findByPlaceholderText("View name"), "Design work")
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(create).toHaveBeenCalledWith("ws_1", {
      name: "Design work",
      baseLens: "mine",
      scopeStreamIds: ["stream_1"],
      scopeStreamTypes: [],
      scopeLabelIds: [],
      excludeStreamIds: [],
      excludeStreamTypes: [],
      excludeLabelIds: [],
    })
  })

  it("deletes a saved view", async () => {
    const user = userEvent.setup()
    const remove = vi.fn(async () => undefined)
    mount({ ...base, remove })

    await user.click(await screen.findByRole("button", { name: "Delete Design work" }))
    expect(remove).toHaveBeenCalledWith("ws_1", "boardview_1")
  })
})
