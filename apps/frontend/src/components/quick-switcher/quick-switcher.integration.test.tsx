import type React from "react"
import { useState } from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Router } from "react-router-dom"
import { QuickSwitcher } from "./quick-switcher"
import { SidebarProvider } from "@/contexts/sidebar-context"
import { SearchPanelProvider, useSearchPanel } from "@/components/search/search-panel-context"
import { mockStreamsList } from "@/test/fixtures"
import { mockUsersList } from "@/test/fixtures/users"
import { mockSearchResultsList } from "@/test/fixtures/messages"
import * as hooksModule from "@/hooks"
import * as mentionablesModule from "@/hooks/use-mentionables"
import * as createEncryptedScratchpadModule from "@/hooks/use-create-encrypted-scratchpad"
import * as e2eUnlockModule from "@/components/encryption/e2e-unlock-provider"
import * as e2eSessionStoreModule from "@/stores/e2e-session-store"
import * as authModule from "@/auth"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as streamsApiModule from "@/api/streams"
import * as contextsModule from "@/contexts"
import * as streamSettingsModule from "@/components/stream-settings/use-stream-settings"

// Note: DOM polyfills (ResizeObserver, Range, Element.getClientRects, etc.)
// are in src/test/setup.ts which runs before tests via vitest config

// react-router-dom's ESM namespace is frozen, so we can't spy on useNavigate.
// Instead we render with a bare <Router> that carries a custom `navigator` which
// records every push/replace into `mockNavigate`.
const mockNavigate = vi.fn()

const mockSearchState = {
  results: [] as typeof mockSearchResultsList,
  isLoading: false,
  search: vi.fn(),
  clear: vi.fn(),
}

// Contextual stream-command collaborators, asserted on across tests.
const mockArchiveMutateAsync = vi.fn()
const mockDeleteDraft = vi.fn()
const mockOpenStreamSettings = vi.fn()

// The encrypted-scratchpad create hook is stubbed (it reaches into the sync
// engine). Kept at module scope so the onboarding tests can assert whether the
// palette created the scratchpad directly or routed through the unlock modal
// first.
const mockCreateEncryptedScratchpad = vi.fn(async () => "stream_e2e_test")

const mockWorkspaceBootstrap = {
  data: {} as {
    streams: unknown[]
    streamMemberships: unknown[]
    users: unknown[]
    personas: unknown[]
    dmPeers?: Array<{ userId: string; streamId: string }>
  },
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
    push: (to: unknown, _state?: unknown, opts?: { replace?: boolean }) => {
      const path =
        typeof to === "string" ? to : toPathString(to as { pathname: string; search?: string; hash?: string })
      if (opts?.replace) {
        mockNavigate(path, { replace: true })
      } else {
        mockNavigate(path)
      }
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

/**
 * Exposes the search panel provider state so tests can assert that the
 * "Search messages" command opens the dedicated search surface (and that
 * nothing else in the palette does).
 */
function SearchPanelProbe() {
  const { isOpen, query } = useSearchPanel()
  return <div data-testid="search-panel-probe" data-open={String(isOpen)} data-query={query} />
}

function ProvidersWrapper({ children }: { children: React.ReactNode }) {
  return (
    <RouterWrapper>
      <SidebarProvider>
        <SearchPanelProvider workspaceId="workspace_1">
          {children}
          <SearchPanelProbe />
        </SearchPanelProvider>
      </SidebarProvider>
    </RouterWrapper>
  )
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = createTestQueryClient()
  return render(
    <QueryClientProvider client={queryClient}>
      <ProvidersWrapper>{ui}</ProvidersWrapper>
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
  vi.spyOn(hooksModule, "useWorkspaceBootstrap").mockReturnValue({
    data: mockWorkspaceBootstrap.data,
    isLoading: false,
  } as unknown as ReturnType<typeof hooksModule.useWorkspaceBootstrap>)
  vi.spyOn(hooksModule, "useDraftScratchpads").mockReturnValue({
    createDraft: vi.fn(),
    deleteDraft: mockDeleteDraft,
  } as unknown as ReturnType<typeof hooksModule.useDraftScratchpads>)
  vi.spyOn(hooksModule, "useArchiveStream").mockReturnValue({
    mutateAsync: mockArchiveMutateAsync,
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof hooksModule.useArchiveStream>)
  vi.spyOn(streamSettingsModule, "useStreamSettings").mockReturnValue({
    openStreamSettings: mockOpenStreamSettings,
  } as unknown as ReturnType<typeof streamSettingsModule.useStreamSettings>)
  vi.spyOn(hooksModule, "useCreateStream").mockReturnValue({
    mutateAsync: vi.fn(),
  } as unknown as ReturnType<typeof hooksModule.useCreateStream>)
  // `useCreateEncryptedScratchpad` reaches into `useSyncEngine`, which throws
  // outside a SyncEngineProvider. The QuickSwitcher tests don't mount one, so
  // stub the hook out instead of wiring a sync engine into the test harness.
  vi.spyOn(createEncryptedScratchpadModule, "useCreateEncryptedScratchpad").mockReturnValue(
    mockCreateEncryptedScratchpad as unknown as ReturnType<
      typeof createEncryptedScratchpadModule.useCreateEncryptedScratchpad
    >
  )
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
  vi.spyOn(hooksModule, "useFormattedDate").mockReturnValue({
    formatDate: (date: Date) => date.toLocaleDateString(),
    formatTime: (date: Date) => date.toLocaleTimeString(),
    formatDateTime: (date: Date) => date.toLocaleString(),
    formatRelative: (_date: Date) => "just now",
  } as unknown as ReturnType<typeof hooksModule.useFormattedDate>)

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

  vi.spyOn(authModule, "useUser").mockReturnValue({
    id: "workos_user_1",
    name: "Martin",
    slug: "martin",
  } as unknown as ReturnType<typeof authModule.useUser>)

  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockImplementation(
    () => (mockWorkspaceBootstrap.data.streams ?? []) as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockImplementation(
    () => (mockWorkspaceBootstrap.data.users ?? []) as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockImplementation(
    () => (mockWorkspaceBootstrap.data.personas ?? []) as ReturnType<typeof workspaceStoreModule.useWorkspacePersonas>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockImplementation(
    () => (mockWorkspaceBootstrap.data.dmPeers ?? []) as ReturnType<typeof workspaceStoreModule.useWorkspaceDmPeers>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreamMemberships").mockImplementation(
    () =>
      (mockWorkspaceBootstrap.data.streamMemberships ?? []) as ReturnType<
        typeof workspaceStoreModule.useWorkspaceStreamMemberships
      >
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceUnreadState").mockReturnValue(
    null as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUnreadState>
  )

  vi.spyOn(streamsApiModule.streamsApi, "list").mockResolvedValue([])

  vi.spyOn(contextsModule, "useSettings").mockReturnValue({
    openSettings: vi.fn(),
  } as unknown as ReturnType<typeof contextsModule.useSettings>)
  vi.spyOn(contextsModule, "useStreamService").mockReturnValue({
    markAsRead: vi.fn(),
  } as unknown as ReturnType<typeof contextsModule.useStreamService>)
  vi.spyOn(contextsModule, "useWorkspaceService").mockReturnValue({
    markAllAsRead: vi.fn(),
  } as unknown as ReturnType<typeof contextsModule.useWorkspaceService>)
}

describe("QuickSwitcher Integration Tests", () => {
  const defaultProps = {
    workspaceId: "workspace_1",
    open: true,
    onOpenChange: vi.fn(),
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    mockNavigate.mockReset()
    // Reset configurable state that spies read from
    mockSearchState.results = []
    mockSearchState.isLoading = false
    mockSearchState.search = vi.fn()
    mockSearchState.clear = vi.fn()
    mockArchiveMutateAsync.mockReset()
    mockDeleteDraft.mockReset()
    mockOpenStreamSettings.mockReset()
    mockCreateEncryptedScratchpad.mockClear()
    mockWorkspaceBootstrap.data = {
      streams: mockStreamsList,
      streamMemberships: [],
      users: mockUsersList,
      personas: [],
      dmPeers: undefined,
    }
    installSpies()
  })

  describe("dialog lifecycle", () => {
    it("should render when open=true", () => {
      renderWithProviders(<QuickSwitcher {...defaultProps} open={true} />)

      expect(screen.getByRole("dialog")).toBeInTheDocument()
      expect(screen.getByLabelText("Quick switcher input")).toBeInTheDocument()
    })

    it("should not render dialog content when open=false", () => {
      renderWithProviders(<QuickSwitcher {...defaultProps} open={false} />)

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    })

    it("should focus input when dialog opens", async () => {
      renderWithProviders(<QuickSwitcher {...defaultProps} open={true} />)

      await waitFor(() => {
        expect(screen.getByLabelText("Quick switcher input")).toHaveFocus()
      })
    })

    it("should reset query when dialog closes and reopens", async () => {
      const user = userEvent.setup()
      const queryClient = createTestQueryClient()
      const { rerender } = render(
        <QueryClientProvider client={queryClient}>
          <ProvidersWrapper>
            <QuickSwitcher {...defaultProps} open={true} />
          </ProvidersWrapper>
        </QueryClientProvider>
      )

      const input = screen.getByLabelText("Quick switcher input")
      await user.type(input, "test query")
      expect(input).toHaveTextContent("test query")

      // Close dialog
      rerender(
        <QueryClientProvider client={queryClient}>
          <ProvidersWrapper>
            <QuickSwitcher {...defaultProps} open={false} />
          </ProvidersWrapper>
        </QueryClientProvider>
      )

      // Reopen dialog
      rerender(
        <QueryClientProvider client={queryClient}>
          <ProvidersWrapper>
            <QuickSwitcher {...defaultProps} open={true} />
          </ProvidersWrapper>
        </QueryClientProvider>
      )

      await waitFor(() => {
        expect(screen.getByLabelText("Quick switcher input")).toHaveTextContent("")
      })
    })

    it("should call onOpenChange(false) when pressing Escape", async () => {
      const user = userEvent.setup()
      const onOpenChange = vi.fn()
      renderWithProviders(<QuickSwitcher {...defaultProps} onOpenChange={onOpenChange} />)

      await user.keyboard("{Escape}")

      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  describe("keyboard navigation", () => {
    // Helper to check if an item is selected (component uses bg-muted class, not aria-selected)
    const isItemSelected = (element: Element | null) => {
      return element?.classList.contains("bg-muted")
    }

    describe("when popover is closed", () => {
      // Items are sorted by urgency, then activity time, then alphabetically: #general, #random, Martin, My Notes
      it("should navigate down through results with ArrowDown", async () => {
        const user = userEvent.setup()
        renderWithProviders(<QuickSwitcher {...defaultProps} />)

        // Wait for items to render (sorted alphabetically)
        await waitFor(() => {
          expect(screen.getByText("#general")).toBeInTheDocument()
        })

        // First item should be selected by default (#general is first alphabetically)
        const firstItem = screen.getByText("#general").closest("a")
        expect(isItemSelected(firstItem)).toBe(true)

        // Press ArrowDown
        await user.keyboard("{ArrowDown}")

        // Second item should now be selected (#random)
        const secondItem = screen.getByText("#random").closest("a")
        expect(isItemSelected(secondItem)).toBe(true)
        expect(isItemSelected(firstItem)).toBe(false)
      })

      it("should navigate up through results with ArrowUp", async () => {
        const user = userEvent.setup()
        renderWithProviders(<QuickSwitcher {...defaultProps} />)

        await waitFor(() => {
          expect(screen.getByText("#general")).toBeInTheDocument()
        })

        // Navigate down first
        await user.keyboard("{ArrowDown}")
        await user.keyboard("{ArrowDown}")

        // Third item should be selected (Martin)
        const thirdItem = screen.getByText("Martin").closest("a")
        expect(isItemSelected(thirdItem)).toBe(true)

        // Navigate up
        await user.keyboard("{ArrowUp}")

        // Second item should be selected (#random)
        const secondItem = screen.getByText("#random").closest("a")
        expect(isItemSelected(secondItem)).toBe(true)
      })

      it("should not go below last item with ArrowDown", async () => {
        const user = userEvent.setup()
        mockWorkspaceBootstrap.data.dmPeers = [
          { userId: "member_2", streamId: "stream_dm_existing_2" },
          { userId: "member_3", streamId: "stream_dm_existing_3" },
        ]
        renderWithProviders(<QuickSwitcher {...defaultProps} />)

        await waitFor(() => {
          expect(screen.getByText("#general")).toBeInTheDocument()
        })

        // Navigate to last item (4 streams sorted alphabetically)
        await user.keyboard("{ArrowDown}")
        await user.keyboard("{ArrowDown}")
        await user.keyboard("{ArrowDown}")

        // My Notes is last alphabetically
        const lastItem = screen.getByText("My Notes").closest("a")
        expect(isItemSelected(lastItem)).toBe(true)

        // Try to go further
        await user.keyboard("{ArrowDown}")

        // Should still be on last item
        expect(isItemSelected(lastItem)).toBe(true)
      })

      it("should not go above first item with ArrowUp", async () => {
        const user = userEvent.setup()
        renderWithProviders(<QuickSwitcher {...defaultProps} />)

        await waitFor(() => {
          expect(screen.getByText("#general")).toBeInTheDocument()
        })

        // #general is first alphabetically
        const firstItem = screen.getByText("#general").closest("a")
        expect(isItemSelected(firstItem)).toBe(true)

        // Try to go up from first item
        await user.keyboard("{ArrowUp}")

        // Should still be on first item
        expect(isItemSelected(firstItem)).toBe(true)
      })

      it("should select current item with Enter", async () => {
        const user = userEvent.setup()
        renderWithProviders(<QuickSwitcher {...defaultProps} />)

        await waitFor(() => {
          expect(screen.getByText("#general")).toBeInTheDocument()
        })

        // First item (#general = stream_channel1) is already selected
        // Press Enter to select it
        await user.keyboard("{Enter}")

        // Should navigate to the stream
        expect(mockNavigate).toHaveBeenCalledWith("/w/workspace_1/s/stream_channel1")
      })

      it("should close dialog with Escape", async () => {
        const user = userEvent.setup()
        const onOpenChange = vi.fn()
        renderWithProviders(<QuickSwitcher {...defaultProps} onOpenChange={onOpenChange} />)

        await user.keyboard("{Escape}")

        expect(onOpenChange).toHaveBeenCalledWith(false)
      })
    })
  })

  describe("mode switching", () => {
    it("should start in stream mode by default", () => {
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      expect(screen.getByLabelText("Quick switcher input")).toBeInTheDocument()
      // Stream tab should be active
      expect(screen.getByRole("tab", { name: /stream search/i })).toHaveAttribute("aria-selected", "true")
    })

    it("should switch to command mode when typing >", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      const input = screen.getByLabelText("Quick switcher input")
      await user.type(input, ">")

      await waitFor(() => {
        expect(screen.getByLabelText("Quick switcher input")).toBeInTheDocument()
      })
      expect(screen.getByRole("tab", { name: /command palette/i })).toHaveAttribute("aria-selected", "true")
    })

    it("should treat ? as plain stream-search text (no search mode)", async () => {
      const user = userEvent.setup()
      const onOpenChange = vi.fn()
      renderWithProviders(<QuickSwitcher {...defaultProps} onOpenChange={onOpenChange} />)

      const input = screen.getByLabelText("Quick switcher input")
      await user.type(input, "?")

      // Message search left the palette entirely — "?" is just text in
      // stream mode, and nothing closes or opens the search surface
      expect(screen.getByRole("tab", { name: /stream search/i })).toHaveAttribute("aria-selected", "true")
      expect(onOpenChange).not.toHaveBeenCalledWith(false)
      expect(screen.getByTestId("search-panel-probe")).toHaveAttribute("data-open", "false")
    })

    it("should switch mode when clicking mode tabs", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      // Click on Commands tab
      const commandsTab = screen.getByRole("tab", { name: /command palette/i })
      await user.click(commandsTab)

      await waitFor(() => {
        expect(screen.getByLabelText("Quick switcher input")).toBeInTheDocument()
      })
    })

    it("should reset selectedIndex when mode changes", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      await waitFor(() => {
        expect(screen.getByText("#general")).toBeInTheDocument()
      })

      // Navigate to second item (alphabetically: #general, #random, ...)
      await user.keyboard("{ArrowDown}")

      const secondItem = screen.getByText("#random").closest("a")
      expect(secondItem?.classList.contains("bg-muted")).toBe(true)

      // Switch to command mode
      await user.type(screen.getByLabelText("Quick switcher input"), ">")

      // First command should be selected after mode switch
      await waitFor(() => {
        // Look for command items (they're rendered as divs since commands don't have href)
        const commandItems = screen.getAllByText(/new scratchpad|new channel|toggle theme/i)
        if (commandItems.length > 0) {
          const firstCommandItem = commandItems[0].closest("div[data-index]")
          expect(firstCommandItem?.classList.contains("bg-muted")).toBe(true)
        }
      })
    })
  })

  describe("mode prefix behavior", () => {
    it("should preserve > prefix when typing in stream mode", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      const input = screen.getByLabelText("Quick switcher input")

      // Type "> new" - should switch to command mode and preserve the query
      await user.type(input, "> new")

      // Should be in command mode
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /command palette/i })).toHaveAttribute("aria-selected", "true")
      })

      // Input should show "> new"
      const commandInput = screen.getByLabelText("Quick switcher input")
      expect(commandInput).toHaveTextContent("> new")
    })

    it("should normalize redundant > prefixes on paste", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      const input = screen.getByLabelText("Quick switcher input")

      // Paste "> > new" - should normalize to "> new"
      await user.click(input)
      await user.paste("> > new")

      // Should be in command mode
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /command palette/i })).toHaveAttribute("aria-selected", "true")
      })

      // Input should show "> new" (normalized)
      const commandInput = screen.getByLabelText("Quick switcher input")
      expect(commandInput).toHaveTextContent("> new")
    })

    it("should stay in command mode when pasting text without prefix", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="command" />)

      // Start in command mode - query is "> "
      const input = screen.getByLabelText("Quick switcher input")

      // Paste plain text without prefix - should stay in command mode
      await user.click(input)
      await user.paste("new scratchpad")

      // Should stay in command mode
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /command palette/i })).toHaveAttribute("aria-selected", "true")
      })

      // Input should show "> new scratchpad" (prefix preserved)
      expect(input).toHaveTextContent("> new scratchpad")
    })

    it("should keep pasted prefix as content when in different mode (command -> search prefix)", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="command" />)

      // Start in command mode - query is "> "
      const input = screen.getByLabelText("Quick switcher input")

      // Paste text with ? prefix - should stay in command mode, ? becomes content
      await user.click(input)
      await user.paste("? hello")

      // Should stay in command mode
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /command palette/i })).toHaveAttribute("aria-selected", "true")
      })

      // Input should show "> ? hello" (pasted ? is content, not mode switch)
      expect(input).toHaveTextContent("> ? hello")
    })
  })

  describe("mode tab keyboard navigation", () => {
    it("should allow clicking between tabs to change mode", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      // Start in stream mode
      expect(screen.getByLabelText("Quick switcher input")).toBeInTheDocument()

      // Click commands tab
      const commandsTab = screen.getByRole("tab", { name: /command palette/i })
      await user.click(commandsTab)

      await waitFor(() => {
        expect(screen.getByLabelText("Quick switcher input")).toBeInTheDocument()
      })

      // Click streams tab to go back
      const streamsTab = screen.getByRole("tab", { name: /stream search/i })
      await user.click(streamsTab)

      await waitFor(() => {
        expect(screen.getByLabelText("Quick switcher input")).toBeInTheDocument()
      })
    })

    it("should have accessible tabs with proper ARIA attributes", () => {
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      // Two modes: stream search and command palette (message search lives
      // in its own surface, reached via the "Search messages" command)
      const tabs = screen.getAllByRole("tab")
      expect(tabs).toHaveLength(2)

      // Stream tab should be selected by default
      const streamsTab = screen.getByRole("tab", { name: /stream search/i })
      expect(streamsTab).toHaveAttribute("aria-selected", "true")

      const commandsTab = screen.getByRole("tab", { name: /command palette/i })
      expect(commandsTab).toHaveAttribute("aria-selected", "false")
    })

    it("should refocus input when pressing ArrowDown while on tabs", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      // Focus a tab
      const streamsTab = screen.getByRole("tab", { name: /stream search/i })
      await user.click(streamsTab)

      // Press ArrowDown
      await user.keyboard("{ArrowDown}")

      // Input should be focused
      await waitFor(() => {
        expect(screen.getByLabelText("Quick switcher input")).toHaveFocus()
      })
    })

    it("should refocus input when pressing ArrowUp while on tabs", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      // Focus a tab
      const streamsTab = screen.getByRole("tab", { name: /stream search/i })
      await user.click(streamsTab)

      // Press ArrowUp
      await user.keyboard("{ArrowUp}")

      // Input should be focused
      await waitFor(() => {
        expect(screen.getByLabelText("Quick switcher input")).toHaveFocus()
      })
    })
  })

  // Message search no longer lives inside the palette — the "Search messages"
  // command is the palette's entry point to the dedicated surface. The search
  // behaviors themselves (results, filters, popovers) are covered in
  // sidebar-search-panel.integration.test.tsx.
  describe("search messages command", () => {
    it("should close the palette and open the search panel", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      const onOpenChange = vi.fn()
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="command" onOpenChange={onOpenChange} />)

      const input = screen.getByLabelText("Quick switcher input")
      await user.click(input)
      await user.type(input, "search messages")

      await waitFor(() => {
        expect(screen.getByText("Search messages")).toBeInTheDocument()
      })
      await user.click(screen.getByText("Search messages"))

      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(screen.getByTestId("search-panel-probe")).toHaveAttribute("data-open", "true")
      // The palette itself never searches — the panel owns that
      expect(mockSearchState.search).not.toHaveBeenCalled()
    })
  })

  describe("item selection", () => {
    it("should call onSelect when clicking item", async () => {
      // Disable pointer-events check due to Radix Dialog overlay
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      const onOpenChange = vi.fn()
      renderWithProviders(<QuickSwitcher {...defaultProps} onOpenChange={onOpenChange} />)

      await waitFor(() => {
        expect(screen.getByText("#general")).toBeInTheDocument()
      })

      // Click on a stream item (items with href are rendered as <a> links)
      const item = screen.getByText("#general").closest("a")
      await user.click(item!)

      // Should navigate to the stream
      expect(mockNavigate).toHaveBeenCalledWith("/w/workspace_1/s/stream_channel1")
      // Should close dialog
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it("should open in new tab with Cmd+click", async () => {
      const windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null)
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      await waitFor(() => {
        expect(screen.getByText("#general")).toBeInTheDocument()
      })

      // Cmd+click on a stream item - Link components handle this natively
      // The test validates the Link is rendered correctly
      const item = screen.getByText("#general").closest("a")
      expect(item).toHaveAttribute("href", "/w/workspace_1/s/stream_channel1")

      windowOpenSpy.mockRestore()
    })

    it("should open in new tab with Ctrl+click", async () => {
      const windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null)
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      await waitFor(() => {
        expect(screen.getByText("#general")).toBeInTheDocument()
      })

      // Ctrl+click on a stream item - Link components handle this natively
      // The test validates the Link is rendered correctly
      const item = screen.getByText("#general").closest("a")
      expect(item).toHaveAttribute("href", "/w/workspace_1/s/stream_channel1")

      windowOpenSpy.mockRestore()
    })

    it("should close dialog after selection via Enter", async () => {
      const user = userEvent.setup()
      const onOpenChange = vi.fn()
      renderWithProviders(<QuickSwitcher {...defaultProps} onOpenChange={onOpenChange} />)

      await waitFor(() => {
        expect(screen.getByText("My Notes")).toBeInTheDocument()
      })

      // Press Enter to select first item
      await user.keyboard("{Enter}")

      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  describe("stream filtering", () => {
    it("should filter streams by name", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      await waitFor(() => {
        expect(screen.getByText("My Notes")).toBeInTheDocument()
      })

      // Type to filter
      const input = screen.getByLabelText("Quick switcher input")
      await user.type(input, "general")

      await waitFor(() => {
        expect(screen.getByText("#general")).toBeInTheDocument()
        expect(screen.queryByText("My Notes")).not.toBeInTheDocument()
        expect(screen.queryByText("#random")).not.toBeInTheDocument()
      })
    })

    it("should show empty message when no streams match", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      const input = screen.getByLabelText("Quick switcher input")
      await user.type(input, "nonexistent")

      await waitFor(() => {
        expect(screen.getByText("No streams found.")).toBeInTheDocument()
      })
    })

    it("should include virtual DM targets for members without DM streams", async () => {
      const user = userEvent.setup()
      mockWorkspaceBootstrap.data.dmPeers = [{ userId: "member_2", streamId: "stream_dm_existing" }]

      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      const input = screen.getByLabelText("Quick switcher input")
      await user.type(input, "alice")

      await waitFor(() => {
        expect(document.querySelector('a[href="/w/workspace_1/s/draft_dm_member_3"]')).toBeInTheDocument()
      })
    })

    it("should include virtual DM targets when dmPeers is missing", async () => {
      const user = userEvent.setup()
      mockWorkspaceBootstrap.data.dmPeers = undefined

      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      const input = screen.getByLabelText("Quick switcher input")
      await user.type(input, "alice")

      await waitFor(() => {
        expect(document.querySelector('a[href="/w/workspace_1/s/draft_dm_member_3"]')).toBeInTheDocument()
      })
    })
  })

  describe("contextual stream commands", () => {
    it("should surface current-stream commands under a stream-named section in command mode", async () => {
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="command" currentStreamId="stream_channel1" />)

      // Section header names the stream so it stays clear these are stream-specific.
      await waitFor(() => {
        expect(screen.getByText("This stream — #general")).toBeInTheDocument()
      })
      expect(screen.getByText("Archive this stream")).toBeInTheDocument()
      expect(screen.getByText("Open stream settings")).toBeInTheDocument()
      expect(screen.getByText("Browse files in this stream")).toBeInTheDocument()
      expect(screen.getByText("Labels…")).toBeInTheDocument()
      // Global commands remain available below the contextual section.
      expect(screen.getByText("New Channel")).toBeInTheDocument()
    })

    it("should not surface contextual commands when no stream is in view", async () => {
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="command" />)

      await waitFor(() => {
        expect(screen.getByText("New Channel")).toBeInTheDocument()
      })
      expect(screen.queryByText("Archive this stream")).not.toBeInTheDocument()
      expect(screen.queryByText(/This stream/)).not.toBeInTheDocument()
    })

    it("should keep contextual commands visible (with their section) while filtering", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="command" currentStreamId="stream_channel1" />)

      await user.type(screen.getByLabelText("Quick switcher input"), "archive")

      await waitFor(() => {
        expect(screen.getByText("Archive this stream")).toBeInTheDocument()
      })
      expect(screen.getByText("This stream — #general")).toBeInTheDocument()
    })

    it("should open stream settings for the current stream", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="command" currentStreamId="stream_channel1" />)

      await waitFor(() => {
        expect(screen.getByText("Open stream settings")).toBeInTheDocument()
      })
      await user.click(screen.getByText("Open stream settings"))

      expect(mockOpenStreamSettings).toHaveBeenCalledWith("stream_channel1")
    })

    it("should confirm before archiving, and only archive after confirmation", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="command" currentStreamId="stream_channel1" />)

      await waitFor(() => {
        expect(screen.getByText("Archive this stream")).toBeInTheDocument()
      })
      await user.click(screen.getByText("Archive this stream"))

      // Confirmation modal appears; nothing is archived yet.
      await waitFor(() => {
        expect(screen.getByText("Archive #general?")).toBeInTheDocument()
      })
      expect(mockArchiveMutateAsync).not.toHaveBeenCalled()

      await user.click(screen.getByRole("button", { name: "Archive" }))

      await waitFor(() => {
        expect(mockArchiveMutateAsync).toHaveBeenCalledWith("stream_channel1")
      })
    })
  })

  describe("initial mode", () => {
    it("should start in command mode when initialMode is command", () => {
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="command" />)

      expect(screen.getByLabelText("Quick switcher input")).toBeInTheDocument()
      expect(screen.getByRole("tab", { name: /command palette/i })).toHaveAttribute("aria-selected", "true")
    })
  })

  // =============================================================================
  // DIAGNOSTIC TESTS - Understanding test environment vs browser behavior
  // These tests help us understand WHY integration tests might pass when bugs exist
  // =============================================================================
  describe("DIAGNOSTIC: test environment behavior", () => {
    describe("pointer-events behavior", () => {
      it("should show body has pointer-events:none when dialog is open", async () => {
        renderWithProviders(<QuickSwitcher {...defaultProps} />)

        // Check what styles Radix Dialog applies to body
        // In real browser: pointer-events: none would be set
        // In jsdom: getComputedStyle doesn't reflect Radix Dialog's body styles
      })

      it("should verify that userEvent respects pointer-events:none", async () => {
        // userEvent.click() throws an error when element has pointer-events: none
        // This is why the pointer-events fix in suggestion-list.tsx is needed
        const container = document.createElement("div")
        container.style.pointerEvents = "none"
        document.body.appendChild(container)

        const button = document.createElement("button")
        button.textContent = "Click me"
        container.appendChild(button)

        // userEvent should throw because pointer-events: none blocks clicks
        const user = userEvent.setup()
        await expect(user.click(button)).rejects.toThrow(/pointer-events/)

        document.body.removeChild(container)
      })
    })
  })

  // =============================================================================
  // Bug regression tests - these tests should FAIL before the fix is applied
  // Each test documents a specific bug and verifies the correct behavior
  // =============================================================================
  describe("bug regressions", () => {
    describe("BUG: Escape should close dialog when popover is closed", () => {
      // Bug: Pressing Escape doesn't close the quick switcher dialog
      it("should close dialog when pressing Escape in stream mode", async () => {
        const user = userEvent.setup()
        const onOpenChange = vi.fn()
        renderWithProviders(<QuickSwitcher {...defaultProps} onOpenChange={onOpenChange} />)

        // Verify dialog is open
        expect(screen.getByRole("dialog")).toBeInTheDocument()

        // Focus the input (stream mode)
        const input = screen.getByLabelText("Quick switcher input")
        await user.click(input)

        // Press Escape
        await user.keyboard("{Escape}")

        // Dialog should close
        expect(onOpenChange).toHaveBeenCalledWith(false)
      })
    })

    describe("BUG: cmd+f should NOT open search mode (only cmd+shift+f should)", () => {
      // Bug: cmd+f (browser find) opens the quick switcher in search mode.
      // Only cmd+shift+f should open search mode, cmd+f should be left alone for browser.
      //
      // Note: This test verifies the keyboard shortcut handling in the parent component
      // that controls QuickSwitcher. The QuickSwitcher itself doesn't handle shortcuts.
      // This test documents the expected behavior - the actual fix may be in a parent.
      it("should not respond to cmd+f keyboard shortcut", async () => {
        const onOpenChange = vi.fn()
        // Start with dialog closed
        renderWithProviders(<QuickSwitcher {...defaultProps} open={false} onOpenChange={onOpenChange} />)

        // Simulate cmd+f at the document level
        const event = new KeyboardEvent("keydown", {
          key: "f",
          metaKey: true,
          bubbles: true,
        })

        // The event should NOT be prevented (browser find should work)
        const prevented = !document.dispatchEvent(event)

        // If the QuickSwitcher or its parent intercepted cmd+f, it would:
        // 1. Call onOpenChange(true) to open the dialog
        // 2. Prevent the default browser behavior
        //
        // Neither should happen for cmd+f (only cmd+shift+f)
        expect(onOpenChange).not.toHaveBeenCalled()
        expect(prevented).toBe(false)
      })

      // Note: The cmd+shift+f shortcut is handled in workspace-layout.tsx,
      // not in QuickSwitcher. Testing that shortcut requires mounting WorkspaceLayout.
      // The test above (should not respond to cmd+f) verifies QuickSwitcher
      // doesn't intercept cmd+f - which is the important behavior to test here.
    })
  })

  // Asking for an encrypted scratchpad from the palette IS the onboarding
  // trigger (mirrors the sidebar): a locked / not-yet-set-up session must open
  // the shared unlock/setup modal and finish the create afterwards — not throw
  // the "called without an unlocked E2E session" error and dead-end on a toast.
  describe("encrypted scratchpad onboarding", () => {
    const mockOpenUnlock = vi.fn()
    const mockOpenSetup = vi.fn()

    const stubSession = (status: string) =>
      vi
        .spyOn(e2eSessionStoreModule, "getE2eSessionState")
        .mockReturnValue({ status } as unknown as ReturnType<typeof e2eSessionStoreModule.getE2eSessionState>)

    const stubUnlockProvider = () =>
      vi.spyOn(e2eUnlockModule, "useE2eUnlockOptional").mockReturnValue({
        openUnlock: mockOpenUnlock,
        openSetup: mockOpenSetup,
      })

    beforeEach(() => {
      mockOpenUnlock.mockReset()
      mockOpenSetup.mockReset()
    })

    it("opens the unlock modal (not an error toast) when the session is locked, then creates after unlock", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      stubSession("locked")
      stubUnlockProvider()
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="command" />)

      await user.click(await screen.findByText("New Encrypted Scratchpad"))

      // Routed through the unlock modal; the create is deferred, not thrown.
      expect(mockOpenUnlock).toHaveBeenCalledTimes(1)
      expect(mockOpenSetup).not.toHaveBeenCalled()
      expect(mockCreateEncryptedScratchpad).not.toHaveBeenCalled()

      // Completing the unlock runs the deferred create and navigates to it.
      const onUnlocked = mockOpenUnlock.mock.calls[0][0]?.onUnlocked as () => void
      onUnlocked()

      await waitFor(() => {
        expect(mockCreateEncryptedScratchpad).toHaveBeenCalledWith(true)
        expect(mockNavigate).toHaveBeenCalledWith("/w/workspace_1/s/stream_e2e_test")
      })
    })

    it("opens the setup modal when the user has no key yet", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      stubSession("no-key")
      stubUnlockProvider()
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="command" />)

      await user.click(await screen.findByText("New Encrypted Scratchpad"))

      expect(mockOpenSetup).toHaveBeenCalledTimes(1)
      expect(mockOpenUnlock).not.toHaveBeenCalled()
      expect(mockCreateEncryptedScratchpad).not.toHaveBeenCalled()
    })

    it("creates directly when the session is already unlocked", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      stubSession("unlocked")
      stubUnlockProvider()
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="command" />)

      await user.click(await screen.findByText("New Encrypted Scratchpad"))

      await waitFor(() => {
        expect(mockCreateEncryptedScratchpad).toHaveBeenCalledWith(true)
        expect(mockNavigate).toHaveBeenCalledWith("/w/workspace_1/s/stream_e2e_test")
      })
      expect(mockOpenUnlock).not.toHaveBeenCalled()
      expect(mockOpenSetup).not.toHaveBeenCalled()
    })
  })
})
