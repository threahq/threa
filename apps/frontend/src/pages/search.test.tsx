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
import * as hooksModule from "@/hooks"
import * as mentionablesModule from "@/hooks/use-mentionables"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as contextsModule from "@/contexts"
import { SearchPage } from "./search"
import type { ConversationSearchResult, MemoExplorerResult } from "@/api"

const search = vi.fn()
const clear = vi.fn()
const mockUseMemoSearch = vi.fn()
let mockConversations: ConversationSearchResult[] = []

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
}

function renderPage(initialEntry = "/w/workspace_1/search?q=hello") {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
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

function buildMemoResult(overrides: Partial<MemoExplorerResult["memo"]> = {}): MemoExplorerResult {
  return {
    memo: {
      id: "memo_1",
      workspaceId: "workspace_1",
      memoType: "message",
      sourceMessageId: "msg_1",
      sourceConversationId: null,
      title: "Launch decision",
      abstract: "Approved launch plan",
      keyPoints: [],
      sourceMessageIds: ["msg_1"],
      participantIds: ["user_1"],
      knowledgeType: "decision",
      tags: [],
      parentMemoId: null,
      status: "active",
      version: 1,
      revisionReason: null,
      authoredByKind: "pipeline",
      sourceSessionId: null,
      scope: "workspace",
      scopeUserId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      ...overrides,
    },
    distance: 0,
    sourceStream: null,
    rootStream: null,
  }
}

function buildConversationResult(overrides: Partial<ConversationSearchResult> = {}): ConversationSearchResult {
  return {
    id: "conv_1",
    streamId: "stream_channel1",
    topicSummary: "Choosing the launch date",
    summary: "The team weighed a May launch against waiting for the mobile build.",
    status: "resolved",
    messageCount: 7,
    participantIds: ["user_1"],
    firstMessageId: "msg_first",
    firstMessageAt: "2026-01-01T00:00:00.000Z",
    lastMessageAt: "2026-01-02T00:00:00.000Z",
    distance: 0.3,
    ...overrides,
  }
}

describe("SearchPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    search.mockReset()
    clear.mockReset()
    mockConversations = []
    mockUseMemoSearch.mockReset()
    mockUseMemoSearch.mockReturnValue({ data: { results: [] }, isLoading: false, error: null })
    vi.spyOn(hooksModule, "useMemoSearch").mockImplementation(
      (...args) => mockUseMemoSearch(...args) as ReturnType<typeof hooksModule.useMemoSearch>
    )
    vi.spyOn(hooksModule, "useSearch").mockImplementation(
      () =>
        ({
          results: [mockSearchResultsList[1]!, mockSearchResultsList[0]!],
          conversations: mockConversations,
          isLoading: false,
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

    expect(
      Array.from(document.querySelectorAll("[data-search-result-id]"), (row) =>
        row.getAttribute("data-search-result-id")
      )
    ).toEqual(["msg_2", "msg_1"])
    expect(localStorage.getItem("threa-search-result-display:workspace_1")).toBe("ranked")

    await user.click(screen.getByText(/from the search results/))
    expect(screen.getByTestId("location")).toHaveTextContent("/w/workspace_1/s/stream_channel1?m=msg_1")
  })

  it("uses the persisted workspace-specific display mode", async () => {
    localStorage.setItem("threa-search-result-display:workspace_1", "ranked")
    localStorage.setItem("threa-search-result-display:workspace_2", "grouped")
    renderPage()

    await waitFor(() => expect(document.querySelector("section")).toBeNull())
    expect(screen.getByRole("radio", { name: "Ranked results" })).toHaveAttribute("data-state", "on")
  })

  it("keeps the as-you-type debounce free of a deep search", async () => {
    renderPage()

    await waitFor(() => {
      expect(search).toHaveBeenLastCalledWith("hello", expect.any(Object))
    })
    expect(search.mock.calls.filter((call) => call[3]?.deep)).toEqual([])
  })

  it("runs a deep search on Enter without waiting for the debounce", async () => {
    const user = userEvent.setup()
    renderPage()

    const input = screen.getByLabelText("Search messages")
    await user.click(input)
    await user.keyboard("{Enter}")

    expect(search).toHaveBeenLastCalledWith("hello", expect.any(Object), undefined, { deep: true })
  })

  it("runs a deep search from the Search deeper button", async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole("button", { name: /search deeper/i }))

    expect(search).toHaveBeenLastCalledWith("hello", expect.any(Object), undefined, { deep: true })
  })

  it("keeps the Search deeper button in place, disabled, while the deep search runs", async () => {
    search.mockImplementation(async () => {
      vi.spyOn(hooksModule, "useSearch").mockReturnValue({
        results: [mockSearchResultsList[1]!, mockSearchResultsList[0]!],
        isLoading: true,
        error: null,
        search,
        clear,
      } as unknown as ReturnType<typeof hooksModule.useSearch>)
    })
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole("button", { name: /search deeper/i }))

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /search deeper/i })).toBeDisabled()
    })
    expect(screen.getByRole("radio", { name: "Ranked results" })).toBeInTheDocument()
  })

  describe("memo matches", () => {
    it("renders a Memories section with a memo card and a See all link", async () => {
      mockUseMemoSearch.mockReturnValue({ data: { results: [buildMemoResult()] }, isLoading: false, error: null })
      renderPage()

      expect(await screen.findByText("Memories")).toBeInTheDocument()

      const card = screen.getByText("Launch decision").closest("a")
      expect(card).toHaveAttribute("href", "/w/workspace_1/memory?q=hello&memo=memo_1")

      const seeAll = screen.getByRole("link", { name: "See all" })
      expect(seeAll).toHaveAttribute("href", "/w/workspace_1/memory?q=hello")
    })

    it("counts a memo-only match as a result instead of showing the empty state", async () => {
      mockUseMemoSearch.mockReturnValue({ data: { results: [buildMemoResult()] }, isLoading: false, error: null })
      vi.spyOn(hooksModule, "useSearch").mockImplementation(
        () =>
          ({ results: [], isLoading: false, error: null, search, clear }) as unknown as ReturnType<
            typeof hooksModule.useSearch
          >
      )
      renderPage()

      expect(await screen.findByText("Memories")).toBeInTheDocument()
      expect(screen.getByText("1 result")).toBeInTheDocument()
      expect(screen.queryByText("No messages found")).not.toBeInTheDocument()
    })

    it("is absent when the memo response is empty", async () => {
      mockUseMemoSearch.mockReturnValue({ data: { results: [] }, isLoading: false, error: null })
      renderPage()

      expect(await screen.findByText("#general")).toBeInTheDocument()
      expect(screen.queryByText("Memories")).not.toBeInTheDocument()
    })

    it("is absent, and skips the memo request, when the query carries from:@someone", async () => {
      mockUseMemoSearch.mockReturnValue({ data: { results: [buildMemoResult()] }, isLoading: false, error: null })
      renderPage("/w/workspace_1/search?q=from%3A%40martin%20hello")

      await waitFor(() => expect(mockUseMemoSearch).toHaveBeenCalled())
      expect(screen.queryByText("Memories")).not.toBeInTheDocument()
      const lastCall = mockUseMemoSearch.mock.calls.at(-1)
      expect(lastCall?.[2]).toEqual({ enabled: false })
    })
  })

  describe("conversation matches", () => {
    it("renders a Conversations section whose card deep-links to the first message", async () => {
      mockConversations = [buildConversationResult()]
      renderPage()

      expect(await screen.findByText("Conversations")).toBeInTheDocument()

      const card = screen.getByText("Choosing the launch date").closest("a")
      expect(card).toHaveAttribute("href", "/w/workspace_1/s/stream_channel1?m=msg_first")
      expect(card).toHaveTextContent("The team weighed a May launch")
      expect(card).toHaveTextContent("7 messages")
      expect(card).toHaveTextContent("#general")
    })

    it("falls back to the summary as the title when there is no topic", async () => {
      mockConversations = [buildConversationResult({ topicSummary: null, messageCount: 1 })]
      renderPage()

      const card = (await screen.findByText(/weighed a May launch/)).closest("a")
      expect(card).toHaveTextContent("1 message")
    })

    it("is absent when the response carries no conversations", async () => {
      renderPage()

      expect(await screen.findByText("#general")).toBeInTheDocument()
      expect(screen.queryByText("Conversations")).not.toBeInTheDocument()
    })
  })
})
