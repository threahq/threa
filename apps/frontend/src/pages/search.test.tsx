import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SidebarProvider } from "@/contexts/sidebar-context"
import { SearchPanelProvider } from "@/components/search/search-panel-context"
import { TooltipProvider } from "@/components/ui/tooltip"
import { mockSearchResultsList } from "@/test/fixtures/messages"
import { mockStreamsList } from "@/test/fixtures"
import { mockUsersList } from "@/test/fixtures/users"
import {
  createMockClusterConversation,
  createMockMemoResult,
  createMockSearchCluster,
  strayClusters,
} from "@/test/fixtures/search"
import * as hooksModule from "@/hooks"
import * as mentionablesModule from "@/hooks/use-mentionables"
import * as mobileModule from "@/hooks/use-mobile"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as contextsModule from "@/contexts"
import { SearchPage } from "./search"
import type { MemoExplorerResult, SearchCluster, SearchResultItem, SearchRefineOutcome } from "@/api"
import * as apiModule from "@/api"
import type { WorkspaceBootstrap } from "@/api"
import type { FeatureFlagLayers } from "@threahq/types"
import { MAX_SEARCH_REFINE_CHARS } from "@threahq/types"
import { workspaceKeys } from "@/hooks/use-workspaces"

const search = vi.fn()
const clear = vi.fn()
const mockSearchState = {
  results: [] as SearchResultItem[],
  /** Defaults to one single-message row per result. */
  clusters: null as SearchCluster[] | null,
  memos: [] as MemoExplorerResult[],
  queryLogId: null as string | null,
  refine: null as SearchRefineOutcome | null,
  isLoading: false,
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
}

/** `featureFlags` seeds the bootstrap cache the `search` flag is read from; absent, every flag is at its default. */
function renderPage(initialEntry = "/w/workspace_1/search?q=hello", featureFlags?: FeatureFlagLayers) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (featureFlags) {
    queryClient.setQueryData(workspaceKeys.bootstrap("workspace_1"), { featureFlags } as WorkspaceBootstrap)
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <SidebarProvider>
            <SearchPanelProvider workspaceId="workspace_1">
              <Routes>
                <Route path="/w/:workspaceId/search" element={<SearchPage />} />
              </Routes>
              <LocationProbe />
            </SearchPanelProvider>
          </SidebarProvider>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

function launchCluster(hits: SearchResultItem[] = [mockSearchResultsList[0]!]): SearchCluster {
  return createMockSearchCluster({ conversation: createMockClusterConversation(), hits })
}

function resultIds(): (string | null)[] {
  return Array.from(document.querySelectorAll("[data-search-result-id]"), (row) =>
    row.getAttribute("data-search-result-id")
  )
}

describe("SearchPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    search.mockReset()
    clear.mockReset()
    mockSearchState.results = [mockSearchResultsList[1]!, mockSearchResultsList[0]!]
    mockSearchState.clusters = null
    mockSearchState.memos = []
    mockSearchState.queryLogId = null
    mockSearchState.refine = null
    mockSearchState.isLoading = false
    vi.spyOn(hooksModule, "useSearch").mockImplementation(
      () =>
        ({
          results: mockSearchState.results,
          clusters: mockSearchState.clusters ?? strayClusters(mockSearchState.results),
          memos: mockSearchState.memos,
          queryLogId: mockSearchState.queryLogId,
          refine: mockSearchState.refine,
          isLoading: mockSearchState.isLoading,
          error: null,
          search,
          clear,
        }) as unknown as ReturnType<typeof hooksModule.useSearch>
    )
    vi.spyOn(mentionablesModule, "useMentionables").mockReturnValue({
      mentionables: [],
      isLoading: false,
    } as unknown as ReturnType<typeof mentionablesModule.useMentionables>)
    vi.spyOn(mentionablesModule, "filterMentionables").mockImplementation((items) => items)
    vi.spyOn(mentionablesModule, "filterSearchMentionables").mockImplementation((items) => items)
    vi.spyOn(mentionablesModule, "filterUsersOnly").mockImplementation((items) => items)
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue(
      mockStreamsList as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>
    )
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue(
      mockUsersList as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>
    )
    vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockReturnValue([])
    vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([])
    vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([])
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: null,
    } as unknown as ReturnType<typeof contextsModule.usePreferences>)
    vi.spyOn(contextsModule, "useStreamService").mockReturnValue({ get: vi.fn() } as never)
  })

  it("shares ranked mode, API order, Link navigation, and touch-sized controls with the sidebar", async () => {
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText("#general")).toBeInTheDocument()
    const ranked = screen.getByRole("radio", { name: "Ranked results" })
    expect(ranked).toHaveClass("h-9")
    await user.click(ranked)

    expect(resultIds()).toEqual(["msg_2", "msg_1"])
    expect(localStorage.getItem("threa-search-result-display:workspace_1")).toBe("ranked")

    await user.click(screen.getByText(/from the search results/))
    expect(screen.getByTestId("location")).toHaveTextContent("/w/workspace_1/s/stream_channel1?m=msg_1")
  })

  it("uses the persisted workspace-specific display mode", async () => {
    localStorage.setItem("threa-search-result-display:workspace_1", "ranked")
    localStorage.setItem("threa-search-result-display:workspace_2", "clusters")
    renderPage()

    expect(await screen.findByText("#general")).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "Ranked results" })).toHaveAttribute("data-state", "on")
    expect(screen.getByRole("radio", { name: "Grouped results" })).toHaveAttribute("data-state", "off")
  })

  it("keeps the same rows and count when switching between grouped and ranked", async () => {
    mockSearchState.clusters = [launchCluster(), createMockSearchCluster({ hits: [mockSearchResultsList[1]!] })]
    const user = userEvent.setup()
    renderPage()

    await screen.findByText("Choosing the launch date")
    expect(document.querySelectorAll("[data-search-group]")).toHaveLength(2)
    expect(resultIds()).toEqual(["msg_1", "msg_2"])
    expect(screen.getByText("2 results")).toBeInTheDocument()

    await user.click(screen.getByRole("radio", { name: "Ranked results" }))

    expect(document.querySelectorAll("[data-search-group]")).toHaveLength(0)
    expect(screen.getByText("Choosing the launch date")).toBeInTheDocument()
    expect(resultIds()).toEqual(["msg_1", "msg_2"])
    expect(screen.getByText("2 results")).toBeInTheDocument()
  })

  it("searches as you type and leaves Enter to the result list", async () => {
    const user = userEvent.setup()
    renderPage()

    await waitFor(() => {
      expect(search).toHaveBeenLastCalledWith("hello", expect.any(Object))
    })
    const callsBeforeEnter = search.mock.calls.length

    await user.click(screen.getByLabelText("Search messages"))
    await user.keyboard("{Enter}")

    expect(search).toHaveBeenCalledTimes(callsBeforeEnter)
    expect(screen.getByTestId("location")).toHaveTextContent("/w/workspace_1/search?q=hello")
  })

  it("links to the memory explorer on the same words", async () => {
    renderPage("/w/workspace_1/search?q=from%3A%40martin%20launch%20plan")

    const link = await screen.findByRole("link", { name: "Search memory" })
    expect(link).toHaveAttribute("href", "/w/workspace_1/memory?q=launch%20plan")
  })

  describe("conversation rows", () => {
    it("nests the hits under a header that deep-links to the conversation start", async () => {
      mockSearchState.clusters = [launchCluster(), createMockSearchCluster({ hits: [mockSearchResultsList[1]!] })]
      renderPage()

      const header = (await screen.findByText("Choosing the launch date")).closest("a")
      expect(header).toHaveAttribute("href", "/w/workspace_1/s/stream_channel1?m=msg_first")
      expect(header).toHaveTextContent("7 messages")
      expect(header).toHaveTextContent("Martin")

      const group = document.querySelector('[data-search-group="stream_channel1"]')
      expect(group?.querySelector("[data-search-stream-label]")).toHaveTextContent("#general")
      const row = group?.querySelector('[data-search-cluster="conv_1"]')
      expect(row?.querySelector('[data-search-result-id="msg_1"]')).toBeInTheDocument()
      expect(resultIds()).toEqual(["msg_1", "msg_2"])
      expect(screen.getByText("2 results")).toBeInTheDocument()
    })

    it("falls back to the summary as the title and marks a topic match", async () => {
      mockSearchState.clusters = [
        createMockSearchCluster({
          conversation: createMockClusterConversation({ topicSummary: null, messageCount: 1 }),
          matchedVia: ["topic"],
          hits: [],
        }),
      ]
      renderPage()

      const header = (await screen.findByText(/weighed a May launch/)).closest("a")
      expect(header).toHaveTextContent("1 message")
      expect(screen.getByText("topic")).toBeInTheDocument()
      expect(screen.getByText("1 result")).toBeInTheDocument()
      expect(screen.queryByText("No results")).not.toBeInTheDocument()
    })

    it("shows three hits and expands the rest on demand", async () => {
      const hits = Array.from({ length: 5 }, (_, i) => ({
        ...mockSearchResultsList[0]!,
        id: `msg_${i + 1}`,
        content: `Hit number ${i + 1}`,
      }))
      mockSearchState.clusters = [launchCluster(hits)]
      const user = userEvent.setup()
      renderPage()

      await screen.findByText("Choosing the launch date")
      expect(resultIds()).toEqual(["msg_1", "msg_2", "msg_3"])

      await user.click(screen.getByRole("button", { name: "2 more in this conversation" }))
      expect(resultIds()).toEqual(["msg_1", "msg_2", "msg_3", "msg_4", "msg_5"])
      expect(screen.queryByRole("button", { name: /more in this conversation/ })).not.toBeInTheDocument()
    })

    it("gathers a memo hit as a chip after the group's rows, opening the memory explorer", async () => {
      mockSearchState.memos = [createMockMemoResult()]
      mockSearchState.clusters = [
        createMockSearchCluster({
          conversation: createMockClusterConversation(),
          matchedVia: ["memory"],
          hits: [mockSearchResultsList[0]!],
          memoIds: ["memo_1"],
        }),
      ]
      renderPage()

      const chip = (await screen.findByText("Launch decision")).closest("a")
      expect(chip).toHaveAttribute("href", "/w/workspace_1/memory?q=hello&memo=memo_1")
      const group = document.querySelector('[data-search-group="stream_channel1"]')
      expect(group).toContainElement(chip)
      expect(group!.querySelector('[data-search-cluster="conv_1"]')).not.toContainElement(chip)
      expect(resultIds()).toEqual(["msg_1"])
    })
  })

  describe("search query log", () => {
    it("attributes the opened message, conversation, or memo to the logged search", async () => {
      mockSearchState.queryLogId = "sqlog_1"
      mockSearchState.memos = [createMockMemoResult()]
      mockSearchState.clusters = [
        createMockSearchCluster({
          conversation: createMockClusterConversation(),
          matchedVia: ["message", "memory"],
          hits: [mockSearchResultsList[0]!],
          memoIds: ["memo_1"],
        }),
      ]
      const recordSearchClick = vi.spyOn(apiModule, "recordSearchClick").mockResolvedValue(undefined)
      const user = userEvent.setup()

      // Each open navigates off the page, so every kind gets its own mount.
      const opens: [() => Promise<HTMLElement>, apiModule.SearchClickTarget][] = [
        [() => screen.findByText(/from the search results/), { kind: "message", id: "msg_1" }],
        [() => screen.findByText("Choosing the launch date"), { kind: "conversation", id: "conv_1" }],
        [() => screen.findByText("Launch decision"), { kind: "memo", id: "memo_1" }],
      ]
      for (const [target, expected] of opens) {
        const { unmount } = renderPage()
        await user.click(await target())
        expect(recordSearchClick).toHaveBeenLastCalledWith("workspace_1", "sqlog_1", expected)
        unmount()
      }
      expect(recordSearchClick).toHaveBeenCalledTimes(opens.length)
    })

    it("records nothing when the search was not logged", async () => {
      const recordSearchClick = vi.spyOn(apiModule, "recordSearchClick").mockResolvedValue(undefined)
      const user = userEvent.setup()
      renderPage()

      await user.click(await screen.findByText(/from the search results/))
      expect(recordSearchClick).not.toHaveBeenCalled()
    })
  })

  describe("on a phone", () => {
    beforeEach(() => {
      vi.spyOn(mobileModule, "useIsMobile").mockReturnValue(true)
    })

    it("folds each conversation's hits behind a count until tapped", async () => {
      const user = userEvent.setup()
      mockSearchState.clusters = [launchCluster([mockSearchResultsList[0]!, mockSearchResultsList[1]!])]
      renderPage()

      const fold = await screen.findByRole("button", { name: "2 matches of 7" })
      expect(screen.getByText("Choosing the launch date")).toBeInTheDocument()
      expect(resultIds()).toEqual([])

      await user.click(fold)
      expect(resultIds()).toEqual(["msg_1", "msg_2"])
      expect(screen.queryByRole("button", { name: /matches of/ })).not.toBeInTheDocument()
    })

    it("still folds them behind a count in ranked mode", async () => {
      const user = userEvent.setup()
      mockSearchState.clusters = [launchCluster([mockSearchResultsList[0]!, mockSearchResultsList[1]!])]
      renderPage()

      await screen.findByRole("button", { name: "2 matches of 7" })
      await user.click(screen.getByRole("radio", { name: "Ranked results" }))

      expect(resultIds()).toEqual([])
      await user.click(screen.getByRole("button", { name: "2 matches of 7" }))
      expect(resultIds()).toEqual(["msg_1", "msg_2"])
    })
  })

  it("keeps a conversation's hits visible on wider screens", async () => {
    mockSearchState.clusters = [launchCluster([mockSearchResultsList[0]!, mockSearchResultsList[1]!])]
    renderPage()

    expect(await screen.findByText("Choosing the launch date")).toBeInTheDocument()
    expect(resultIds()).toEqual(["msg_1", "msg_2"])
    expect(screen.queryByRole("button", { name: /matches of/ })).not.toBeInTheDocument()
  })

  it("shows the empty state when nothing matched", async () => {
    mockSearchState.results = []
    renderPage()

    expect(await screen.findByText("No results")).toBeInTheDocument()
    expect(screen.queryByRole("radio", { name: "Ranked results" })).toBeInTheDocument()
  })

  describe("refine", () => {
    const searchOn: FeatureFlagLayers = { workspace: { search: "on" }, user: {} }

    function refinePill() {
      return screen.getByRole("button", { name: "Refine" })
    }

    async function commitRefine(user: ReturnType<typeof userEvent.setup>, text: string) {
      await user.click(refinePill())
      await user.type(await screen.findByLabelText("Refinement"), text)
      await user.keyboard("{Enter}")
    }

    it("offers the pill only with a query", () => {
      const empty = renderPage("/w/workspace_1/search", searchOn)
      expect(screen.queryByRole("button", { name: "Refine" })).not.toBeInTheDocument()
      empty.unmount()

      renderPage(undefined, searchOn)
      expect(refinePill()).toBeInTheDocument()
    })

    it("offers neither the pill nor the old hint under the pre-rework search flag", () => {
      renderPage()

      expect(screen.queryByRole("button", { name: "Refine" })).not.toBeInTheDocument()
      expect(screen.queryByText(/Refine the list in plain words/)).not.toBeInTheDocument()
    })

    it("commits the row's prose to the URL and drops it when the chip is removed", async () => {
      const user = userEvent.setup()
      renderPage(undefined, searchOn)

      await waitFor(() => {
        expect(search).toHaveBeenLastCalledWith("hello", expect.any(Object))
      })

      await user.click(refinePill())
      const field = await screen.findByLabelText("Refinement")
      expect(field).toHaveFocus()
      expect(screen.getByRole("button", { name: "Apply refinement" })).toBeDisabled()

      await user.type(field, "only decisions")
      await user.click(screen.getByRole("button", { name: "Apply refinement" }))

      expect(screen.queryByLabelText("Refinement")).not.toBeInTheDocument()
      expect(screen.getByTestId("location")).toHaveTextContent("/w/workspace_1/search?q=hello&refine=only+decisions")
      expect(document.querySelector('[data-search-refine="only decisions"]')).toBeInTheDocument()
      // The query itself never carried the prose
      await waitFor(() => {
        expect(search.mock.calls.filter((call) => call[3] !== undefined)).toEqual([
          ["hello", expect.any(Object), [], ["only decisions"]],
        ])
      })

      await user.click(screen.getByRole("button", { name: "Remove refinement only decisions" }))
      expect(screen.getByTestId("location")).toHaveTextContent("/w/workspace_1/search?q=hello")
      await waitFor(() => {
        expect(search).toHaveBeenLastCalledWith("hello", expect.any(Object))
      })
    })

    it("commits on Enter and closes the row on Escape without a chip", async () => {
      const user = userEvent.setup()
      renderPage(undefined, searchOn)

      await user.click(refinePill())
      await user.type(await screen.findByLabelText("Refinement"), "only decisions")
      await user.keyboard("{Escape}")

      expect(screen.queryByLabelText("Refinement")).not.toBeInTheDocument()
      expect(document.querySelector("[data-search-refine]")).not.toBeInTheDocument()
      expect(refinePill()).toHaveFocus()

      await commitRefine(user, "only decisions")

      expect(screen.getByTestId("location")).toHaveTextContent("/w/workspace_1/search?q=hello&refine=only+decisions")
    })

    it("keeps the row open with the validation line when the prose is over the cap", async () => {
      const user = userEvent.setup()
      renderPage(undefined, searchOn)

      await user.click(refinePill())
      const field = await screen.findByLabelText("Refinement")
      await user.paste("x".repeat(MAX_SEARCH_REFINE_CHARS + 1))

      expect(
        await screen.findByText(`A refinement is at most ${MAX_SEARCH_REFINE_CHARS} characters.`)
      ).toBeInTheDocument()

      await user.keyboard("{Enter}")

      expect(field).toBeInTheDocument()
      expect(screen.getByTestId("location")).toHaveTextContent("/w/workspace_1/search?q=hello")
      expect(document.querySelector("[data-search-refine]")).not.toBeInTheDocument()
    })

    it("reopens the row prefilled from a chip and replaces that refine in the URL", async () => {
      const user = userEvent.setup()
      renderPage("/w/workspace_1/search?q=hello&refine=only+decisions&refine=newest+first", searchOn)

      await user.click(screen.getByRole("button", { name: "only decisions" }))
      const field = await screen.findByLabelText("Refinement")
      expect(field).toHaveValue("only decisions")

      await user.clear(field)
      await user.type(field, "only launch decisions")
      await user.keyboard("{Enter}")

      expect(screen.getByTestId("location")).toHaveTextContent(
        "/w/workspace_1/search?q=hello&refine=only+launch+decisions&refine=newest+first"
      )
      await waitFor(() => {
        expect(search).toHaveBeenLastCalledWith(
          "hello",
          expect.any(Object),
          [],
          ["only launch decisions", "newest first"]
        )
      })
    })

    it("restores the refine trail from the URL and shows the outcome", async () => {
      mockSearchState.refine = { applied: true, note: "Dropped the billing thread." }
      renderPage("/w/workspace_1/search?q=hello&refine=only+decisions&refine=not+billing")

      expect(Array.from(document.querySelectorAll("[data-search-refine]"), (chip) => chip.textContent)).toEqual([
        "only decisions",
        "not billing",
      ])
      await waitFor(() => {
        expect(search).toHaveBeenLastCalledWith("hello", expect.any(Object), [], ["only decisions", "not billing"])
      })
      expect(await screen.findByText("Dropped the billing thread.")).toBeInTheDocument()
    })

    it("offers a manual retry once the refine failed, and reruns the same search", async () => {
      const user = userEvent.setup()
      mockSearchState.refine = { applied: false, note: null }
      renderPage("/w/workspace_1/search?q=hello&refine=only+decisions", searchOn)

      expect(
        await screen.findByText(/Couldn't apply the refinement after two tries\. Showing all results\./)
      ).toBeInTheDocument()
      expect(document.querySelector("[data-search-refine-failed]")).toBeInTheDocument()
      expect(document.querySelector('[data-search-refine="only decisions"]')).toHaveAttribute(
        "data-search-refine-state",
        "failed"
      )
      // The unrefined list is still the list on screen
      expect(screen.getByText("#general")).toBeInTheDocument()

      await waitFor(() => {
        expect(search).toHaveBeenLastCalledWith("hello", expect.any(Object), [], ["only decisions"])
      })
      const callsBeforeRetry = search.mock.calls.length

      await user.click(screen.getByRole("button", { name: "Retry" }))

      expect(search).toHaveBeenCalledTimes(callsBeforeRetry + 1)
      expect(search).toHaveBeenLastCalledWith("hello", expect.any(Object), [], ["only decisions"])
    })

    it("spins the newest chip and keeps the count while a refined search is in flight", async () => {
      mockSearchState.refine = { applied: true, note: "Kept the decisions." }
      mockSearchState.isLoading = true
      renderPage("/w/workspace_1/search?q=hello&refine=only+decisions", searchOn)

      expect(await screen.findByText("#general")).toBeInTheDocument()
      expect(document.querySelector('[data-search-refine="only decisions"]')).toHaveAttribute(
        "data-search-refine-state",
        "pending"
      )
      // Results stay on screen with their count, dimmed, behind the progress line
      expect(screen.getByText("2 results")).toBeInTheDocument()
      expect(screen.getByText("#general").closest(".opacity-60")).toBeInTheDocument()
      expect(await screen.findByTestId("stream-loading-indicator")).toBeInTheDocument()
      // A stale outcome line never sits under a search that is still running
      expect(screen.queryByText("Kept the decisions.")).not.toBeInTheDocument()
    })

    it("hides the count while the first search of a query is still loading", async () => {
      mockSearchState.results = []
      mockSearchState.clusters = []
      mockSearchState.isLoading = true
      renderPage("/w/workspace_1/search?q=hello", searchOn)

      await waitFor(() => expect(search).toHaveBeenCalled())
      expect(screen.queryByText("0 results")).not.toBeInTheDocument()
    })

    it("drops an over-long refine from a shared URL and searches with the rest", async () => {
      const tooLong = "x".repeat(MAX_SEARCH_REFINE_CHARS + 1)
      renderPage(`/w/workspace_1/search?q=hello&refine=${tooLong}&refine=ok`)

      expect(Array.from(document.querySelectorAll("[data-search-refine]"), (chip) => chip.textContent)).toEqual(["ok"])
      await waitFor(() => {
        expect(search).toHaveBeenLastCalledWith("hello", expect.any(Object), [], ["ok"])
      })
    })
  })
})
