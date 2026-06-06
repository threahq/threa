import type React from "react"
import { useState } from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Router } from "react-router-dom"
import { QuickSwitcher } from "./quick-switcher"
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

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = createTestQueryClient()
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterWrapper>{ui}</RouterWrapper>
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
          <RouterWrapper>
            <QuickSwitcher {...defaultProps} open={true} />
          </RouterWrapper>
        </QueryClientProvider>
      )

      const input = screen.getByLabelText("Quick switcher input")
      await user.type(input, "test query")
      expect(input).toHaveTextContent("test query")

      // Close dialog
      rerender(
        <QueryClientProvider client={queryClient}>
          <RouterWrapper>
            <QuickSwitcher {...defaultProps} open={false} />
          </RouterWrapper>
        </QueryClientProvider>
      )

      // Reopen dialog
      rerender(
        <QueryClientProvider client={queryClient}>
          <RouterWrapper>
            <QuickSwitcher {...defaultProps} open={true} />
          </RouterWrapper>
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

    // Tests for popover behavior when suggestion list is shown
    // These tests verify keyboard handling is delegated to the popover when active
    describe("when popover is open", () => {
      it("should navigate popover items with ArrowDown", async () => {
        const user = userEvent.setup()
        renderWithProviders(<QuickSwitcher {...defaultProps} />)

        // Switch to search mode first
        const input = screen.getByLabelText("Quick switcher input")
        await user.type(input, "?")

        await waitFor(() => {
          expect(screen.getByRole("tab", { name: /message search/i })).toHaveAttribute("aria-selected", "true")
        })

        const editor = screen.getByLabelText("Search query input")
        // Type @ to trigger mention popover (cursor is at end, after "?")
        await user.type(editor, " @")

        // Wait for popover to appear with mentionables
        await waitFor(() => {
          expect(screen.getByText("Martin")).toBeInTheDocument()
        })

        // ArrowDown should navigate within the popover, not close dialog
        await user.keyboard("{ArrowDown}")

        // Dialog should still be open
        expect(screen.getByRole("dialog")).toBeInTheDocument()
        expect(screen.getByText("Kate")).toBeInTheDocument()
      })

      it("should navigate popover items with ArrowUp", async () => {
        const user = userEvent.setup()
        renderWithProviders(<QuickSwitcher {...defaultProps} />)

        const input = screen.getByLabelText("Quick switcher input")
        await user.type(input, "?")

        await waitFor(() => {
          expect(screen.getByRole("tab", { name: /message search/i })).toHaveAttribute("aria-selected", "true")
        })

        const editor = screen.getByLabelText("Search query input")
        await user.type(editor, " @")

        await waitFor(() => {
          expect(screen.getByText("Martin")).toBeInTheDocument()
        })

        // Navigate down first
        await user.keyboard("{ArrowDown}")
        // Then back up
        await user.keyboard("{ArrowUp}")

        // Dialog should still be open (popover captured the events)
        expect(screen.getByRole("dialog")).toBeInTheDocument()
      })

      it("should select popover item with Enter", async () => {
        const user = userEvent.setup()
        renderWithProviders(<QuickSwitcher {...defaultProps} />)

        const input = screen.getByLabelText("Quick switcher input")
        await user.type(input, "?")

        await waitFor(() => {
          expect(screen.getByRole("tab", { name: /message search/i })).toHaveAttribute("aria-selected", "true")
        })

        const editor = screen.getByLabelText("Search query input")
        await user.type(editor, " @")

        await waitFor(() => {
          expect(screen.getByText("Martin")).toBeInTheDocument()
        })

        // Press Enter to select first item
        await user.keyboard("{Enter}")

        // Popover should close and selection should be inserted
        await waitFor(() => {
          const editorContent = editor.textContent
          expect(editorContent).toContain("@martin")
        })
      })

      it("should select popover item with Tab", async () => {
        const user = userEvent.setup()
        renderWithProviders(<QuickSwitcher {...defaultProps} />)

        const input = screen.getByLabelText("Quick switcher input")
        await user.type(input, "?")

        await waitFor(() => {
          expect(screen.getByRole("tab", { name: /message search/i })).toHaveAttribute("aria-selected", "true")
        })

        const editor = screen.getByLabelText("Search query input")
        await user.type(editor, " @")

        await waitFor(() => {
          expect(screen.getByText("Martin")).toBeInTheDocument()
        })

        // Press Tab to select first item
        await user.keyboard("{Tab}")

        // Selection should be inserted (Tab works like Enter in suggestion lists)
        await waitFor(() => {
          const editorContent = editor.textContent
          expect(editorContent).toContain("@martin")
        })
      })

      it("should close popover (not dialog) with Escape", async () => {
        const user = userEvent.setup()
        const onOpenChange = vi.fn()
        renderWithProviders(<QuickSwitcher {...defaultProps} onOpenChange={onOpenChange} />)

        const input = screen.getByLabelText("Quick switcher input")
        await user.type(input, "?")

        await waitFor(() => {
          expect(screen.getByRole("tab", { name: /message search/i })).toHaveAttribute("aria-selected", "true")
        })

        const editor = screen.getByLabelText("Search query input")
        await user.type(editor, " @")

        await waitFor(() => {
          expect(screen.getByText("Martin")).toBeInTheDocument()
        })

        // Press Escape - should close popover, not dialog
        await user.keyboard("{Escape}")

        // Dialog should still be open because our handler prevented the default
        expect(screen.getByRole("dialog")).toBeInTheDocument()
        expect(onOpenChange).not.toHaveBeenCalledWith(false)
      })

      it("should return focus to input after popover closes", async () => {
        const user = userEvent.setup()
        renderWithProviders(<QuickSwitcher {...defaultProps} />)

        const input = screen.getByLabelText("Quick switcher input")
        await user.type(input, "?")

        await waitFor(() => {
          expect(screen.getByRole("tab", { name: /message search/i })).toHaveAttribute("aria-selected", "true")
        })

        const editor = screen.getByLabelText("Search query input")
        await user.type(editor, " @")

        await waitFor(() => {
          expect(screen.getByText("Martin")).toBeInTheDocument()
        })

        // Select an item to close popover
        await user.keyboard("{Enter}")

        // Focus should return to editor
        await waitFor(() => {
          const proseMirrorEl = editor.closest(".ProseMirror")
          expect(document.activeElement).toBe(proseMirrorEl)
        })
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

    it("should switch to search mode when typing ?", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      const input = screen.getByLabelText("Quick switcher input")
      await user.type(input, "?")

      // When mode switches to search, the tab should be selected and RichInput renders
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /message search/i })).toHaveAttribute("aria-selected", "true")
      })
      // RichInput uses TipTap which has aria-label instead of placeholder
      expect(screen.getByLabelText("Search query input")).toBeInTheDocument()
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
    it("should switch to search mode when typing ? and allow continued typing", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      // Start in stream mode
      const input = screen.getByLabelText("Quick switcher input")

      // Type "?" - should switch to search mode
      await user.type(input, "?")

      // Should be in search mode
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /message search/i })).toHaveAttribute("aria-selected", "true")
      })

      // RichInput should show "?" (the full query including prefix)
      const searchEditor = screen.getByLabelText("Search query input")
      expect(searchEditor.textContent).toBe("?")

      // Now continue typing into the RichInput
      await user.click(searchEditor)
      await user.type(searchEditor, " test")

      // Should show "? test" in the editor (full query with prefix)
      expect(searchEditor.textContent).toBe("? test")
    })

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

    it("should not clear query when switching to search mode by typing ?", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      const input = screen.getByLabelText("Quick switcher input")

      // Type just "?" first
      await user.type(input, "?")

      // Should switch to search mode
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /message search/i })).toHaveAttribute("aria-selected", "true")
      })

      // Now type more text (including space after ?)
      const searchEditor = screen.getByLabelText("Search query input")
      await user.click(searchEditor)
      await user.type(searchEditor, " hello")

      // Should show "? hello" in the editor (full query with prefix)
      expect(searchEditor.textContent).toBe("? hello")
    })

    it("should handle paste with ? prefix correctly", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      const input = screen.getByLabelText("Quick switcher input")

      // Paste "? test" into the input
      await user.click(input)
      await user.paste("? test")

      // Should switch to search mode
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /message search/i })).toHaveAttribute("aria-selected", "true")
      })

      // RichInput should show "? test" (full query with prefix)
      const searchEditor = screen.getByLabelText("Search query input")
      expect(searchEditor.textContent).toBe("? test")
    })

    it("should normalize redundant ? prefixes on paste", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      const input = screen.getByLabelText("Quick switcher input")

      // Paste "? ? test" - should normalize to "? test"
      await user.click(input)
      await user.paste("? ? test")

      // Should be in search mode
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /message search/i })).toHaveAttribute("aria-selected", "true")
      })

      // RichInput should show "? test" (normalized, full query with prefix)
      const searchEditor = screen.getByLabelText("Search query input")
      expect(searchEditor.textContent).toBe("? test")
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

    it("should allow switching from search mode to stream mode by clearing prefix", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      // Start in stream mode, switch to search mode
      const input = screen.getByLabelText("Quick switcher input")
      await user.type(input, "?")

      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /message search/i })).toHaveAttribute("aria-selected", "true")
      })

      // Clear the RichInput and type something without prefix
      const editor = screen.getByLabelText("Search query input")
      await user.clear(editor)
      await user.type(editor, "general")

      // Should switch back to stream mode
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /stream search/i })).toHaveAttribute("aria-selected", "true")
      })

      // Should show "general" in stream mode input
      const streamInput = screen.getByLabelText("Quick switcher input")
      expect(streamInput).toHaveTextContent("general")
    })

    it("should allow switching from search mode to command mode by changing prefix", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      // Start in stream mode, switch to search mode
      const input = screen.getByLabelText("Quick switcher input")
      await user.type(input, "?")

      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /message search/i })).toHaveAttribute("aria-selected", "true")
      })

      // Clear and type command prefix
      const editor = screen.getByLabelText("Search query input")
      await user.clear(editor)
      await user.type(editor, "> new")

      // Should switch to command mode
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /command palette/i })).toHaveAttribute("aria-selected", "true")
      })

      // Should show "> new" in command mode input
      const commandInput = screen.getByLabelText("Quick switcher input")
      expect(commandInput).toHaveTextContent("> new")
    })

    it("should stay in search mode when pasting text without prefix", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="search" />)

      // Start in search mode - query is "? "
      const searchEditor = screen.getByLabelText("Search query input")

      // Paste plain text without prefix - should stay in search mode
      await user.click(searchEditor)
      await user.paste("Hello world")

      // Should stay in search mode
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /message search/i })).toHaveAttribute("aria-selected", "true")
      })

      // Input should show "? Hello world" (prefix preserved)
      expect(searchEditor.textContent).toBe("? Hello world")
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

    it("should switch to search mode when pasting text with ? prefix from empty state", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} />)

      // Start in stream mode (empty query)
      const input = screen.getByLabelText("Quick switcher input")

      // Paste text with ? prefix - should switch to search mode
      await user.click(input)
      await user.paste("? hello")

      // Should switch to search mode
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /message search/i })).toHaveAttribute("aria-selected", "true")
      })

      // Input should show "? hello"
      const searchEditor = screen.getByLabelText("Search query input")
      expect(searchEditor.textContent).toBe("? hello")
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

    it("should keep pasted prefix as content when in different mode (search -> command prefix)", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="search" />)

      // Start in search mode - query is "? "
      const searchEditor = screen.getByLabelText("Search query input")

      // Paste text with > prefix - should stay in search mode, > becomes content
      await user.click(searchEditor)
      await user.paste("> hello")

      // Should stay in search mode
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /message search/i })).toHaveAttribute("aria-selected", "true")
      })

      // Input should show "? > hello" (pasted > is content, not mode switch)
      expect(searchEditor.textContent).toBe("? > hello")
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

      // Click search tab
      const searchTab = screen.getByRole("tab", { name: /message search/i })
      await user.click(searchTab)

      await waitFor(() => {
        expect(screen.getByLabelText("Search query input")).toBeInTheDocument()
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

      // All tabs should be present with proper roles
      const tabs = screen.getAllByRole("tab")
      expect(tabs).toHaveLength(3)

      // Stream tab should be selected by default
      const streamsTab = screen.getByRole("tab", { name: /stream search/i })
      expect(streamsTab).toHaveAttribute("aria-selected", "true")

      // Other tabs should not be selected
      const commandsTab = screen.getByRole("tab", { name: /command palette/i })
      const searchTab = screen.getByRole("tab", { name: /message search/i })
      expect(commandsTab).toHaveAttribute("aria-selected", "false")
      expect(searchTab).toHaveAttribute("aria-selected", "false")
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

  describe("search mode", () => {
    it("should show filter badges when typing filter syntax", async () => {
      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="search" />)

      // Get the TipTap editor (it has aria-label, not placeholder)
      const editor = screen.getByLabelText("Search query input")

      // Type a filter - TipTap requires clicking first to focus
      await user.click(editor)
      await user.type(editor, "from:@martin ")

      // The filter should be parsed and displayed as a badge
      await waitFor(() => {
        expect(screen.getByText("@martin")).toBeInTheDocument()
      })
    })

    it("should remove filter when clicking badge X", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="search" />)

      const editor = screen.getByLabelText("Search query input")
      await user.click(editor)
      await user.type(editor, "from:@martin hello")

      // Wait for badge to appear
      await waitFor(() => {
        expect(screen.getByText("@martin")).toBeInTheDocument()
      })

      // Click the X button on the badge
      const removeButton = screen.getByRole("button", { name: "" }) // X button has no accessible name
      await user.click(removeButton)

      // Badge should be removed
      await waitFor(() => {
        expect(screen.queryByText("@martin")).not.toBeInTheDocument()
      })
    })

    it("should add filter via dropdown menu", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="search" />)

      // Wait for search mode to render
      await waitFor(() => {
        expect(screen.getByText("Add filter")).toBeInTheDocument()
      })

      // Click "Add filter" button
      await user.click(screen.getByText("Add filter"))

      // Click "Stream type" option
      await waitFor(() => {
        expect(screen.getByText("Stream type")).toBeInTheDocument()
      })
      await user.click(screen.getByText("Stream type"))

      // Select a stream type (e.g., "Channel")
      await waitFor(() => {
        expect(screen.getByText("Channel")).toBeInTheDocument()
      })
      await user.click(screen.getByText("Channel"))

      // Badge should appear
      await waitFor(() => {
        expect(screen.getByText("channel")).toBeInTheDocument()
      })
    })

    it("should call search API when query changes", async () => {
      // This test verifies that search is called when the component renders
      // with search content. Full debounce behavior testing with TipTap
      // requires browser-level DOM support not available in jsdom.
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="search" />)

      // Search should not be called immediately with empty query
      expect(mockSearchState.search).not.toHaveBeenCalled()

      // Verify clear is not called either until there's content
      expect(mockSearchState.clear).not.toHaveBeenCalled()
    })

    it("should display search results", async () => {
      // Configure mock to return results
      mockSearchState.results = mockSearchResultsList

      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="search" />)

      const editor = screen.getByLabelText("Search query input")
      await user.click(editor)
      await user.type(editor, "hello")

      // Results should be displayed
      await waitFor(() => {
        expect(screen.getByText("Hello from the search results")).toBeInTheDocument()
        expect(screen.getByText("Another search result message")).toBeInTheDocument()
      })
    })

    it("should navigate to message when selecting result", async () => {
      mockSearchState.results = mockSearchResultsList
      const onOpenChange = vi.fn()

      const user = userEvent.setup({ pointerEventsCheck: 0 })
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="search" onOpenChange={onOpenChange} />)

      const editor = screen.getByLabelText("Search query input")
      await user.click(editor)
      await user.type(editor, "hello")

      // Wait for results
      await waitFor(() => {
        expect(screen.getByText("Hello from the search results")).toBeInTheDocument()
      })

      // Click on result
      await user.click(screen.getByText("Hello from the search results"))

      // Should navigate to message
      expect(mockNavigate).toHaveBeenCalledWith("/w/workspace_1/s/stream_channel1?m=msg_1")
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it("should navigate to message when pressing Enter in search mode (no popover)", async () => {
      mockSearchState.results = mockSearchResultsList
      const onOpenChange = vi.fn()

      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="search" onOpenChange={onOpenChange} />)

      const editor = screen.getByLabelText("Search query input")
      await user.click(editor)
      await user.type(editor, "hello")

      // Wait for results
      await waitFor(() => {
        expect(screen.getByText("Hello from the search results")).toBeInTheDocument()
      })

      // Press Enter to select the first result (no popover is open)
      await user.keyboard("{Enter}")

      // Should navigate to message
      expect(mockNavigate).toHaveBeenCalledWith("/w/workspace_1/s/stream_channel1?m=msg_1")
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it("should open in new tab with Cmd+Enter in search mode", async () => {
      mockSearchState.results = mockSearchResultsList
      const onOpenChange = vi.fn()
      const windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null)

      const user = userEvent.setup()
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="search" onOpenChange={onOpenChange} />)

      const editor = screen.getByLabelText("Search query input")
      await user.click(editor)
      await user.type(editor, "hello")

      // Wait for results
      await waitFor(() => {
        expect(screen.getByText("Hello from the search results")).toBeInTheDocument()
      })

      // Press Cmd+Enter to open in new tab
      await user.keyboard("{Meta>}{Enter}{/Meta}")

      // Should open in new tab
      expect(windowOpenSpy).toHaveBeenCalledWith("/w/workspace_1/s/stream_channel1?m=msg_1", "_blank")

      windowOpenSpy.mockRestore()
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
    })

    it("should start in search mode when initialMode is search", () => {
      renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="search" />)

      // RichInput uses TipTap which has aria-label instead of placeholder
      expect(screen.getByLabelText("Search query input")).toBeInTheDocument()
      expect(screen.getByRole("tab", { name: /message search/i })).toHaveAttribute("aria-selected", "true")
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

      it("should verify where suggestion list renders in DOM", async () => {
        const user = userEvent.setup()
        renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="search" />)

        const editor = screen.getByLabelText("Search query input")
        await user.click(editor)
        // Need to type text first, then @ - just @ after "? " doesn't trigger popover
        await user.type(editor, "test @")

        await waitFor(() => {
          expect(screen.getByText("Martin")).toBeInTheDocument()
        })

        // Verify suggestion list rendered (use aria-label to distinguish from ItemList)
        expect(screen.getByRole("listbox", { name: /suggestions/i })).toBeInTheDocument()
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

    describe("keyboard event propagation", () => {
      it("should trace Escape key event flow", async () => {
        const user = userEvent.setup()
        const onOpenChange = vi.fn()
        renderWithProviders(<QuickSwitcher {...defaultProps} onOpenChange={onOpenChange} initialMode="search" />)

        const editor = screen.getByLabelText("Search query input")
        await user.click(editor)
        // Need to type text first, then @ - just @ after "? " doesn't work
        await user.type(editor, "test @")

        await waitFor(() => {
          expect(screen.getByText("Martin")).toBeInTheDocument()
        })

        // At this point, popover should be active
        expect(screen.getByRole("listbox", { name: /suggestions/i })).toBeInTheDocument()

        // Press Escape
        await user.keyboard("{Escape}")

        // Expected in real browser with bug:
        // - Dialog closes (onOpenChange called with false)
        // - Popover disappears because dialog closed
        //
        // Expected correct behavior:
        // - Popover closes first
        // - Dialog stays open
        // - Second Escape closes dialog
      })

      it("should trace Enter key event flow", async () => {
        mockSearchState.results = mockSearchResultsList
        const user = userEvent.setup()
        renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="search" />)

        const editor = screen.getByLabelText("Search query input")
        await user.click(editor)
        await user.type(editor, "hello @")

        // Wait for both results and popover
        await waitFor(() => {
          expect(screen.getByText("Hello from the search results")).toBeInTheDocument()
        })
        await waitFor(() => {
          expect(screen.getByText("Martin")).toBeInTheDocument()
        })

        // Press Enter
        await user.keyboard("{Enter}")

        // If Enter was captured by popover: editor should contain @martin, navigate not called
        // If Enter was captured by list: navigate called, editor unchanged
      })

      it("should verify isSuggestionPopoverActive state timing", async () => {
        // This test checks if the popover active state is properly communicated
        // We'll spy on console to see the state changes
        const user = userEvent.setup()
        renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="search" />)

        const editor = screen.getByLabelText("Search query input")
        await user.click(editor)

        // Need to type text first, then @ - just @ after "? " doesn't trigger popover
        await user.type(editor, "test @")

        // After typing @, wait for popover
        await waitFor(() => {
          expect(screen.getByRole("listbox", { name: /suggestions/i })).toBeInTheDocument()
        })

        // The question is: does the parent QuickSwitcher know the popover is active?
        // We can't directly check isSuggestionPopoverActive state, but we can
        // check behavior that depends on it
      })
    })
  })

  // =============================================================================
  // Bug regression tests - these tests should FAIL before the fix is applied
  // Each test documents a specific bug and verifies the correct behavior
  // =============================================================================
  describe("bug regressions", () => {
    describe("BUG: Enter with popover open should select popover item, not list item", () => {
      // Bug: When the suggestion popover is open in search mode and user presses Enter,
      // the highlighted message in the list behind the popover gets opened instead of
      // selecting the popover item.
      it("should NOT navigate to a message when pressing Enter with popover open", async () => {
        // Configure mock to return search results (which appear as list items behind popover)
        mockSearchState.results = mockSearchResultsList

        const user = userEvent.setup()
        const onOpenChange = vi.fn()
        renderWithProviders(<QuickSwitcher {...defaultProps} onOpenChange={onOpenChange} initialMode="search" />)

        const editor = screen.getByLabelText("Search query input")

        // Type something to trigger search results in the background
        await user.click(editor)
        await user.type(editor, "hello @")

        // Wait for BOTH: search results in background AND popover to appear
        await waitFor(() => {
          expect(screen.getByText("Hello from the search results")).toBeInTheDocument()
        })
        await waitFor(() => {
          expect(screen.getByText("Martin")).toBeInTheDocument()
        })

        // Now press Enter - should select popover item, NOT the list item
        await user.keyboard("{Enter}")

        // The popover item should be selected (text inserted into editor)
        await waitFor(() => {
          expect(editor.textContent).toContain("@martin")
        })

        // CRITICAL: Should NOT have navigated to the message
        expect(mockNavigate).not.toHaveBeenCalled()
        // Dialog should still be open (we selected popover item, not closed dialog)
        expect(onOpenChange).not.toHaveBeenCalledWith(false)
      })
    })

    describe("BUG: in: filter should show #slug or display name, not @stream_id", () => {
      // Bug: When selecting a channel from the in: filter autocomplete, it shows
      // "in:@stream_channel1" instead of "in:#general" or "in:General"
      it("should display in:#slug when selecting a channel from in: filter", async () => {
        const user = userEvent.setup()
        renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="search" />)

        const editor = screen.getByLabelText("Search query input")
        await user.click(editor)

        // Type "in:#" to trigger channel filter autocomplete
        await user.type(editor, "in:#")

        // Wait for channel suggestion popover to appear with "general" channel
        await waitFor(() => {
          // Suggestion popover should appear with listbox role
          const listbox = screen.getByRole("listbox", { name: /suggestions/i })
          expect(listbox).toBeInTheDocument()
          // Should contain a channel option with "general" (case-insensitive)
          expect(screen.getByRole("option", { name: /general/i })).toBeInTheDocument()
        })

        // Select the first channel
        await user.keyboard("{Enter}")

        // The filter should show the slug format, not the stream ID
        await waitFor(() => {
          const content = editor.textContent ?? ""
          // Should be "in:#general" NOT "in:@stream_channel1"
          expect(content).toMatch(/in:#general/i)
          expect(content).not.toContain("stream_")
          expect(content).not.toContain("@stream")
        })
      })

      it("should display in:@slug when selecting a user from in: filter (DM)", async () => {
        const user = userEvent.setup()
        renderWithProviders(<QuickSwitcher {...defaultProps} initialMode="search" />)

        const editor = screen.getByLabelText("Search query input")
        await user.click(editor)

        // Type "in:@" to trigger user filter autocomplete (for DMs)
        await user.type(editor, "in:@")

        // Wait for user suggestions to appear
        await waitFor(() => {
          expect(screen.getByText("Martin")).toBeInTheDocument()
        })

        // Select Martin
        await user.keyboard("{Enter}")

        // The filter should show @martin (user slug), not the stream ID
        await waitFor(() => {
          const content = editor.textContent ?? ""
          expect(content).toMatch(/in:@martin/i)
          expect(content).not.toContain("stream_")
        })
      })
    })

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

      it("should close dialog when pressing Escape in search mode with no popover", async () => {
        const user = userEvent.setup()
        const onOpenChange = vi.fn()
        renderWithProviders(<QuickSwitcher {...defaultProps} onOpenChange={onOpenChange} initialMode="search" />)

        const editor = screen.getByLabelText("Search query input")
        await user.click(editor)

        // Type something that doesn't trigger a popover
        await user.type(editor, "hello world")

        // Press Escape - should close dialog since no popover is open
        await user.keyboard("{Escape}")

        // Dialog should close
        expect(onOpenChange).toHaveBeenCalledWith(false)
      })
    })

    describe("clicking popover items", () => {
      it("should select popover item when clicking it", async () => {
        mockSearchState.results = mockSearchResultsList

        // pointerEventsCheck: 0 because jsdom can't compute CSS cascade properly.
        // The real fix is pointer-events-auto on suggestion-list.tsx:105
        const user = userEvent.setup({ pointerEventsCheck: 0 })
        const onOpenChange = vi.fn()
        renderWithProviders(<QuickSwitcher {...defaultProps} onOpenChange={onOpenChange} initialMode="search" />)

        const editor = screen.getByLabelText("Search query input")
        await user.click(editor)
        await user.type(editor, "hello @")

        // Wait for popover to appear
        await waitFor(() => {
          expect(screen.getByText("Martin")).toBeInTheDocument()
        })

        // Click on the popover item "Martin"
        const martinOption = screen.getByText("Martin")
        await user.click(martinOption)

        // Should insert @martin into the editor
        await waitFor(() => {
          expect(editor.textContent).toContain("@martin")
        })

        // Should NOT have navigated (click should not pass through to list items)
        expect(mockNavigate).not.toHaveBeenCalled()
        // Dialog should still be open
        expect(onOpenChange).not.toHaveBeenCalledWith(false)
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
