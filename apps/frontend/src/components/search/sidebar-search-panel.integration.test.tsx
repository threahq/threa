/**
 * Integration tests for the sidebar search panel — the desktop search surface.
 */
import type React from "react"
import { useState } from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
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
import type { AuthorType } from "@threa/types"
import { ApiError } from "@/api"
import * as hooksModule from "@/hooks"
import * as mentionablesModule from "@/hooks/use-mentionables"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as contextsModule from "@/contexts"

const mockNavigate = vi.fn()
let workspaceStreams = mockStreamsList

type MockSearchResult = Omit<(typeof mockSearchResultsList)[number], "authorType"> & { authorType: AuthorType }

const mockSearchState = {
  results: [] as MockSearchResult[],
  isLoading: false,
  search: vi.fn(),
  clear: vi.fn(),
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

function renderPanel() {
  const queryClient = createTestQueryClient()
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
}

describe("SidebarSearchPanel Integration Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockNavigate.mockReset()
    localStorage.clear()
    workspaceStreams = mockStreamsList
    mockSearchState.results = []
    mockSearchState.isLoading = false
    mockSearchState.search = vi.fn()
    mockSearchState.clear = vi.fn()
    installSpies()
  })

  describe("basic rendering", () => {
    it("renders the search input and the filter-syntax hint when empty", () => {
      renderPanel()

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
    it("renders results grouped by stream with highlighted match terms", async () => {
      mockSearchState.results = mockSearchResultsList

      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      // Group headers carry the stream names; both fixture streams are hit
      await waitFor(() => {
        expect(screen.getByText("#general")).toBeInTheDocument()
        expect(screen.getByText("#random")).toBeInTheDocument()
      })

      // The matched term renders inside a <mark>
      const marks = document.querySelectorAll("mark")
      const markTexts = Array.from(marks, (m) => m.textContent?.toLowerCase())
      expect(markTexts).toContain("hello")
    })

    it("defaults to grouped results and persists ranked mode per workspace in API order", async () => {
      mockSearchState.results = [mockSearchResultsList[1]!, mockSearchResultsList[0]!]
      const user = userEvent.setup()
      const view = renderPanel()
      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      expect(await screen.findByText("#general")).toBeInTheDocument()
      await user.click(screen.getByRole("radio", { name: "Ranked results" }))

      await waitFor(() => expect(document.querySelector("section")).toBeNull())
      expect(
        Array.from(document.querySelectorAll("[data-search-result-id]"), (row) =>
          row.getAttribute("data-search-result-id")
        )
      ).toEqual(["msg_2", "msg_1"])
      expect(document.querySelectorAll("[data-search-stream-label]")).toHaveLength(2)
      expect(localStorage.getItem("threa-search-result-display:workspace_1")).toBe("ranked")

      view.unmount()
      renderPanel()
      const persistedEditor = screen.getByLabelText("Search messages")
      await user.click(persistedEditor)
      await user.type(persistedEditor, "hello")
      await waitFor(() => expect(document.querySelector("section")).toBeNull())
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

    it("collapses and expands a stream group", async () => {
      mockSearchState.results = mockSearchResultsList

      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      await waitFor(() => {
        expect(screen.getByText(/from the search results/)).toBeInTheDocument()
      })

      await user.click(screen.getByRole("button", { name: /#general/ }))
      expect(screen.queryByText(/from the search results/)).not.toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: /#general/ }))
      expect(screen.getByText(/from the search results/)).toBeInTheDocument()
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

    it("runs a deep search from the Search deeper button when results are present", async () => {
      mockSearchState.results = mockSearchResultsList

      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      await waitFor(() => {
        expect(screen.getByText("#general")).toBeInTheDocument()
      })

      await user.click(screen.getByRole("button", { name: /search deeper/i }))

      expect(mockSearchState.search).toHaveBeenLastCalledWith("hello", { status: ["active", "archived"] }, undefined, {
        deep: true,
      })
    })

    it("runs a deep search on Enter when there are no results", async () => {
      mockSearchState.results = []

      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      await waitFor(() => {
        expect(screen.getByText("No results")).toBeInTheDocument()
      })

      await user.keyboard("{Enter}")

      expect(mockSearchState.search).toHaveBeenLastCalledWith("hello", { status: ["active", "archived"] }, undefined, {
        deep: true,
      })
      expect(mockNavigate).not.toHaveBeenCalled()
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

  // The mention suggestion popover behaviors ride with SEARCH_TRIGGERS.
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
})
