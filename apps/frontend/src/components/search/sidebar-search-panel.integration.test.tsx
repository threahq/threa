/**
 * Integration tests for the sidebar search panel — the desktop search surface
 * that replaced the quick switcher's in-palette search mode. The suggestion
 * popover and filter-syntax tests that used to live in
 * quick-switcher.integration.test.tsx moved here with the feature.
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
import * as hooksModule from "@/hooks"
import * as mentionablesModule from "@/hooks/use-mentionables"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as contextsModule from "@/contexts"

const mockNavigate = vi.fn()

const mockSearchState = {
  results: [] as typeof mockSearchResultsList,
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
  const { isOpen, query } = useSearchPanel()
  return <div data-testid="search-panel-probe" data-open={String(isOpen)} data-query={query} />
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
    () => mockStreamsList as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockImplementation(
    () => mockUsersList as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockImplementation(
    () => [] as ReturnType<typeof workspaceStoreModule.useWorkspacePersonas>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockImplementation(
    () => [] as ReturnType<typeof workspaceStoreModule.useWorkspaceDmPeers>
  )

  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: null,
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
}

describe("SidebarSearchPanel Integration Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockNavigate.mockReset()
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

    it("navigates to the stream focused on the message when clicking a result", async () => {
      mockSearchState.results = mockSearchResultsList

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

    it("steps through results with ArrowDown and opens the active one with Enter", async () => {
      mockSearchState.results = mockSearchResultsList

      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "hello")

      await waitFor(() => {
        expect(screen.getByText(/from the search results/)).toBeInTheDocument()
      })

      await user.keyboard("{ArrowDown}{ArrowDown}")

      // Second result is now active
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
      expect(mockSearchState.search).toHaveBeenCalledWith("hello", {})
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

    it("resolves from:@slug filters to user ids in the API call", async () => {
      const user = userEvent.setup()
      renderPanel()

      const editor = screen.getByLabelText("Search messages")
      await user.click(editor)
      await user.type(editor, "from:@martin hello")

      await waitFor(() => {
        expect(mockSearchState.search).toHaveBeenCalledWith("hello", { from: "member_1" })
      })
    })

    // Moved from quick-switcher.integration.test.tsx (BUG: in: filter should
    // show #slug, not @stream_id) — the autocomplete now lives in this panel.
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

  // Moved from quick-switcher.integration.test.tsx — the mention suggestion
  // popover behaviors ride with SEARCH_TRIGGERS, which now render here.
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
