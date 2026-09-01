import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest"
import { spyOnExport } from "@/test/spy"
import { render, screen, act, waitFor } from "@testing-library/react"
import * as e2eSessionModule from "@/stores/e2e-session-store"
import * as decryptCacheModule from "@/lib/crypto/decrypt-cache"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ServicesProvider, type SavedService } from "@/contexts"
import { MessageEvent } from "./message-event"
import { TimelineItemContent, type TimelineItemRenderContext } from "./event-list"
import {
  clearStreams,
  clearWorkspaceActorTables,
  seedStream,
  seedWorkspaceUser,
  streamsTable,
  workspaceUsersTable,
} from "@/test/workspace-rows"
import { useStreamFromStore } from "@/stores/stream-store"
import { resetActorLookups } from "@/stores/actor-lookup"
import { resetWorkspaceStoreCache } from "@/stores/workspace-store"
import {
  getWorkspaceTableSnapshot,
  resetWorkspaceTableRegistry,
  subscribeWorkspaceTable,
} from "@/stores/workspace-table-registry"
import { EditLastMessageContext } from "./edit-last-message-context"
import * as editorModule from "@/components/editor"
import * as hooksModule from "@/hooks"
import * as prosemirrorModule from "@threa/prosemirror"
import * as syncEngineModule from "@/sync/sync-engine"
import * as contextsModule from "@/contexts"
import * as authModule from "@/auth"
import * as userProfileModule from "@/components/user-profile"
import * as connectionStatusModule from "@/components/layout/connection-status"
import userEvent from "@testing-library/user-event"
import type { StreamEvent } from "@threa/types"
import type { JSONContent } from "@threa/types"

// Configurable mock state for usePendingMessages — tests can override per-describe
let mockGetStatus: (id: string) => string | null = () => null
const mockRetryMessage = vi.fn()
const mockMarkEditing = vi.fn()
const mockDeleteMessage = vi.fn()
const mockSaveEditedMessage = vi.fn()
const mockCancelEditing = vi.fn()

const createMessageEvent = (messageId: string, contentMarkdown: string): StreamEvent => ({
  id: `event_${messageId}`,
  streamId: "stream_123",
  sequence: "1",
  eventType: "message_created",
  actorType: "user",
  actorId: "member_123",
  createdAt: new Date().toISOString(),
  payload: { messageId, contentMarkdown },
})

let queryClient: QueryClient

// Minimal SavedService shim — the tests don't exercise save/reminder flows,
// they just need the context lookup to succeed. `useLiveQuery` over
// fake-indexeddb returns null for an empty savedMessages store, which is
// exactly the "not saved" state these tests expect.
const noopSavedService: SavedService = {
  list: vi.fn().mockResolvedValue({ saved: [], nextCursor: null }),
  create: vi.fn().mockResolvedValue({}),
  update: vi.fn().mockResolvedValue({}),
  delete: vi.fn().mockResolvedValue(undefined),
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ServicesProvider services={{ saved: noopSavedService }}>
          <TooltipProvider>{children}</TooltipProvider>
        </ServicesProvider>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

function installDefaultSpies() {
  // RichEditor is a forwardRef object — use the "get" accessor to swap the export.
  spyOnExport(editorModule, "RichEditor").mockReturnValue((() => null) as unknown as typeof editorModule.RichEditor)
  vi.spyOn(editorModule, "DocumentEditorModal").mockImplementation(
    (() => null) as unknown as typeof editorModule.DocumentEditorModal
  )

  vi.spyOn(syncEngineModule, "useSyncEngine").mockReturnValue({
    kickOperationQueue: vi.fn(),
  } as unknown as ReturnType<typeof syncEngineModule.useSyncEngine>)

  vi.spyOn(contextsModule, "usePendingMessages").mockReturnValue({
    getStatus: (id: string) => mockGetStatus(id),
    markPending: vi.fn(),
    markFailed: vi.fn(),
    markSent: vi.fn(),
    markEditing: mockMarkEditing,
    saveEditedMessage: mockSaveEditedMessage,
    cancelEditing: mockCancelEditing,
    retryMessage: mockRetryMessage,
    deleteMessage: mockDeleteMessage,
    notifyQueue: vi.fn(),
    registerQueueNotify: vi.fn(),
  } as unknown as ReturnType<typeof contextsModule.usePendingMessages>)
  vi.spyOn(contextsModule, "usePanel").mockReturnValue({
    panelId: null,
    getPanelUrl: (streamId: string) => `/panel/${streamId}`,
  } as unknown as ReturnType<typeof contextsModule.usePanel>)
  vi.spyOn(contextsModule, "useTrace").mockReturnValue({
    getTraceUrl: (sessionId: string) => `/trace/${sessionId}`,
  } as unknown as ReturnType<typeof contextsModule.useTrace>)
  vi.spyOn(contextsModule, "useMediaGallery").mockReturnValue({
    mediaAttachmentId: null,
    openMedia: vi.fn(),
    closeMedia: vi.fn(),
  } as unknown as ReturnType<typeof contextsModule.useMediaGallery>)
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { timezone: "UTC", locale: "en-US" },
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  vi.spyOn(contextsModule, "useMessageService").mockReturnValue({
    delete: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue({}),
    getVersions: vi.fn().mockResolvedValue([]),
  } as unknown as ReturnType<typeof contextsModule.useMessageService>)

  vi.spyOn(authModule, "useUser").mockReturnValue({ id: "workos_user_123" } as ReturnType<typeof authModule.useUser>)
  vi.spyOn(userProfileModule, "useUserProfile").mockReturnValue({
    openUserProfile: vi.fn(),
  } as unknown as ReturnType<typeof userProfileModule.useUserProfile>)

  vi.spyOn(hooksModule, "useActors").mockReturnValue({
    getActorName: (_actorId: string | null, actorType: string | null) => {
      if (actorType === "persona") return "Ariadne"
      return "Test User"
    },
    getActorAvatar: (_actorId: string | null, actorType: string | null) => {
      if (actorType === "persona") return { fallback: "🜃", slug: "ariadne" }
      return { fallback: "TU", slug: undefined }
    },
  } as unknown as ReturnType<typeof hooksModule.useActors>)
  vi.spyOn(hooksModule, "useWorkspaceBootstrap").mockReturnValue({
    data: { users: [{ id: "member_123", workosUserId: "workos_user_123" }] },
  } as unknown as ReturnType<typeof hooksModule.useWorkspaceBootstrap>)
  vi.spyOn(hooksModule, "useWorkspaceUserId").mockReturnValue("member_123")
  vi.spyOn(hooksModule, "focusAtEnd").mockImplementation(() => undefined)
}

beforeEach(() => {
  vi.restoreAllMocks()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mockGetStatus = () => null // default: sent/confirmed message
  mockRetryMessage.mockReset()
  mockMarkEditing.mockReset()
  mockDeleteMessage.mockReset()
  mockSaveEditedMessage.mockReset()
  mockCancelEditing.mockReset()
  installDefaultSpies()
})

describe("MessageEvent", () => {
  const workspaceId = "ws_123"
  const streamId = "stream_123"

  describe("highlight animation", () => {
    it("should apply highlight animation when isHighlighted is true", () => {
      const event = createMessageEvent("msg_123", "Highlighted message")

      const { container } = render(
        <MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} isHighlighted={true} />,
        { wrapper: Wrapper }
      )

      const messageContainer = container.querySelector(".message-item")
      expect(messageContainer).toHaveClass("animate-highlight-flash")
    })

    it("should not apply highlight animation by default", () => {
      const event = createMessageEvent("msg_123", "Normal message")

      const { container } = render(<MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />, {
        wrapper: Wrapper,
      })

      const messageContainer = container.querySelector(".message-item")
      expect(messageContainer).not.toHaveClass("animate-highlight-flash")
    })
  })

  describe("provenance chip", () => {
    it("renders a revival chip linking to the conversation panel", () => {
      const event = createMessageEvent("msg_123", "Pizza")

      render(
        <MessageEvent
          event={event}
          workspaceId={workspaceId}
          streamId={streamId}
          revival={{
            conversationId: "conv_a",
            streamId: "stream_1",
            topicSummary: "Pizza",
            previousActivityAt: "2026-06-01T00:00:00.000Z",
          }}
        />,
        { wrapper: Wrapper }
      )

      const chip = screen.getByRole("link", { name: /continues pizza/i })
      expect(chip).toHaveAttribute("href", "/panel/conv:conv_a")
    })

    it("renders no chip when the message is not a revival", () => {
      const event = createMessageEvent("msg_123", "Pizza")

      render(<MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />, { wrapper: Wrapper })

      expect(screen.queryByRole("link", { name: /continues/i })).not.toBeInTheDocument()
    })

    it("still renders the chip on a grouped continuation (footer, both row types)", () => {
      const event = createMessageEvent("msg_123", "Pizza")

      render(
        <MessageEvent
          event={event}
          workspaceId={workspaceId}
          streamId={streamId}
          groupContinuation
          revival={{
            conversationId: "conv_a",
            streamId: "stream_1",
            topicSummary: "Pizza",
            previousActivityAt: "2026-06-01T00:00:00.000Z",
          }}
        />,
        { wrapper: Wrapper }
      )

      expect(screen.getByRole("link", { name: /continues pizza/i })).toHaveAttribute("href", "/panel/conv:conv_a")
    })

    it("renders the chip without a time tail when previousActivityAt is unknown (block start, nothing locally loaded)", () => {
      const event = createMessageEvent("msg_123", "Pizza")

      render(
        <MessageEvent
          event={event}
          workspaceId={workspaceId}
          streamId={streamId}
          revival={{
            conversationId: "conv_a",
            streamId: "stream_1",
            topicSummary: "Pizza",
            previousActivityAt: undefined,
          }}
        />,
        { wrapper: Wrapper }
      )

      const chip = screen.getByRole("link", { name: /continues pizza/i })
      expect(chip).toHaveAttribute("href", "/panel/conv:conv_a")
      // No dangling "·" separator when there's no time to pair it with.
      expect(chip).not.toHaveTextContent("·")
    })
  })

  describe("content rendering", () => {
    it("should render message content", () => {
      const event = createMessageEvent("msg_123", "Hello, world!")

      render(<MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />, { wrapper: Wrapper })

      expect(screen.getByText("Hello, world!")).toBeInTheDocument()
    })

    it("should render actor name", () => {
      const event = createMessageEvent("msg_123", "Test message")

      render(<MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />, { wrapper: Wrapper })

      expect(screen.getByText("Test User")).toBeInTheDocument()
    })

    it("should render persona name for AI messages", () => {
      const event: StreamEvent = {
        ...createMessageEvent("msg_123", "AI response"),
        actorType: "persona",
        actorId: "persona_ariadne",
      }

      render(<MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />, { wrapper: Wrapper })

      expect(screen.getByText("Ariadne")).toBeInTheDocument()
    })
  })

  describe("reactions", () => {
    it("should render reaction pills when reactions are present", () => {
      const event: StreamEvent = {
        ...createMessageEvent("msg_123", "Reacted message"),
        payload: {
          messageId: "msg_123",
          contentMarkdown: "Reacted message",
          reactions: { "+1": ["member_123"], heart: ["member_456"] },
        },
      }

      render(<MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />, { wrapper: Wrapper })

      const buttons = screen.getAllByRole("button")
      const reactionButtons = buttons.filter((b) => b.textContent?.match(/\d$/))
      expect(reactionButtons.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe("visual differentiation", () => {
    it("should render Ariadne SVG icon for persona messages", () => {
      const event: StreamEvent = {
        ...createMessageEvent("msg_123", "AI response"),
        actorType: "persona",
        actorId: "persona_ariadne",
      }

      const { container } = render(<MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />, {
        wrapper: Wrapper,
      })

      const ariadneIcon = container.querySelector('svg[aria-label="Ariadne"]')
      expect(ariadneIcon).toBeInTheDocument()
    })

    it("should render user initials for user messages", () => {
      const event = createMessageEvent("msg_123", "User message")

      render(<MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />, { wrapper: Wrapper })

      expect(screen.getByText("TU")).toBeInTheDocument()
    })

    it("should apply gold accent styling to persona messages", () => {
      const event: StreamEvent = {
        ...createMessageEvent("msg_123", "AI response"),
        actorType: "persona",
      }

      const { container } = render(<MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />, {
        wrapper: Wrapper,
      })

      const messageContainer = container.querySelector(".message-item")
      expect(messageContainer).toHaveClass("bg-gradient-to-r")
      expect(messageContainer).toHaveClass("from-primary/[0.06]")
    })

    it("should not apply gold styling to user messages", () => {
      const event = createMessageEvent("msg_123", "User message")

      const { container } = render(<MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />, {
        wrapper: Wrapper,
      })

      const messageContainer = container.querySelector(".message-item")
      expect(messageContainer).not.toHaveClass("bg-gradient-to-r")
      expect(messageContainer).not.toHaveClass("from-primary/[0.06]")
    })
  })

  describe("ArrowUp edit-last-message trigger", () => {
    beforeAll(() => {
      // Nothing — per-test beforeEach installs default spies; these tests
      // override the RichEditor to an interactive textarea and re-install
      // prosemirror impls because the suite-level beforeEach restoreAllMocks
      // clears them.
    })

    afterAll(() => {
      vi.restoreAllMocks()
    })

    function installInteractiveEditor() {
      spyOnExport(editorModule, "RichEditor").mockReturnValue((({
        value,
        onChange,
        onSubmit,
        placeholder,
      }: {
        value: JSONContent
        onChange: (v: JSONContent) => void
        onSubmit: () => void
        placeholder?: string
      }) => (
        <textarea
          data-testid="rich-editor"
          defaultValue={JSON.stringify(value)}
          placeholder={placeholder}
          onChange={(e) => {
            try {
              onChange(JSON.parse(e.target.value))
            } catch {
              /* ignore */
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              onSubmit()
            }
          }}
        />
      )) as unknown as typeof editorModule.RichEditor)
      vi.spyOn(prosemirrorModule, "serializeToMarkdown").mockImplementation((json) => {
        return json.content?.[0]?.content?.[0]?.text ?? ""
      })
      vi.spyOn(prosemirrorModule, "parseMarkdown").mockImplementation(
        (md) =>
          ({
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: md }] }],
          }) as ReturnType<typeof prosemirrorModule.parseMarkdown>
      )
    }

    it("registers an edit handler and opens inline edit when it is called", async () => {
      installInteractiveEditor()
      const event = createMessageEvent("msg_edit", "Hello world")
      const queryClientLocal = new QueryClient({ defaultOptions: { queries: { retry: false } } })

      let capturedHandler: (() => void) | undefined
      const registerMessage = vi.fn((_messageId: string, handler: () => void) => {
        capturedHandler = handler
        return () => {}
      })

      render(
        <MemoryRouter>
          <QueryClientProvider client={queryClientLocal}>
            <ServicesProvider services={{ saved: noopSavedService }}>
              <TooltipProvider>
                <EditLastMessageContext.Provider value={{ registerMessage, triggerEditLast: vi.fn() }}>
                  <MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />
                </EditLastMessageContext.Provider>
              </TooltipProvider>
            </ServicesProvider>
          </QueryClientProvider>
        </MemoryRouter>
      )

      expect(registerMessage).toHaveBeenCalledWith("msg_edit", expect.any(Function))

      expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()

      await act(async () => {
        capturedHandler?.()
      })
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
    })

    it("does not open edit form when context is absent", () => {
      installInteractiveEditor()
      const event = createMessageEvent("msg_edit", "Hello world")

      render(<MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />, { wrapper: Wrapper })

      expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
    })

    it("restores focus to the visible zone editor after canceling inline edit", async () => {
      installInteractiveEditor()
      const event = createMessageEvent("msg_edit", "Hello world")
      const queryClientLocal = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      const focusAtEnd = vi.mocked(hooksModule.focusAtEnd)
      focusAtEnd.mockClear()

      let capturedHandler: (() => void) | undefined
      const registerMessage = vi.fn((_messageId: string, handler: () => void) => {
        capturedHandler = handler
        return () => {}
      })

      render(
        <div data-editor-zone="main">
          <div data-testid="zone-editor" contentEditable />
          <MemoryRouter>
            <QueryClientProvider client={queryClientLocal}>
              <ServicesProvider services={{ saved: noopSavedService }}>
                <TooltipProvider>
                  <EditLastMessageContext.Provider value={{ registerMessage, triggerEditLast: vi.fn() }}>
                    <MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />
                  </EditLastMessageContext.Provider>
                </TooltipProvider>
              </ServicesProvider>
            </QueryClientProvider>
          </MemoryRouter>
        </div>
      )

      const zoneEditor = screen.getByTestId("zone-editor")
      const rects = {
        length: 1,
        item: (index: number) => (index === 0 ? ({ width: 1, height: 1 } as DOMRect) : null),
        0: { width: 1, height: 1 } as DOMRect,
      } as unknown as DOMRectList
      vi.spyOn(zoneEditor, "getClientRects").mockReturnValue(rects)
      vi.spyOn(zoneEditor, "getBoundingClientRect").mockReturnValue({
        top: 100,
        bottom: 140,
        left: 0,
        right: 300,
      } as DOMRect)
      vi.spyOn(zoneEditor, "getBoundingClientRect").mockReturnValue({
        top: 100,
        bottom: 140,
        left: 0,
        right: 300,
      } as DOMRect)

      await act(async () => {
        capturedHandler?.()
      })

      await act(async () => {
        screen.getByRole("button", { name: "Cancel" }).click()
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      })

      expect(focusAtEnd).toHaveBeenCalledWith(zoneEditor)
    })
  })

  describe("pending message", () => {
    beforeEach(() => {
      vi.spyOn(connectionStatusModule, "useIsOnline").mockReturnValue(true)
    })

    it("should not show a sending indicator initially when online", () => {
      mockGetStatus = () => "pending"
      const event = createMessageEvent("msg_pending", "Pending message")

      render(<MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />, { wrapper: Wrapper })

      expect(screen.queryByText("Sending...")).not.toBeInTheDocument()
      expect(screen.queryByText("Waiting to send")).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument()
    })

    it("should show Sending indicator once the slow threshold has elapsed", () => {
      mockGetStatus = () => "pending"
      const event = {
        ...createMessageEvent("msg_pending", "Pending message"),
        createdAt: new Date(Date.now() - 6000).toISOString(),
      }

      render(<MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />, { wrapper: Wrapper })

      expect(screen.getByText("Sending...")).toBeInTheDocument()
    })

    it("should show Waiting to send immediately when offline", () => {
      vi.spyOn(connectionStatusModule, "useIsOnline").mockReturnValue(false)
      mockGetStatus = () => "pending"
      const event = createMessageEvent("msg_pending", "Pending message")

      render(<MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />, { wrapper: Wrapper })

      expect(screen.getByText("Waiting to send")).toBeInTheDocument()
      expect(screen.queryByText("Sending...")).not.toBeInTheDocument()
    })

    it("should call markEditing when Edit is clicked", async () => {
      mockGetStatus = () => "pending"
      mockMarkEditing.mockResolvedValue(undefined)
      const event = createMessageEvent("msg_pending", "Pending message")

      render(<MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />, { wrapper: Wrapper })

      await userEvent.click(screen.getByRole("button", { name: "Edit" }))
      expect(mockMarkEditing).toHaveBeenCalledWith(event.id)
    })

    it("should call deleteMessage when Delete is clicked", async () => {
      mockGetStatus = () => "pending"
      mockDeleteMessage.mockResolvedValue(undefined)
      const event = createMessageEvent("msg_pending", "Pending message")

      render(<MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />, { wrapper: Wrapper })

      await userEvent.click(screen.getByRole("button", { name: "Delete" }))
      expect(mockDeleteMessage).toHaveBeenCalledWith(event.id)
    })
  })

  describe("failed message", () => {
    it("should show Failed indicator and Retry/Edit/Delete buttons", () => {
      mockGetStatus = () => "failed"
      const event = createMessageEvent("msg_failed", "Failed message")

      render(<MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />, { wrapper: Wrapper })

      expect(screen.getByText("Failed to send")).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument()
    })

    it("should call retryMessage when Retry is clicked", async () => {
      mockGetStatus = () => "failed"
      mockRetryMessage.mockResolvedValue(undefined)
      const event = createMessageEvent("msg_failed", "Failed message")

      render(<MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />, { wrapper: Wrapper })

      await userEvent.click(screen.getByRole("button", { name: "Retry" }))
      expect(mockRetryMessage).toHaveBeenCalledWith(event.id)
    })

    it("should call markEditing when Edit is clicked on failed message", async () => {
      mockGetStatus = () => "failed"
      mockMarkEditing.mockResolvedValue(undefined)
      const event = createMessageEvent("msg_failed", "Failed message")

      render(<MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />, { wrapper: Wrapper })

      await userEvent.click(screen.getByRole("button", { name: "Edit" }))
      expect(mockMarkEditing).toHaveBeenCalledWith(event.id)
    })
  })

  describe("editing message", () => {
    it("should show editing indicator when status is editing", () => {
      mockGetStatus = () => "editing"
      const event = createMessageEvent("msg_editing", "Editing message")

      render(<MessageEvent event={event} workspaceId={workspaceId} streamId={streamId} />, { wrapper: Wrapper })

      expect(screen.getByText("Editing unsent message")).toBeInTheDocument()
    })
  })
})

describe("row-tree read fan-out", () => {
  const workspaceId = "ws_123"
  const streamId = "stream_123"

  function makeCtx(): TimelineItemRenderContext {
    return {
      workspaceId,
      streamId,
      sessionLiveCounts: new Map(),
      sessionLiveSubsteps: new Map(),
      cancelledFollowUpIds: new Set(),
      delegationStatusPatches: new Map(),
      subagentStatusPatches: new Map(),
      botAccessStatusPatches: new Map(),
      callEndedPatches: new Map(),
    }
  }

  const rowEvents = Array.from({ length: 50 }, (_, i) => createMessageEvent(`msg_${i}`, `row ${i}`))

  beforeEach(async () => {
    resetWorkspaceTableRegistry()
    resetWorkspaceStoreCache()
    resetActorLookups()
    await clearWorkspaceActorTables()
    await seedWorkspaceUser(workspaceId, "member_123")
  })

  afterEach(() => {
    resetWorkspaceTableRegistry()
    resetActorLookups()
  })

  it("a fifty-row window opens one users read, not fifty", async () => {
    // The real lookup, not the suite's stub: this test is about what the row
    // tree reads from IDB.
    vi.spyOn(hooksModule, "useActors").mockRestore()
    const where = vi.spyOn(workspaceUsersTable(), "where")

    render(
      <>
        {rowEvents.map((event) => (
          <MessageEvent key={event.id} event={event} workspaceId={workspaceId} streamId={streamId} />
        ))}
      </>,
      { wrapper: Wrapper }
    )
    await screen.findAllByText("row 0")

    expect(where).toHaveBeenCalledTimes(1)
  })

  // Runs under the suite's stubbed `useActors`, so it covers the pre-existing
  // per-item row memo (#835), not the actor-lookup registry.
  it("an incoming message re-renders the new row only", async () => {
    const renders = new Map<string, number>()
    mockGetStatus = (id: string) => {
      renders.set(id, (renders.get(id) ?? 0) + 1)
      return null
    }

    const rows = (events: StreamEvent[], ctx: TimelineItemRenderContext) => (
      <>
        {events.map((event) => (
          <TimelineItemContent
            key={event.id}
            item={{ type: "event", event }}
            ctx={ctx}
            deferSecondaryHydration={false}
          />
        ))}
      </>
    )

    const { rerender } = render(rows(rowEvents, makeCtx()), { wrapper: Wrapper })
    await screen.findAllByText("row 0")
    const before = new Map(renders)

    const incoming = createMessageEvent("msg_new", "row new")
    // A fresh ctx per data tick is what production does — the memo compares
    // per-item content, not container identity.
    rerender(rows([...rowEvents, incoming], makeCtx()))
    await screen.findByText("row new")

    const rerendered = [...renders.entries()].filter(([id, count]) => count !== (before.get(id) ?? 0))
    expect(rerendered.map(([id]) => id)).toEqual([incoming.id])
  })
})

describe("MessageEvent stream-row reads", () => {
  const workspaceId = "ws_123"
  const streamId = "stream_123"

  function StreamRowProbe() {
    return <span data-testid="stream-row-probe">{useStreamFromStore(streamId)?.displayName ?? "unresolved"}</span>
  }

  const rootStreamId = "stream_root"

  async function primeStreamRegistry(): Promise<() => void> {
    const unsubscribe = subscribeWorkspaceTable(workspaceId, "streams", () => {})
    await waitFor(() => expect(getWorkspaceTableSnapshot(workspaceId, "streams")).toBeDefined())
    return unsubscribe
  }

  function sealedEvent(): StreamEvent {
    return {
      id: "event_sealed",
      streamId,
      sequence: "1",
      eventType: "message_created",
      actorType: "user",
      actorId: "member_123",
      createdAt: new Date().toISOString(),
      payload: {
        messageId: "msg_sealed",
        ciphertext: "abc",
        envelope: { v: 2, keyGeneration: 1, iv: "x", aad: "y" },
        contentMarkdown: "",
      },
    }
  }

  let release: (() => void) | null = null

  beforeEach(async () => {
    resetWorkspaceTableRegistry()
    resetWorkspaceStoreCache()
    resetActorLookups()
    await clearWorkspaceActorTables()
    await seedWorkspaceUser(workspaceId, "member_123")
    await clearStreams()
  })

  afterEach(() => {
    release?.()
    release = null
    resetWorkspaceTableRegistry()
    resetActorLookups()
  })

  it("a fifty-row window opens no per-row db.streams.get", async () => {
    await seedStream(workspaceId, streamId, { displayName: "Seeded Channel" })
    release = await primeStreamRegistry()
    const get = vi.spyOn(streamsTable(), "get")

    const events = Array.from({ length: 50 }, (_, i) => createMessageEvent(`msg_${i}`, `row ${i}`))
    render(
      <>
        <StreamRowProbe />
        {events.map((event) => (
          <MessageEvent key={event.id} event={event} workspaceId={workspaceId} streamId={streamId} />
        ))}
      </>,
      { wrapper: Wrapper }
    )
    await screen.findAllByText("row 0")

    // Stream-derived output, so a hook that resolved nothing fails this test on
    // correctness rather than passing it on a vacuous zero read count.
    expect(await screen.findByTestId("stream-row-probe")).toHaveTextContent("Seeded Channel")
    expect(get).not.toHaveBeenCalled()
  })

  it("an E2E row still holds at pending until its stream row hydrates", async () => {
    release = await primeStreamRegistry()
    vi.spyOn(e2eSessionModule, "useE2eSession").mockReturnValue({
      status: "unlocked",
      privateKey: {} as CryptoKey,
      keyId: "key_1",
    } as unknown as ReturnType<typeof e2eSessionModule.useE2eSession>)
    vi.spyOn(decryptCacheModule, "getCachedDecryption").mockReturnValue(undefined)
    const requestDecryption = vi
      .spyOn(decryptCacheModule, "requestDecryption")
      .mockResolvedValue(undefined as unknown as never)

    const { container } = render(<MessageEvent event={sealedEvent()} workspaceId={workspaceId} streamId={streamId} />, {
      wrapper: Wrapper,
    })

    // Row absent from the registry AND from IDB: the only correct answer is
    // "hold" — a decrypt against the bare stream id caches its failure forever.
    await waitFor(() => expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument())
    expect(container.querySelector(".message-item")).not.toBeInTheDocument()
    expect(requestDecryption).not.toHaveBeenCalled()

    await seedStream(workspaceId, streamId, { rootStreamId })

    await waitFor(() => expect(requestDecryption).toHaveBeenCalled())
    expect(requestDecryption.mock.calls[0][2]).toMatchObject({ streamId, rootStreamId })
  })
})
