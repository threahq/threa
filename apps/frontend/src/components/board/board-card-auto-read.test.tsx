import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, act } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardPostMessage } from "@threahq/types"
import { BoardCard } from "./board-card"
import type { BoardViewPost } from "@/hooks/use-stable-board-view"
import { ServicesProvider, PanelProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import { __clearBoardRailRegistry } from "@/hooks/use-board-card-messages"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as messageReactionsModule from "@/hooks/use-message-reactions"
import * as userProfileModule from "@/components/user-profile"
import * as syncEngineModule from "@/sync/sync-engine"
import * as contextsModule from "@/contexts"
import * as queueDraftModule from "@/hooks/use-queue-draft-message"

const WS = "ws_1"
const STREAM = "stream_1"

function openingMessage(overrides: Partial<BoardPostMessage> = {}): BoardPostMessage {
  return {
    id: "m_open",
    streamId: STREAM,
    authorId: "usr_other",
    authorType: "user",
    contentMarkdown: "Opening body.",
    reactions: {},
    attachments: [],
    linkPreviews: [],
    createdAt: "2026-06-22T12:00:00.000Z",
    editedAt: null,
    ...overrides,
  }
}

function makePost(): BoardViewPost {
  const opening = openingMessage()
  return {
    id: "conv_1",
    workspaceId: WS,
    _lastActivityMs: 0,
    _cachedAt: 0,
    streamIds: [STREAM],
    conversation: {
      id: "conv_1",
      streamId: STREAM,
      messageIds: ["m_open"],
      lastActivityAt: "2026-06-22T12:00:00.000Z",
    },
    openingMessage: opening,
    recentMessages: [],
    totalReplies: 0,
  } as unknown as BoardViewPost
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  observed = new Set<Element>()
  constructor(private callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this)
  }
  observe(el: Element) {
    this.observed.add(el)
  }
  unobserve(el: Element) {
    this.observed.delete(el)
  }
  disconnect() {
    this.observed.clear()
  }
  fire(entries: Array<{ target: Element; isIntersecting: boolean }>) {
    this.callback(entries as unknown as IntersectionObserverEntry[], this as unknown as IntersectionObserver)
  }
}

// The card's ledger wants the whole conversation window, so it arms the backfill
// whenever the local rail is short — the harness answers it (an absent method
// would throw inside the query, off the test's own await path).
const getBoardMessages = vi.fn().mockResolvedValue([])
const markRead = vi.fn().mockResolvedValue({ streams: [] })
const markUnread = vi.fn().mockResolvedValue({ streams: [] })

function mountCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ServicesProvider services={{ conversations: { markRead, markUnread, getBoardMessages } as never }}>
          <MemoryRouter initialEntries={[`/w/${WS}/board`]}>
            <PanelProvider>
              <BoardCard workspaceId={WS} post={makePost()} contextLabel="#general" streamType="channel" />
            </PanelProvider>
          </MemoryRouter>
        </ServicesProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
  FakeIntersectionObserver.instances = []
  markRead.mockClear()
  markUnread.mockClear()
  __clearBoardRailRegistry()
  // Focused, visible desktop page.
  vi.spyOn(document, "hasFocus").mockReturnValue(true)

  // REAL controller derivation: the stream has unread (count 2), the viewer's
  // watermark timestamp predates the opening message, no overlay.
  vi.spyOn(workspaceStoreModule, "useWorkspaceUnreadState").mockReturnValue({
    workspaceId: WS,
    unreadCounts: { [STREAM]: 2 },
    mentionCounts: {},
    messageCounts: { [STREAM]: 5 },
    readMessageIds: {},
  } as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreamMemberships").mockReturnValue([
    {
      id: `${WS}:${STREAM}`,
      workspaceId: WS,
      streamId: STREAM,
    },
  ] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreamReadStates").mockReturnValue([
    {
      id: `${WS}:${STREAM}`,
      workspaceId: WS,
      streamId: STREAM,
      lastReadSequence: "1",
      lastReadAt: "2026-06-20T00:00:00.000Z",
      lastReadEventId: "evt_old",
    },
  ] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceMetadata").mockReturnValue(undefined as never)
  vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue("usr_me")
  // BoardCard hosts the inline branch composer, whose queue hook needs the
  // pending-messages provider — stub the hook so the harness stays lean.
  vi.spyOn(queueDraftModule, "useQueueDraftMessage").mockReturnValue({
    queueDraftMessage: vi.fn().mockResolvedValue({ clientId: "client_1" }),
    currentUserId: "usr_me",
  } as unknown as ReturnType<typeof queueDraftModule.useQueueDraftMessage>)
  vi.spyOn(messageReactionsModule, "useMessageReactions").mockReturnValue({
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    toggleReaction: vi.fn(),
    toggleByEmoji: vi.fn(),
  } as unknown as ReturnType<typeof messageReactionsModule.useMessageReactions>)
  vi.spyOn(userProfileModule, "useUserProfile").mockReturnValue({ openUserProfile: vi.fn() })
  vi.spyOn(syncEngineModule, "useSyncEngine").mockReturnValue({
    setBoardStreamIds: vi.fn(),
  } as unknown as ReturnType<typeof syncEngineModule.useSyncEngine>)
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { timezone: "UTC", locale: "en-US" },
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
})

afterEach(() => {
  // Unmount BEFORE the mocks are restored: the card's backfill settles
  // asynchronously, and a still-mounted card re-rendering against restored (real)
  // hooks blows up on the hook-count difference.
  cleanup()
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("BoardCard viewport auto-read (full wiring: real card, real controller, real hook)", () => {
  it("marks the conversation read after the opening row dwells in the viewport", async () => {
    mountCard()
    await act(async () => {})
    expect(screen.getByText("Opening body.")).toBeTruthy()

    const rowEl = document.querySelector('[data-message-row][data-message-id="m_open"]')
    expect(rowEl, "the opening row should carry data-message-row").toBeTruthy()
    // The card constructs several observers (auto-read rows, visible-streams
    // viewport gate) — pick the one actually watching the opening row.
    const io = FakeIntersectionObserver.instances.find((instance) => instance.observed.has(rowEl!))
    expect(io, "an IntersectionObserver should be observing the opening row").toBeTruthy()

    act(() => {
      io!.fire([{ target: rowEl!, isIntersecting: true }])
    })
    act(() => {
      vi.advanceTimersByTime(1_100) // dwell
    })
    act(() => {
      vi.advanceTimersByTime(2_100) // debounce
    })

    expect(markRead).toHaveBeenCalledWith(WS, "conv_1", "m_open")
  })
})
