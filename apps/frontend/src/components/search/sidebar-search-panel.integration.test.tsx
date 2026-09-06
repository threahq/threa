/**
 * Integration tests for the sidebar search panel — the desktop search surface.
 */
import type React from "react"
import { useState } from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Router } from "react-router-dom"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SidebarProvider } from "@/contexts/sidebar-context"
import { SearchPanelProvider, useSearchPanel } from "./search-panel-context"
import { SidebarSearchPanel } from "./sidebar-search-panel"
import { mockStreamsList } from "@/test/fixtures"
import { mockUsersList } from "@/test/fixtures/users"
import { mockSearchResultsList } from "@/test/fixtures/messages"
import type { AuthorType, FeatureFlagLayers } from "@threahq/types"
import { MAX_SEARCH_REFINE_CHARS } from "@threahq/types"
import { workspaceKeys } from "@/hooks/use-workspaces"
import type { WorkspaceBootstrap } from "@/api"
import {
  createMockClusterConversation,
  createMockMemoResult,
  createMockSearchCluster,
  strayClusters,
} from "@/test/fixtures/search"
import { ApiError } from "@/api"
import type { MemoExplorerResult, SearchCluster, SearchRefineOutcome } from "@/api"
import * as apiModule from "@/api"
import * as hooksModule from "@/hooks"
import * as mentionablesModule from "@/hooks/use-mentionables"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as contextsModule from "@/contexts"
import * as sonnerModule from "sonner"

const mockNavigate = vi.fn()
let workspaceStreams = mockStreamsList

type MockSearchResult = Omit<(typeof mockSearchResultsList)[number], "authorType"> & { authorType: AuthorType }

const mockSearchState = {
  results: [] as MockSearchResult[],
  /** Defaults to one single-message row per result. */
  clusters: null as SearchCluster[] | null,
  memos: [] as MemoExplorerResult[],
  queryLogId: null as string | null,
  refine: null as SearchRefineOutcome | null,
  isLoading: false,
  search: vi.fn(),
  clear: vi.fn(),
}

function launchCluster(hits: MockSearchResult[] = [mockSearchResultsList[0]!]): SearchCluster {
  return createMockSearchCluster({ conversation: createMockClusterConversation(), hits })
}

function resultIds(): (string | null)[] {
  return Array.from(document.querySelectorAll("[data-search-result-id]"), (row) =>
    row.getAttribute("data-search-result-id")
  )
}

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
}

function toPathString(to: { pathname: string; search?: string; hash?: string }): string {
  return `${to.pathname}${to.search ?? ""}${to.hash ?? ""}`
}

function RouterWrapper({ children }: { children: React.ReactNode }) {
  const [location] = useState(() => ({
    pathname: "/",
    search: "",
    hash: "",
    state: null,
    key: "default",
  }))
  const navigator = {
    createHref: (to: unknown) => {
      if (typeof to === "string") return to
      return toPathString(to as { pathname: string; search?: string; hash?: string })
    },
    encodeLocation: (to: unknown) => {
      if (typeof to === "string") return { pathname: to, search: "", hash: "" }
      return to as { pathname: string; search: string; hash: string }
    },
    push: (to: unknown) => {
      const path =
        typeof to === "string" ? to : toPathString(to as { pathname: string; search?: string; hash?: string })
      mockNavigate(path)
    },
    replace: (to: unknown) => {
      const path =
        typeof to === "string" ? to : toPathString(to as { pathname: string; search?: string; hash?: string })
      mockNavigate(path, { replace: true })
    },
    go: () => {},
    listen: () => () => {},
    block: () => () => {},
  }
  return (
    <Router
      location={location}
      navigator={navigator as unknown as Parameters<typeof Router>[0]["navigator"]}
      navigationType={"POP" as Parameters<typeof Router>[0]["navigationType"]}
    >
      {children}
    </Router>
  )
}

/** Exposes provider state so tests can assert open/close transitions. */
function SearchPanelProbe() {
  const { isOpen, query, openSearch } = useSearchPanel()
  return (
    <>
      <div data-testid="search-panel-probe" data-open={String(isOpen)} data-query={query} />
      {/* Stands in for the global mod+shift+f handler, which calls openSearch() */}
      <button onClick={() => openSearch()}>Trigger open search</button>
    </>
  )
}

/** Opens the panel on mount so `closeSearch` transitions are observable. */
function OpenOnMount({ children }: { children: React.ReactNode }) {
  const { openSearch } = useSearchPanel()
  const [opened, setOpened] = useState(false)
  if (!opened) {
    setOpened(true)
    openSearch()
  }
  return <>{children}</>
}

/** `featureFlags` seeds the bootstrap cache the `search` flag is read from; absent, every flag is at its default. */
function renderPanel(featureFlags?: FeatureFlagLayers) {
  const queryClient = createTestQueryClient()
  if (featureFlags) {
    queryClient.setQueryData(workspaceKeys.bootstrap("workspace_1"), { featureFlags } as WorkspaceBootstrap)
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterWrapper>
          <SidebarProvider>
            <SearchPanelProvider workspaceId="workspace_1">
              <OpenOnMount>
                <SidebarSearchPanel workspaceId="workspace_1" />
                <SearchPanelProbe />
              </OpenOnMount>
            </SearchPanelProvider>
          </SidebarProvider>
        </RouterWrapper>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

const mentionablesFilterFn = (items: unknown[], query: string) => {
  if (!query) return items
  const q = query.toLowerCase()
  return (items as { name: string; slug: string }[]).filter(
    (i) => i.slug.toLowerCase().includes(q) || i.name.toLowerCase().includes(q)
  )
}

function installSpies() {
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
        search: mockSearchState.search,
        clear: mockSearchState.clear,
      }) as unknown as ReturnType<typeof hooksModule.useSearch>
  )

  vi.spyOn(mentionablesModule, "useMentionables").mockReturnValue({
    mentionables: [
      { id: "user_1", slug: "martin", name: "Martin", type: "user" },
      { id: "user_2", slug: "kate", name: "Kate", type: "user" },
    ],
    isLoading: false,
  } as unknown as ReturnType<typeof mentionablesModule.useMentionables>)
  vi.spyOn(mentionablesModule, "filterMentionables").mockImplementation(
    mentionablesFilterFn as unknown as typeof mentionablesModule.filterMentionables
  )
  vi.spyOn(mentionablesModule, "filterSearchMentionables").mockImplementation(((items: unknown[], query: string) => {
    const filtered = (items as { type?: string }[]).filter((i) => i.type !== "broadcast")
    return mentionablesFilterFn(filtered, query)
  }) as unknown as typeof mentionablesModule.filterSearchMentionables)
  vi.spyOn(mentionablesModule, "filterUsersOnly").mockImplementation(((items: unknown[], query: string) => {
    const usersOnly = (items as { type?: string }[]).filter((i) => i.type === "user")
    return mentionablesFilterFn(usersOnly, query)
  }) as unknown as typeof mentionablesModule.filterUsersOnly)

  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockImplementation(
    () => workspaceStreams as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockImplementation(
    () => mockUsersList as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockImplementation(
    () => [] as ReturnType<typeof workspaceStoreModule.useWorkspacePersonas>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockImplementation(
    () => [] as ReturnType<typeof workspaceStoreModule.useWorkspaceBots>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockImplementation(
    () => [] as ReturnType<typeof workspaceStoreModule.useWorkspaceDmPeers>
  )

  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: null,
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  vi.spyOn(contextsModule, "useStreamService").mockReturnValue({
    get: vi.fn(),
  } as unknown as ReturnType<typeof contextsModule.useStreamService>)
  vi.spyOn(contextsModule, "useSavedService").mockReturnValue({
    create: vi.fn(),
  } as unknown as ReturnType<typeof contextsModule.useSavedService>)
}

describe("SidebarSearchPanel Integration Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockNavigate.mockReset()
    localStorage.clear()
    workspaceStreams = mockStreamsList
    mockSearchState.results = []
    mockSearchState.clusters = null
    mockSearchState.memos = []
    mockSearchState.queryLogId = null
    mockSearchState.refine = null
    mockSearchState.isLoading = false
    mockSearchState.search = vi.fn()
    mockSearchState.clear = vi.fn()
    installSpies()
  })

  describe("basic rendering", () => {
    it("renders the search input and the filter-syntax hint when empty", () => {
      renderPanel({ workspace: { search: "on" }, user: {} })

      expect(screen.getByLabelText("Search messages")).toBeInTheDocument()
      expect(screen.getByText(/from:@user/)).toBeInTheDocument()
    })

    it("closes the panel from the back button", async () => {
      const user = userEvent.setup()
      renderPanel()

      expect(screen.getByTestId("search-panel-probe")).toHaveAttribute("data-open", "true")

      await user.click(screen.getByRole("button", { name: /back to streams/i }))

      expect(screen.getByTestId("search-panel-probe")).toHaveAttribute("data-open", "false")
    })

    it("refocuses the search input when openSearch fires while the panel is already open", async () => {
      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      expect(editor).toHaveFocus()

      // Focus wanders elsewhere (the user tabbed out, clicked another control...)
      const trigger = screen.getByRole("button", { name: /trigger open search/i })
      trigger.focus()
      expect(editor).not.toHaveFocus()

      // mod+shift+f calls openSearch() again — the input regains focus
      await user.click(trigger)

      expect(screen.getByTestId("search-panel-probe")).toHaveAttribute("data-open", "true")
      // TipTap defers focus to the next animation frame
      await waitFor(() => expect(editor).toHaveFocus())
    })

    it("closes the panel with Escape when no popover is open", async () => {
      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.keyboard("{Escape}")

      expect(screen.getByTestId("search-panel-probe")).toHaveAttribute("data-open", "false")
    })
  })

  describe("results", () => {
    it("renders one row per hit with its stream and highlighted match terms", async () => {
      mockSearchState.results = mockSearchResultsList

      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      await waitFor(() => {
        expect(screen.getByText("#general")).toBeInTheDocument()
        expect(screen.getByText("#random")).toBeInTheDocument()
      })

      // The matched term renders inside a <mark>
      const marks = document.querySelectorAll("mark")
      const markTexts = Array.from(marks, (m) => m.textContent?.toLowerCase())
      expect(markTexts).toContain("hello")
    })

    it("defaults to grouped rows and persists ranked mode per workspace in API order", async () => {
      mockSearchState.results = [mockSearchResultsList[1]!, mockSearchResultsList[0]!]
      const user = userEvent.setup()
      const view = renderPanel()
      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      expect(await screen.findByText("#general")).toBeInTheDocument()
      expect(screen.getByRole("radio", { name: "Grouped results" })).toHaveAttribute("data-state", "on")
      await user.click(screen.getByRole("radio", { name: "Ranked results" }))

      expect(resultIds()).toEqual(["msg_2", "msg_1"])
      expect(document.querySelectorAll("[data-search-stream-label]")).toHaveLength(2)
      expect(localStorage.getItem("threa-search-result-display:workspace_1")).toBe("ranked")

      view.unmount()
      renderPanel()
      const persistedEditor = screen.getByLabelText("Search messages")
      await user.click(persistedEditor)
      await user.type(persistedEditor, "hello")
      expect(await screen.findByText("#general")).toBeInTheDocument()
      expect(screen.getByRole("radio", { name: "Ranked results" })).toHaveAttribute("data-state", "on")
    })

    it("shows archived stream metadata on ranked rows", async () => {
      workspaceStreams = [{ ...mockStreamsList[0]!, archivedAt: "2026-01-01T00:00:00Z" }]
      mockSearchState.results = [{ ...mockSearchResultsList[0]!, streamId: mockStreamsList[0]!.id }]
      localStorage.setItem("threa-search-result-display:workspace_1", "ranked")
      const user = userEvent.setup()
      renderPanel()
      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      expect(await screen.findByLabelText("Archived stream")).toBeInTheDocument()
      expect(document.querySelector(`[data-search-stream-label="${mockStreamsList[0]!.id}"]`)).toBeInTheDocument()
    })

    it("preserves phrase-only highlighting and snippet positioning", async () => {
      mockSearchState.results = [
        {
          ...mockSearchResultsList[0]!,
          content: `${"context ".repeat(8)}matched phrase at the end`,
        },
      ]

      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, '"matched phrase"')

      await waitFor(() => {
        expect(mockSearchState.search).toHaveBeenCalledWith("", { status: ["active", "archived"] }, ["matched phrase"])
      })
      expect(screen.getByText("matched phrase", { selector: "mark" })).toBeInTheDocument()
      expect(screen.getByText("…")).toBeInTheDocument()
    })

    it("does not send more than five quoted phrases", async () => {
      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, '"one" "two" "three" "four" "five" "six"')

      expect(screen.getByText("Search supports at most 5 quoted phrases.")).toBeInTheDocument()
      expect(mockSearchState.search).not.toHaveBeenCalled()
    })

    it("resolves bot authors through the canonical actor lookup", async () => {
      mockSearchState.results = [{ ...mockSearchResultsList[0]!, authorId: "bot_1", authorType: "bot" }]
      vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([
        { id: "bot_1", name: "Search Bot" },
      ] as ReturnType<typeof workspaceStoreModule.useWorkspaceBots>)

      const user = userEvent.setup()
      renderPanel()
      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      expect(await screen.findByText("Search Bot")).toBeInTheDocument()
    })

    it("marks a thread result archived when its root stream is archived", async () => {
      const root = { ...mockStreamsList[0]!, archivedAt: "2026-01-01T00:00:00Z" }
      const thread = { ...mockStreamsList[1]!, id: "stream_thread1", parentStreamId: root.id, rootStreamId: root.id }
      workspaceStreams = [root, thread]
      mockSearchState.results = [{ ...mockSearchResultsList[0]!, streamId: thread.id }]

      const user = userEvent.setup()
      renderPanel()
      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      expect(await screen.findByLabelText("Archived stream")).toBeInTheDocument()
    })

    it("marks a nested thread result archived when its cached root is archived but its parent is missing", async () => {
      const root = { ...mockStreamsList[0]!, archivedAt: "2026-01-01T00:00:00Z" }
      const nestedThread = {
        ...mockStreamsList[1]!,
        id: "stream_nested_thread",
        parentStreamId: "stream_missing_parent",
        rootStreamId: root.id,
      }
      workspaceStreams = [root, nestedThread]
      mockSearchState.results = [{ ...mockSearchResultsList[0]!, streamId: nestedThread.id }]

      const user = userEvent.setup()
      renderPanel()
      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      expect(await screen.findByLabelText("Archived stream")).toBeInTheDocument()
    })

    it("shows ranked loading metadata until a missing stream resolves once", async () => {
      localStorage.setItem("threa-search-result-display:workspace_1", "ranked")
      let resolveStream: (stream: (typeof mockStreamsList)[number]) => void
      const get = vi.fn(
        () =>
          new Promise<(typeof mockStreamsList)[number]>((resolve) => {
            resolveStream = resolve
          })
      )
      vi.spyOn(contextsModule, "useStreamService").mockReturnValue({
        get,
      } as unknown as ReturnType<typeof contextsModule.useStreamService>)
      mockSearchState.results = [{ ...mockSearchResultsList[0]!, streamId: "stream_missing" }]

      const user = userEvent.setup()
      renderPanel()
      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      expect(await screen.findByLabelText("Loading stream")).toBeInTheDocument()
      workspaceStreams = [...workspaceStreams]
      await user.type(editor, "!")
      expect(get).toHaveBeenCalledTimes(1)

      const recovered = { ...mockStreamsList[0]!, id: "stream_missing", displayName: "Recovered" }
      workspaceStreams = [recovered]
      resolveStream!(recovered)
      await waitFor(() => expect(screen.getByText("Recovered")).toBeInTheDocument())
      expect(get).toHaveBeenCalledTimes(1)
    })

    it("loads one missing stream request for multiple results from that stream", async () => {
      const missing = { ...mockStreamsList[0]!, id: "stream_missing" }
      const get = vi.fn().mockResolvedValue(missing)
      vi.spyOn(contextsModule, "useStreamService").mockReturnValue({
        get,
      } as unknown as ReturnType<typeof contextsModule.useStreamService>)
      mockSearchState.results = [
        { ...mockSearchResultsList[0]!, streamId: missing.id },
        { ...mockSearchResultsList[1]!, id: "msg_missing_2", streamId: missing.id },
      ]

      const user = userEvent.setup()
      renderPanel()
      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      await waitFor(() => expect(get).toHaveBeenCalledTimes(1))
      expect(get).toHaveBeenCalledWith("workspace_1", missing.id)
    })

    it("does not retry a terminal missing-stream failure after rerenders", async () => {
      const get = vi.fn().mockRejectedValue(new ApiError(404, "STREAM_NOT_FOUND", "Not found"))
      vi.spyOn(contextsModule, "useStreamService").mockReturnValue({
        get,
      } as unknown as ReturnType<typeof contextsModule.useStreamService>)
      mockSearchState.results = [{ ...mockSearchResultsList[0]!, streamId: "stream_missing" }]

      const user = userEvent.setup()
      renderPanel()
      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")
      await waitFor(() => expect(get).toHaveBeenCalledTimes(1))

      await waitFor(() => expect(screen.getByText("Unknown stream")).toBeInTheDocument())
      expect(get).toHaveBeenCalledTimes(1)
    })

    it("shows three hits per conversation and expands the rest on demand", async () => {
      const hits = Array.from({ length: 5 }, (_, i) => ({
        ...mockSearchResultsList[0]!,
        id: `msg_${i + 1}`,
        content: `Hit number ${i + 1}`,
      }))
      mockSearchState.results = hits
      mockSearchState.clusters = [launchCluster(hits)]

      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      await screen.findByText("Choosing the launch date")
      expect(resultIds()).toEqual(["msg_1", "msg_2", "msg_3"])
      expect(screen.getByText("5 results in 1 stream")).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: "2 more in this conversation" }))
      expect(resultIds()).toEqual(["msg_1", "msg_2", "msg_3", "msg_4", "msg_5"])
    })

    it("reveals a folded hit when keyboard navigation lands on it", async () => {
      const hits = Array.from({ length: 5 }, (_, i) => ({
        ...mockSearchResultsList[0]!,
        id: `msg_${i + 1}`,
        content: `Hit number ${i + 1}`,
      }))
      mockSearchState.results = hits
      mockSearchState.clusters = [launchCluster(hits)]

      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")
      await screen.findByText("Choosing the launch date")

      await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}")

      expect(resultIds()).toEqual(["msg_1", "msg_2", "msg_3", "msg_4", "msg_5"])
      expect(document.querySelector('[aria-current="true"]')).toHaveAttribute("data-search-result-id", "msg_4")
    })

    it("uses ranked result Links to navigate to the focused message", async () => {
      mockSearchState.results = mockSearchResultsList
      localStorage.setItem("threa-search-result-display:workspace_1", "ranked")

      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      await waitFor(() => {
        expect(screen.getByText(/from the search results/)).toBeInTheDocument()
      })

      await user.click(screen.getByText(/from the search results/))

      expect(mockNavigate).toHaveBeenCalledWith("/w/workspace_1/s/stream_channel1?m=msg_1")
      // The panel stays open — the main view previews the result while the
      // result list keeps the selection (VS Code-style)
      expect(screen.getByTestId("search-panel-probe")).toHaveAttribute("data-open", "true")
    })

    it("keeps API-order keyboard navigation after switching to ranked", async () => {
      mockSearchState.results = mockSearchResultsList

      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      await waitFor(() => {
        expect(screen.getByText(/from the search results/)).toBeInTheDocument()
      })
      await user.click(screen.getByRole("radio", { name: "Ranked results" }))
      await user.click(editor)

      await user.keyboard("{ArrowDown}{ArrowDown}")

      // Second API result is now active
      const activeRow = document.querySelector('[aria-current="true"]')
      expect(activeRow?.textContent).toContain("Another search result message")

      await user.keyboard("{Enter}")
      expect(mockNavigate).toHaveBeenCalledWith("/w/workspace_1/s/stream_channel2?m=msg_2")
    })

    it("attributes the opened result to the logged search, by click and by keyboard", async () => {
      mockSearchState.results = mockSearchResultsList
      mockSearchState.memos = [createMockMemoResult()]
      mockSearchState.clusters = [
        createMockSearchCluster({
          conversation: createMockClusterConversation(),
          matchedVia: ["message", "memory"],
          hits: [mockSearchResultsList[0]!],
          memoIds: ["memo_1"],
        }),
        createMockSearchCluster({ hits: [mockSearchResultsList[1]!] }),
      ]
      mockSearchState.queryLogId = "sqlog_1"
      const recordSearchClick = vi.spyOn(apiModule, "recordSearchClick").mockResolvedValue(undefined)

      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      await user.click(await screen.findByText(/from the search results/))
      expect(recordSearchClick).toHaveBeenLastCalledWith("workspace_1", "sqlog_1", { kind: "message", id: "msg_1" })

      await user.click(screen.getByText("Choosing the launch date"))
      expect(recordSearchClick).toHaveBeenLastCalledWith("workspace_1", "sqlog_1", {
        kind: "conversation",
        id: "conv_1",
      })

      await user.click(screen.getByText("Launch decision"))
      expect(recordSearchClick).toHaveBeenLastCalledWith("workspace_1", "sqlog_1", { kind: "memo", id: "memo_1" })

      await user.click(editor)
      await user.keyboard("{ArrowDown}{ArrowDown}{Enter}")
      expect(recordSearchClick).toHaveBeenLastCalledWith("workspace_1", "sqlog_1", { kind: "message", id: "msg_2" })
    })

    it("records nothing when the search was not logged", async () => {
      mockSearchState.results = mockSearchResultsList
      const recordSearchClick = vi.spyOn(apiModule, "recordSearchClick").mockResolvedValue(undefined)

      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      await user.click(await screen.findByText(/from the search results/))
      expect(recordSearchClick).not.toHaveBeenCalled()
    })

    it("calls the search API (debounced) as the query changes", async () => {
      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      await waitFor(() => {
        expect(mockSearchState.search).toHaveBeenCalled()
      })
      expect(mockSearchState.search).toHaveBeenCalledWith("hello", { status: ["active", "archived"] })
    })

    it("does nothing on Enter when there are no results", async () => {
      mockSearchState.results = []

      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      await waitFor(() => {
        expect(screen.getByText("No results")).toBeInTheDocument()
      })
      const callsBeforeEnter = mockSearchState.search.mock.calls.length

      await user.keyboard("{Enter}")

      expect(mockSearchState.search).toHaveBeenCalledTimes(callsBeforeEnter)
      expect(mockNavigate).not.toHaveBeenCalled()
    })
  })

  describe("conversation rows", () => {
    it("nests hits under a header that deep-links to the conversation start", async () => {
      mockSearchState.results = mockSearchResultsList
      mockSearchState.clusters = [launchCluster(), createMockSearchCluster({ hits: [mockSearchResultsList[1]!] })]

      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      const header = (await screen.findByText("Choosing the launch date")).closest("a")
      expect(header).toHaveAttribute("href", "/w/workspace_1/s/stream_channel1?m=msg_first")
      expect(header).toHaveTextContent("7 messages")
      expect(header).toHaveTextContent("Martin")
      const row = document.querySelector('[data-search-cluster="conv_1"]')
      expect(row?.querySelector('[data-search-result-id="msg_1"]')).toBeInTheDocument()
      expect(screen.getByText("2 results in 2 streams")).toBeInTheDocument()

      // Enter opens the active MESSAGE hit, never the conversation header
      await user.keyboard("{Enter}")
      expect(mockNavigate).toHaveBeenCalledWith("/w/workspace_1/s/stream_channel1?m=msg_1")
    })

    it("counts a topic-only conversation as a result instead of showing the empty state", async () => {
      mockSearchState.results = []
      mockSearchState.clusters = [
        createMockSearchCluster({ conversation: createMockClusterConversation(), matchedVia: ["topic"], hits: [] }),
      ]

      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      expect(await screen.findByText("Choosing the launch date")).toBeInTheDocument()
      expect(screen.getByText("topic")).toBeInTheDocument()
      expect(screen.getByText("1 result in 1 stream")).toBeInTheDocument()
      expect(screen.queryByText("No results")).not.toBeInTheDocument()
    })

    it("keeps a hit-less topic row on screen in ranked mode too", async () => {
      mockSearchState.results = []
      mockSearchState.clusters = [
        createMockSearchCluster({ conversation: createMockClusterConversation(), matchedVia: ["topic"], hits: [] }),
      ]
      localStorage.setItem("threa-search-result-display:workspace_1", "ranked")

      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      expect(await screen.findByText("Choosing the launch date")).toBeInTheDocument()
      expect(screen.getByText("1 result in 1 stream")).toBeInTheDocument()
      expect(screen.queryByText("No results")).not.toBeInTheDocument()
    })

    it("gathers a memo hit as a chip after the group's rows and links the memory explorer on the same words", async () => {
      mockSearchState.results = mockSearchResultsList
      mockSearchState.memos = [createMockMemoResult()]
      mockSearchState.clusters = [
        createMockSearchCluster({
          conversation: createMockClusterConversation(),
          matchedVia: ["memory"],
          hits: [mockSearchResultsList[0]!],
          memoIds: ["memo_1"],
        }),
      ]

      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      const chip = (await screen.findByText("Launch decision")).closest("a")
      expect(chip).toHaveAttribute("href", "/w/workspace_1/memory?q=hello&memo=memo_1")
      const group = document.querySelector('[data-search-group="stream_channel1"]')
      expect(group).toContainElement(chip)
      const row = group!.querySelector('[data-search-cluster="conv_1"]')
      expect(row).not.toContainElement(chip)
      expect(row!.compareDocumentPosition(chip!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(screen.getByRole("link", { name: "Search memory" })).toHaveAttribute(
        "href",
        "/w/workspace_1/memory?q=hello"
      )

      // Enter opens the active MESSAGE hit, never a memo
      await user.keyboard("{Enter}")
      expect(mockNavigate).toHaveBeenCalledWith("/w/workspace_1/s/stream_channel1?m=msg_1")
      expect(mockNavigate).not.toHaveBeenCalledWith(expect.stringContaining("/memory"))
    })

    it("hides the memory link for a filter-only query", async () => {
      mockSearchState.results = mockSearchResultsList

      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "from:@martin")

      expect(await screen.findByText("#general")).toBeInTheDocument()
      expect(screen.queryByRole("link", { name: "Search memory" })).not.toBeInTheDocument()
    })
  })

  describe("grouped view", () => {
    const secondGeneralHit = {
      ...mockSearchResultsList[0]!,
      id: "msg_1b",
      content: "Second hit in general",
    }

    function twoStreamState() {
      mockSearchState.results = [mockSearchResultsList[0]!, secondGeneralHit, mockSearchResultsList[1]!]
      mockSearchState.clusters = [
        createMockSearchCluster({ hits: [mockSearchResultsList[0]!, secondGeneralHit] }),
        createMockSearchCluster({ hits: [mockSearchResultsList[1]!] }),
      ]
    }

    async function typeQuery(user: ReturnType<typeof userEvent.setup>) {
      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")
      return editor
    }

    function groupSections(): HTMLElement[] {
      return Array.from(document.querySelectorAll<HTMLElement>("[data-search-group]"))
    }

    it("heads each stream with its breadcrumb and result count, and collapses it away", async () => {
      twoStreamState()
      const user = userEvent.setup()
      renderPanel()
      await typeQuery(user)

      await screen.findByText(/from the search results/)
      expect(groupSections().map((section) => section.getAttribute("data-search-group"))).toEqual([
        "stream_channel1",
        "stream_channel2",
      ])
      const [general, random] = groupSections()
      expect(within(general!).getByText("#general")).toBeInTheDocument()
      expect(within(random!).getByText("#random")).toBeInTheDocument()
      const header = within(general!).getByRole("button", { expanded: true })
      expect(header).toHaveTextContent("2")
      expect(resultIds()).toEqual(["msg_1", "msg_1b", "msg_2"])

      await user.click(header)

      expect(header).toHaveAttribute("aria-expanded", "false")
      expect(resultIds()).toEqual(["msg_2"])
      expect(screen.getByText("3 results in 2 streams")).toBeInTheDocument()
    })

    it("shows the same hits flat, each naming its stream, in ranked mode", async () => {
      twoStreamState()
      const user = userEvent.setup()
      renderPanel()
      await typeQuery(user)
      await screen.findByText(/from the search results/)
      expect(screen.getByText("3 results in 2 streams")).toBeInTheDocument()

      await user.click(screen.getByRole("radio", { name: "Ranked results" }))

      expect(groupSections()).toHaveLength(0)
      expect(resultIds()).toEqual(["msg_1", "msg_1b", "msg_2"])
      expect(Array.from(document.querySelectorAll("[data-search-stream-label]"), (label) => label.textContent)).toEqual(
        ["#general", "#random"]
      )
      expect(screen.getByText("3 results in 2 streams")).toBeInTheDocument()
    })

    it("skips a collapsed group's hits when walking results with the keyboard", async () => {
      twoStreamState()
      const user = userEvent.setup()
      renderPanel()
      const editor = await typeQuery(user)
      await screen.findByText(/from the search results/)

      const [general] = groupSections()
      await user.click(within(general!).getByRole("button", { expanded: true }))
      await user.click(editor)
      await user.keyboard("{ArrowDown}")

      expect(document.querySelector('[aria-current="true"]')).toHaveAttribute("data-search-result-id", "msg_2")
    })

    it("labels the two display modes Grouped and Ranked", async () => {
      mockSearchState.results = mockSearchResultsList
      const user = userEvent.setup()
      renderPanel()
      await typeQuery(user)
      await screen.findByText(/from the search results/)

      const grouped = screen.getByRole("radio", { name: "Grouped results" })
      expect(grouped).toHaveTextContent("Grouped")
      expect(screen.getByRole("radio", { name: "Ranked results" })).toHaveTextContent("Ranked")
    })
  })
  describe("filter syntax", () => {
    it("shows a removable chip when typing filter syntax", async () => {
      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "from:@martin hello")

      await waitFor(() => {
        expect(screen.getByText("@martin")).toBeInTheDocument()
      })

      await user.click(screen.getByRole("button", { name: /remove filter @martin/i }))

      await waitFor(() => {
        expect(screen.queryByText("@martin")).not.toBeInTheDocument()
      })
    })

    it("widens date-only before:/after: filters to local-midnight ISO datetimes in the API call", async () => {
      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "before:2026-06-19 hello")

      // The API validates z.string().datetime(); the bare YYYY-MM-DD from the
      // query syntax must arrive as the start of that date in local time
      await waitFor(() => {
        expect(mockSearchState.search).toHaveBeenCalledWith("hello", {
          before: new Date(2026, 5, 19).toISOString(),
          status: ["active", "archived"],
        })
      })
    })

    it("resolves from:@slug filters to user ids in the API call", async () => {
      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "from:@martin hello")

      await waitFor(() => {
        expect(mockSearchState.search).toHaveBeenCalledWith("hello", {
          from: "member_1",
          status: ["active", "archived"],
        })
      })
    })

    // Guards a regression: the in: filter must insert #slug, not @stream_id.
    it("inserts in:#slug when selecting a channel from the in: filter autocomplete", async () => {
      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "in:#")

      await waitFor(() => {
        expect(screen.getByRole("listbox", { name: /suggestions/i })).toBeInTheDocument()
        expect(screen.getByRole("option", { name: /general/i })).toBeInTheDocument()
      })

      await user.keyboard("{Enter}")

      await waitFor(() => {
        const content = editor.textContent ?? ""
        expect(content).toMatch(/in:#general/i)
        expect(content).not.toContain("stream_")
      })
    })

    it("inserts in:@slug when selecting a user from the in: filter autocomplete (DM)", async () => {
      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "in:@")

      await waitFor(() => {
        expect(screen.getByText("Martin")).toBeInTheDocument()
      })

      await user.keyboard("{Enter}")

      await waitFor(() => {
        const content = editor.textContent ?? ""
        expect(content).toMatch(/in:@martin/i)
        expect(content).not.toContain("stream_")
      })
    })
  })

  describe("add-filter menu", () => {
    async function openFilterMenu(user: ReturnType<typeof userEvent.setup>) {
      await waitFor(() => {
        expect(screen.getByLabelText("Search messages")).toHaveFocus()
      })
      await user.click(screen.getByRole("button", { name: /add search filter/i }))
      await waitFor(() => {
        expect(screen.getByText("From user")).toBeInTheDocument()
      })
    }

    it("lists every filter kind with its typed syntax as the hint", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      renderPanel()
      await openFilterMenu(user)

      for (const label of [
        "From user",
        "With user",
        "In channel",
        "In DM with",
        "Stream type",
        "Status",
        "After date",
        "Before date",
      ]) {
        expect(screen.getByText(label)).toBeInTheDocument()
      }
      // Each entry teaches the typed syntax (in:@user only exists in the menu,
      // unlike from:@user which the empty-state hint also shows)
      expect(screen.getByText("in:@user")).toBeInTheDocument()
    })

    it("adds a from: filter without typing any syntax", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      renderPanel()
      await openFilterMenu(user)

      await user.click(screen.getByText("From user"))
      await waitFor(() => {
        expect(screen.getByPlaceholderText("Search users...")).toBeInTheDocument()
      })
      await user.click(screen.getByText("Martin"))

      // The query string is rewritten with the filter syntax and renders as a
      // chip. The trailing space must survive the editor round-trip — without
      // it the cursor sits inside the filter token and re-opens the typed
      // suggestion popover when the input regains focus.
      const editor = screen.getByLabelText("Search messages")
      await waitFor(() => {
        expect(editor.textContent).toContain("from:@martin ")
        expect(screen.getByRole("button", { name: /remove filter @martin/i })).toBeInTheDocument()
      })
      // The slug resolves to the user id in the API call, same as the typed path
      await waitFor(() => {
        expect(mockSearchState.search).toHaveBeenCalledWith("", { from: "member_1", status: ["active", "archived"] })
      })
    })

    it("adds an in:#channel filter via the menu", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      renderPanel()
      await openFilterMenu(user)

      await user.click(screen.getByText("In channel"))
      await waitFor(() => {
        expect(screen.getByPlaceholderText("Search channels...")).toBeInTheDocument()
      })
      // streamLabel renders channels as #slug
      await user.click(screen.getByText("#general"))

      const editor = screen.getByLabelText("Search messages")
      await waitFor(() => {
        expect(editor.textContent).toContain("in:#general")
      })
      await waitFor(() => {
        expect(mockSearchState.search).toHaveBeenCalledWith("", {
          in: ["stream_channel1"],
          status: ["active", "archived"],
        })
      })
    })

    it("adds an in:@user DM filter via the menu", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      renderPanel()
      await openFilterMenu(user)

      await user.click(screen.getByText("In DM with"))
      await waitFor(() => {
        expect(screen.getByPlaceholderText("Search users...")).toBeInTheDocument()
      })
      await user.click(screen.getByText("Martin"))

      const editor = screen.getByLabelText("Search messages")
      await waitFor(() => {
        expect(editor.textContent).toContain("in:@martin")
      })
      await waitFor(() => {
        expect(mockSearchState.search).toHaveBeenCalledWith("", { in: ["member_1"], status: ["active", "archived"] })
      })
    })

    it("adds a status filter from the fixed options", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      renderPanel()
      await openFilterMenu(user)

      await user.click(screen.getByText("Status"))
      await waitFor(() => {
        expect(screen.getByText("Archived")).toBeInTheDocument()
      })
      await user.click(screen.getByText("Archived"))

      const editor = screen.getByLabelText("Search messages")
      await waitFor(() => {
        expect(editor.textContent).toContain("status:archived ")
      })
      await waitFor(() => {
        expect(mockSearchState.search).toHaveBeenCalledWith("", { status: ["archived"] })
      })
    })

    it("adds a date filter from the relative presets", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      renderPanel()
      await openFilterMenu(user)

      await user.click(screen.getByText("After date"))
      await waitFor(() => {
        expect(screen.getByText("Yesterday")).toBeInTheDocument()
      })
      await user.click(screen.getByText("Yesterday"))

      const editor = screen.getByLabelText("Search messages")
      await waitFor(() => {
        expect(editor.textContent).toMatch(/after:\d{4}-\d{2}-\d{2}/)
      })
    })

    it("navigates back from a value picker to the kind list", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      renderPanel()
      await openFilterMenu(user)

      await user.click(screen.getByText("Status"))
      await waitFor(() => {
        expect(screen.getByText("Archived")).toBeInTheDocument()
      })

      await user.click(screen.getByRole("button", { name: /back to filter list/i }))
      await waitFor(() => {
        expect(screen.getByText("From user")).toBeInTheDocument()
      })
      // Still inside the menu, the panel did not close
      expect(screen.getByTestId("search-panel-probe")).toHaveAttribute("data-open", "true")
    })

    it("keeps menu keystrokes away from result navigation", async () => {
      mockSearchState.results = mockSearchResultsList

      const user = userEvent.setup({ pointerEventsCheck: 0 })
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")
      await waitFor(() => {
        expect(screen.getByText(/from the search results/)).toBeInTheDocument()
      })

      await openFilterMenu(user)
      await user.keyboard("{ArrowDown}{Enter}")

      // The keystrokes drove the menu (now in a value picker), not the results
      expect(mockNavigate).not.toHaveBeenCalled()
      expect(document.querySelector('[aria-current="true"]')).toBeNull()
    })
  })

  // The mention suggestion popover behaviors ride with SEARCH_FILTER_TRIGGERS.
  describe("suggestion popover", () => {
    async function openMentionPopover(user: ReturnType<typeof userEvent.setup>) {
      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "test @")
      // Scope to the suggestion listbox — "Martin" can also appear as a result
      // row's author name in the panel behind the popover
      await waitFor(() => {
        expect(screen.getByRole("option", { name: /martin/i })).toBeInTheDocument()
      })
      return editor
    }

    it("selects the popover item with Enter instead of opening a result", async () => {
      mockSearchState.results = mockSearchResultsList

      const user = userEvent.setup()
      renderPanel()
      const editor = await openMentionPopover(user)

      await user.keyboard("{Enter}")

      await waitFor(() => {
        expect(editor.textContent).toContain("@martin")
      })
      expect(mockNavigate).not.toHaveBeenCalled()
    })

    it("selects the popover item with Tab", async () => {
      const user = userEvent.setup()
      renderPanel()
      const editor = await openMentionPopover(user)

      await user.keyboard("{Tab}")

      await waitFor(() => {
        expect(editor.textContent).toContain("@martin")
      })
    })

    it("selects the popover item when clicking it", async () => {
      mockSearchState.results = mockSearchResultsList

      // pointerEventsCheck: 0 because jsdom can't compute the CSS cascade —
      // suggestion-list.tsx sets pointer-events-auto explicitly
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      renderPanel()
      const editor = await openMentionPopover(user)

      await user.click(screen.getByRole("option", { name: /martin/i }))

      await waitFor(() => {
        expect(editor.textContent).toContain("@martin")
      })
      expect(mockNavigate).not.toHaveBeenCalled()
    })

    it("navigates popover items with arrow keys without leaving the panel", async () => {
      const user = userEvent.setup()
      renderPanel()
      await openMentionPopover(user)

      await user.keyboard("{ArrowDown}")
      expect(screen.getByText("Kate")).toBeInTheDocument()
      await user.keyboard("{ArrowUp}")

      // Popover captured the arrows: the panel stays open, no result navigation
      expect(screen.getByTestId("search-panel-probe")).toHaveAttribute("data-open", "true")
      expect(mockNavigate).not.toHaveBeenCalled()
    })

    it("closes the popover (not the panel) with Escape", async () => {
      const user = userEvent.setup()
      renderPanel()
      await openMentionPopover(user)

      await user.keyboard("{Escape}")

      await waitFor(() => {
        expect(screen.queryByRole("listbox", { name: /suggestions/i })).not.toBeInTheDocument()
      })
      expect(screen.getByTestId("search-panel-probe")).toHaveAttribute("data-open", "true")
    })
  })

  describe("refine", () => {
    const baseFilters = { status: ["active", "archived"] }
    const searchOn: FeatureFlagLayers = { workspace: { search: "on" }, user: {} }

    async function typeQuery(user: ReturnType<typeof userEvent.setup>, query = "hello") {
      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, query)
      return editor
    }

    function refinePill() {
      return screen.getByRole("button", { name: "Refine" })
    }

    async function commitRefine(user: ReturnType<typeof userEvent.setup>, text: string) {
      await user.click(refinePill())
      await user.type(await screen.findByLabelText("Refinement"), text)
      await user.keyboard("{Enter}")
    }

    it("offers the pill only with a query, and only under the search flag", async () => {
      const user = userEvent.setup()
      const { unmount } = renderPanel(searchOn)

      expect(screen.queryByRole("button", { name: "Refine" })).not.toBeInTheDocument()
      await typeQuery(user)
      expect(refinePill()).toBeInTheDocument()

      unmount()
      renderPanel()
      await typeQuery(user)
      expect(screen.queryByRole("button", { name: "Refine" })).not.toBeInTheDocument()
      expect(screen.queryByText(/Refine the list in plain words/)).not.toBeInTheDocument()
    })

    it("opens the row focused from the pill, with the commit segment disabled while empty", async () => {
      const user = userEvent.setup()
      renderPanel(searchOn)
      await typeQuery(user)

      expect(refinePill()).toHaveAttribute("aria-expanded", "false")
      await user.click(refinePill())

      const field = await screen.findByLabelText("Refinement")
      expect(field).toHaveFocus()
      expect(refinePill()).toHaveAttribute("aria-expanded", "true")
      expect(screen.getByRole("button", { name: "Apply refinement" })).toBeDisabled()

      await user.type(field, "  ")
      expect(screen.getByRole("button", { name: "Apply refinement" })).toBeDisabled()

      await user.type(field, "only decisions")
      expect(screen.getByRole("button", { name: "Apply refinement" })).toBeEnabled()
    })

    it("commits the prose as a chip from the commit segment, closes the row, and searches with it", async () => {
      mockSearchState.results = mockSearchResultsList

      const user = userEvent.setup()
      renderPanel(searchOn)
      await typeQuery(user)
      await waitFor(() => {
        expect(mockSearchState.search).toHaveBeenLastCalledWith("hello", baseFilters)
      })

      await user.click(refinePill())
      await user.type(await screen.findByLabelText("Refinement"), "only decisions")
      await user.click(screen.getByRole("button", { name: "Apply refinement" }))

      expect(screen.queryByLabelText("Refinement")).not.toBeInTheDocument()
      expect(document.querySelector('[data-search-refine="only decisions"]')).toBeInTheDocument()
      // The query field never carried the prose
      expect(screen.getByTestId("search-panel-probe")).toHaveAttribute("data-query", "hello")
      await waitFor(() => {
        expect(mockSearchState.search.mock.calls.filter((call) => call[3] !== undefined)).toEqual([
          ["hello", baseFilters, [], ["only decisions"]],
        ])
      })

      await user.click(screen.getByRole("button", { name: "Remove refinement only decisions" }))
      expect(document.querySelector("[data-search-refine]")).not.toBeInTheDocument()
      await waitFor(() => {
        expect(mockSearchState.search).toHaveBeenLastCalledWith("hello", baseFilters)
      })
    })

    it("commits on Enter without opening a result", async () => {
      mockSearchState.results = mockSearchResultsList

      const user = userEvent.setup()
      renderPanel(searchOn)
      await typeQuery(user)
      await commitRefine(user, "only decisions")

      expect(document.querySelector('[data-search-refine="only decisions"]')).toBeInTheDocument()
      expect(screen.queryByLabelText("Refinement")).not.toBeInTheDocument()
      expect(mockNavigate).not.toHaveBeenCalled()
    })

    it("discards the text on Escape and hands focus back to the pill", async () => {
      const user = userEvent.setup()
      renderPanel(searchOn)
      await typeQuery(user)

      await user.click(refinePill())
      await user.type(await screen.findByLabelText("Refinement"), "only decisions")
      await user.keyboard("{Escape}")

      expect(screen.queryByLabelText("Refinement")).not.toBeInTheDocument()
      expect(document.querySelector("[data-search-refine]")).not.toBeInTheDocument()
      expect(refinePill()).toHaveFocus()
      // Focus alone does not open the tooltip; it would cover the results
      expect(screen.queryByText(/Refine these results in plain words\./)).not.toBeInTheDocument()
      // The panel itself stayed open
      expect(screen.getByTestId("search-panel-probe")).toHaveAttribute("data-open", "true")
    })

    it("discards the text from the close segment", async () => {
      const user = userEvent.setup()
      renderPanel(searchOn)
      await typeQuery(user)

      await user.click(refinePill())
      await user.type(await screen.findByLabelText("Refinement"), "only decisions")
      await user.click(screen.getByRole("button", { name: "Close refine" }))

      expect(screen.queryByLabelText("Refinement")).not.toBeInTheDocument()
      expect(document.querySelector("[data-search-refine]")).not.toBeInTheDocument()
    })

    it("keeps the row open with the validation line when the prose is over the cap", async () => {
      const user = userEvent.setup()
      renderPanel(searchOn)
      await typeQuery(user)

      await user.click(refinePill())
      const field = await screen.findByLabelText("Refinement")
      await user.paste("x".repeat(MAX_SEARCH_REFINE_CHARS + 1))
      expect(
        await screen.findByText(`A refinement is at most ${MAX_SEARCH_REFINE_CHARS} characters.`)
      ).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Apply refinement" })).toBeDisabled()

      await user.keyboard("{Enter}")

      expect(field).toBeInTheDocument()
      expect(document.querySelector("[data-search-refine]")).not.toBeInTheDocument()
      expect(mockNavigate).not.toHaveBeenCalled()
    })

    it("reopens the row prefilled from a chip's text and replaces that chip in place", async () => {
      mockSearchState.results = mockSearchResultsList

      const user = userEvent.setup()
      renderPanel(searchOn)
      await typeQuery(user)
      await commitRefine(user, "only decisions")
      await commitRefine(user, "newest first")

      await user.click(screen.getByRole("button", { name: "only decisions" }))
      const field = await screen.findByLabelText("Refinement")
      expect(field).toHaveValue("only decisions")

      await user.clear(field)
      await user.type(field, "only launch decisions")
      await user.keyboard("{Enter}")

      expect(
        Array.from(document.querySelectorAll("[data-search-refine]"), (chip) => chip.getAttribute("data-search-refine"))
      ).toEqual(["only launch decisions", "newest first"])
      await waitFor(() => {
        expect(mockSearchState.search).toHaveBeenLastCalledWith(
          "hello",
          baseFilters,
          [],
          ["only launch decisions", "newest first"]
        )
      })
    })

    it("leaves the chip untouched when an edit is abandoned", async () => {
      const user = userEvent.setup()
      renderPanel(searchOn)
      await typeQuery(user)
      await commitRefine(user, "only decisions")

      await user.click(screen.getByRole("button", { name: "only decisions" }))
      const field = await screen.findByLabelText("Refinement")
      await user.clear(field)
      await user.type(field, "something else")
      await user.keyboard("{Escape}")

      expect(document.querySelector('[data-search-refine="only decisions"]')).toBeInTheDocument()
      expect(document.querySelectorAll("[data-search-refine]")).toHaveLength(1)
    })

    it("keeps the newest refines when the limit is exceeded", async () => {
      const user = userEvent.setup()
      renderPanel(searchOn)
      await typeQuery(user)

      for (const refine of ["one", "two", "three", "four", "five", "six"]) {
        await commitRefine(user, refine)
      }

      expect(
        Array.from(document.querySelectorAll("[data-search-refine]"), (chip) => chip.getAttribute("data-search-refine"))
      ).toEqual(["two", "three", "four", "five", "six"])
    })

    it("wraps the pill in a tooltip on a fine pointer", async () => {
      const user = userEvent.setup()
      renderPanel(searchOn)
      await typeQuery(user)

      await user.hover(refinePill())

      await waitFor(() => {
        expect(screen.getAllByText(/Refine these results in plain words\./).length).toBeGreaterThan(0)
      })
    })

    it("omits the tooltip entirely on a coarse pointer", async () => {
      vi.spyOn(hooksModule, "useCoarsePointer").mockReturnValue(true)

      const user = userEvent.setup()
      renderPanel(searchOn)
      await typeQuery(user)

      await user.hover(refinePill())

      expect(refinePill()).not.toHaveAttribute("data-state")
      expect(screen.queryByText(/Refine these results in plain words\./)).not.toBeInTheDocument()
    })

    it("shows the model's note when the refine applied", async () => {
      mockSearchState.results = mockSearchResultsList
      mockSearchState.refine = { applied: true, note: "Kept the decisions." }

      const user = userEvent.setup()
      renderPanel(searchOn)
      await typeQuery(user)
      await commitRefine(user, "only decisions")

      expect(await screen.findByText("Kept the decisions.")).toBeInTheDocument()
      expect(document.querySelector("[data-search-refine-failed]")).not.toBeInTheDocument()
      expect(document.querySelector('[data-search-refine="only decisions"]')).not.toHaveAttribute(
        "data-search-refine-state"
      )
    })

    it("spins the newest refine chip while a refined search is in flight", async () => {
      mockSearchState.results = mockSearchResultsList
      mockSearchState.isLoading = true

      const user = userEvent.setup()
      renderPanel(searchOn)
      await typeQuery(user)
      await commitRefine(user, "only decisions")

      await waitFor(() => {
        expect(document.querySelector('[data-search-refine="only decisions"]')).toHaveAttribute(
          "data-search-refine-state",
          "pending"
        )
      })
      // The refined results stay on screen with the count, dimmed, behind the progress line
      expect(screen.getByText("#general")).toBeInTheDocument()
      expect(screen.getByText("2 results in 2 streams")).toBeInTheDocument()
      expect(screen.getByText("#general").closest(".opacity-60")).toBeInTheDocument()
      expect(await screen.findByTestId("stream-loading-indicator")).toBeInTheDocument()
    })

    it("keeps the results on screen while a follow-up search loads", async () => {
      mockSearchState.results = mockSearchResultsList

      const user = userEvent.setup()
      renderPanel(searchOn)

      const editor = await typeQuery(user)
      expect(await screen.findByText("#general")).toBeInTheDocument()

      mockSearchState.isLoading = true
      await user.type(editor, "!")

      await waitFor(() => {
        expect(screen.getByText("#general").closest(".opacity-60")).toBeInTheDocument()
      })
      expect(screen.getByText("2 results in 2 streams")).toBeInTheDocument()
      expect(screen.queryByText("Searching…")).not.toBeInTheDocument()
    })

    it("offers a manual retry once the refine failed, and reruns the same search", async () => {
      mockSearchState.results = mockSearchResultsList
      mockSearchState.refine = { applied: false, note: null }

      const user = userEvent.setup()
      renderPanel(searchOn)
      await typeQuery(user)
      await commitRefine(user, "only decisions")

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
        expect(mockSearchState.search).toHaveBeenLastCalledWith("hello", baseFilters, [], ["only decisions"])
      })
      const callsBeforeRetry = mockSearchState.search.mock.calls.length

      await user.click(screen.getByRole("button", { name: "Retry" }))

      expect(mockSearchState.search).toHaveBeenCalledTimes(callsBeforeRetry + 1)
      expect(mockSearchState.search).toHaveBeenLastCalledWith("hello", baseFilters, [], ["only decisions"])
    })

    it("opens the first result on Enter in the query field", async () => {
      mockSearchState.results = mockSearchResultsList

      const user = userEvent.setup()
      renderPanel(searchOn)
      await typeQuery(user, "/etc")
      await waitFor(() => {
        expect(mockSearchState.search).toHaveBeenLastCalledWith("/etc", baseFilters)
      })

      await user.keyboard("{Enter}")

      expect(mockNavigate).toHaveBeenCalledWith("/w/workspace_1/s/stream_channel1?m=msg_1")
    })
  })

  describe("row menu", () => {
    const baseFilters = { status: ["active", "archived"] }
    const searchOn: FeatureFlagLayers = { workspace: { search: "on" }, user: {} }

    async function renderWithConversationRow(featureFlags: FeatureFlagLayers = searchOn) {
      mockSearchState.results = mockSearchResultsList
      mockSearchState.clusters = [launchCluster()]
      const user = userEvent.setup()
      renderPanel(featureFlags)
      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")
      await screen.findByText("Choosing the launch date")
      return user
    }

    /** The header row's own action cluster, not the nested hit's. */
    function conversationHeader(): HTMLElement {
      return document.querySelector('[data-search-conversation-id="conv_1"]')!.parentElement as HTMLElement
    }

    async function openConversationMenu(user: ReturnType<typeof userEvent.setup>) {
      await user.click(within(conversationHeader()).getByRole("button", { name: "Row actions" }))
      return screen.findByRole("menu")
    }

    it("keeps the trigger in the layout on every row, revealed rather than mounted on hover", async () => {
      await renderWithConversationRow()

      const trigger = within(conversationHeader()).getByRole("button", { name: "Row actions" })
      expect(trigger.parentElement).toHaveClass("reveal-actions-hover-only")
      const hitRow = document.querySelector('[data-search-result-id="msg_1"]')!.closest("li") as HTMLElement
      expect(within(hitRow).getByRole("button", { name: "Row actions" })).toBeInTheDocument()
    })

    it("refines by the row on More like this, and renders the chip by the row's title", async () => {
      const user = await renderWithConversationRow()

      await openConversationMenu(user)
      await user.click(screen.getByRole("menuitem", { name: "More like this" }))

      expect(document.querySelector('[data-search-refine="more:conv_1"]')).toBeInTheDocument()
      expect(screen.getByText("More like Choosing the launch date")).toBeInTheDocument()
      await waitFor(() => {
        expect(mockSearchState.search.mock.calls.filter((call) => call[3] !== undefined)).toEqual([
          ["hello", baseFilters, [], [{ kind: "more", conversationId: "conv_1" }]],
        ])
      })
    })

    it("refines by the row on Drop, from the menu the right-click opens", async () => {
      const user = await renderWithConversationRow()

      fireEvent.contextMenu(conversationHeader())
      await user.click(await screen.findByRole("menuitem", { name: "Drop" }))

      expect(document.querySelector('[data-search-refine="drop:conv_1"]')).toBeInTheDocument()
      expect(screen.getByText("Drop Choosing the launch date")).toBeInTheDocument()
      await waitFor(() => {
        expect(mockSearchState.search.mock.calls.filter((call) => call[3] !== undefined)).toEqual([
          ["hello", baseFilters, [], [{ kind: "drop", conversationId: "conv_1" }]],
        ])
      })
    })

    it("confirms Copy link in place, with no toast and the menu still open", async () => {
      const user = await renderWithConversationRow()
      const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
      const success = vi.spyOn(sonnerModule.toast, "success")
      const error = vi.spyOn(sonnerModule.toast, "error")

      await openConversationMenu(user)
      const copy = screen.getByRole("menuitem", { name: "Copy link" })
      expect(copy.querySelector(".lucide-check")).not.toBeInTheDocument()
      await user.click(copy)

      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/w/workspace_1/s/stream_channel1?m=msg_first`)
      await waitFor(() => {
        expect(screen.getByRole("menuitem", { name: "Copy link" }).querySelector(".lucide-check")).toBeInTheDocument()
      })
      expect(success).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
    })

    it("opens the row and its stream, and saves the row's first hit", async () => {
      const user = await renderWithConversationRow()

      await openConversationMenu(user)
      expect(screen.getByRole("menuitem", { name: "Open conversation" })).toHaveAttribute(
        "href",
        "/w/workspace_1/s/stream_channel1?m=msg_first"
      )
      expect(screen.getByRole("menuitem", { name: "Show in #general" })).toHaveAttribute(
        "href",
        "/w/workspace_1/s/stream_channel1"
      )
      expect(screen.getByRole("menuitem", { name: "Save for later" })).toBeInTheDocument()
    })

    it("omits More like this and Drop on a lone-message row, and without the search flag", async () => {
      mockSearchState.results = mockSearchResultsList
      const user = userEvent.setup()
      renderPanel(searchOn)
      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      await screen.findByText("#general")
      const strayRow = document.querySelector('[data-search-result-id="msg_1"]')!.closest("li") as HTMLElement
      await user.click(within(strayRow).getByRole("button", { name: "Row actions" }))

      const menu = await screen.findByRole("menu")
      expect(within(menu).getByRole("menuitem", { name: "Open message" })).toBeInTheDocument()
      expect(within(menu).queryByRole("menuitem", { name: "More like this" })).not.toBeInTheDocument()
      expect(within(menu).queryByRole("menuitem", { name: "Drop" })).not.toBeInTheDocument()
    })

    it("omits the refine items while the search flag is off", async () => {
      const user = await renderWithConversationRow({ workspace: {}, user: {} })

      const menu = await openConversationMenu(user)
      expect(within(menu).getByRole("menuitem", { name: "Copy link" })).toBeInTheDocument()
      expect(within(menu).queryByRole("menuitem", { name: "More like this" })).not.toBeInTheDocument()
    })
  })
})
