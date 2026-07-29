import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Socket } from "socket.io-client"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardPostMessage } from "@threa/types"
import { BoardCard } from "./board-card"
import type { BoardViewPost } from "@/hooks/use-stable-board-view"
import { ServicesProvider, PanelProvider, TraceProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import { __clearBoardRailRegistry } from "@/hooks/use-board-card-messages"
import { __clearConversationGraphRegistry } from "@/hooks/use-conversation-graph"
import { __resetCollapseCacheForTests } from "@/lib/markdown/collapse-cache"
// eslint-disable-next-line no-restricted-imports -- test seeds IDB directly to drive the real rail read path
import { db, type CachedEvent } from "@/db"
import * as conversationReadModule from "@/components/message/conversation-read-context"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as messageReactionsModule from "@/hooks/use-message-reactions"
import * as userProfileModule from "@/components/user-profile"
import * as syncEngineModule from "@/sync/sync-engine"
import * as contextsModule from "@/contexts"
import * as queueDraftModule from "@/hooks/use-queue-draft-message"
import * as inlineComposerModule from "@/components/board/board-inline-composer"
import * as inputModeModule from "@/hooks/use-input-mode"
import { setBoardFlash, resetBoardFlashStoreCache } from "@/stores/board-flash-store"
import { spyOnExport } from "@/test/spy"
import { MESSAGE_ROW_HEAD_PADDING } from "@/components/message/message-row-layout"
import { formatDayDivider, localStartOfDayMs } from "@/lib/dates"

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

function makePost(
  conversation: Record<string, unknown> = {},
  openingOverrides: Partial<BoardPostMessage> = {}
): BoardViewPost {
  const opening = openingMessage(openingOverrides)
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
      ...conversation,
    },
    openingMessage: opening,
    recentMessages: [],
    totalReplies: 0,
  } as unknown as BoardViewPost
}

function mountCard(post: BoardViewPost = makePost(), conversations: Record<string, unknown> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ServicesProvider services={{ conversations: conversations as never }}>
          <MemoryRouter initialEntries={[`/w/${WS}/board`]}>
            <TraceProvider>
              <PanelProvider>
                <BoardCard workspaceId={WS} post={post} contextLabel="#general" streamType="channel" />
              </PanelProvider>
            </TraceProvider>
          </MemoryRouter>
        </ServicesProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

/** A minimal cached agent-session event on the card's stream, seeded into IDB so
 *  the card's rail picks it up like the timeline does. */
function sessionEvent(
  eventType: "agent_session:started" | "agent_session:completed" | "agent_session:interrupted",
  seconds: number,
  payload: Record<string, unknown>
): CachedEvent {
  return {
    id: `${eventType}_${seconds}`,
    workspaceId: WS,
    streamId: STREAM,
    sequence: String(seconds),
    _sequenceNum: seconds,
    eventType,
    payload,
    actorId: "persona_1",
    actorType: "persona",
    createdAt: `2026-06-22T12:00:${String(seconds).padStart(2, "0")}.000Z`,
    _cachedAt: seconds,
  }
}

/** A socket that records its listeners so a test can fire an ephemeral event
 *  (`agent_session:progress`) the way the backend's trace-emitter does. */
function fakeSocket() {
  const handlers = new Map<string, (payload: unknown) => void>()
  const socket = {
    on: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler)
      return socket
    },
    off: (event: string) => {
      handlers.delete(event)
      return socket
    },
  } as unknown as Socket
  return { socket, handlers }
}

const readValue = { state: () => "ungated" as const, markReadUpToHere: vi.fn(), markUnread: vi.fn() }

beforeEach(async () => {
  __clearBoardRailRegistry()
  __clearConversationGraphRegistry()
  __resetCollapseCacheForTests()
  await db.events.clear()
  await db.conversations.clear()
  await db.streams.clear()
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([] as never)
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

afterEach(() => vi.restoreAllMocks())

describe("BoardCard unread dot", () => {
  it("shows the unread dot when the conversation has an effectively-unread member message", async () => {
    vi.spyOn(conversationReadModule, "useConversationReadController").mockReturnValue({
      value: readValue,
      hasUnread: () => true,
      markReadSilently: () => Promise.resolve(),
      setExplicitUnreadListener: () => {},
      getReadTruth: () => ({ lastReadSequence: null, readMessageIds: [] }),
    })
    mountCard()
    expect(await screen.findByLabelText("Unread")).toBeTruthy()
  })

  it("hides the unread dot when nothing is effectively unread", async () => {
    vi.spyOn(conversationReadModule, "useConversationReadController").mockReturnValue({
      value: readValue,
      hasUnread: () => false,
      markReadSilently: () => Promise.resolve(),
      setExplicitUnreadListener: () => {},
      getReadTruth: () => ({ lastReadSequence: null, readMessageIds: [] }),
    })
    mountCard()
    await screen.findByText("Opening body.")
    expect(screen.queryByLabelText("Unread")).toBeNull()
  })
})

describe("BoardCard post flash", () => {
  beforeEach(() => {
    vi.spyOn(conversationReadModule, "useConversationReadController").mockReturnValue({
      value: readValue,
      hasUnread: () => false,
      markReadSilently: () => Promise.resolve(),
      setExplicitUnreadListener: () => {},
      getReadTruth: () => ({ lastReadSequence: null, readMessageIds: [] }),
    })
  })
  afterEach(() => resetBoardFlashStoreCache())

  it("rings the card while its own conversation is flashing, then clears", async () => {
    mountCard()
    const body = await screen.findByText("Opening body.")
    expect(body.closest(".board-post-flash")).toBeNull()

    act(() => setBoardFlash("conv_1"))
    expect(body.closest(".board-post-flash")).not.toBeNull()

    act(() => setBoardFlash(null))
    expect(body.closest(".board-post-flash")).toBeNull()
  })

  it("does not ring a card whose conversation isn't the flashed one", async () => {
    mountCard()
    const body = await screen.findByText("Opening body.")
    act(() => setBoardFlash("conv_other"))
    expect(body.closest(".board-post-flash")).toBeNull()
  })
})

describe("BoardCard agent activity", () => {
  beforeEach(() => {
    vi.spyOn(conversationReadModule, "useConversationReadController").mockReturnValue({
      value: readValue,
      hasUnread: () => false,
      markReadSilently: () => Promise.resolve(),
      setExplicitUnreadListener: () => {},
      getReadTruth: () => ({ lastReadSequence: null, readMessageIds: [] }),
    })
  })

  it("renders an agent session whose invoking message is a conversation member", async () => {
    // A session triggered by the card's opening message (m_open ∈ messageIds) —
    // the "agent triggered from a card looks dead" gap this closes. The events ride
    // the same rail the card reads; the card interleaves them via STREAM_ROW_SPEC.
    await db.events.bulkPut([
      sessionEvent("agent_session:started", 30, {
        sessionId: "sess_A",
        triggerMessageId: "m_open",
        personaName: "Ariadne",
      }),
      sessionEvent("agent_session:completed", 40, {
        sessionId: "sess_A",
        stepCount: 3,
        duration: 1200,
        messageCount: 1,
      }),
    ])
    mountCard()
    expect(await screen.findByText("Session complete")).toBeTruthy()
  })

  it("live-updates a running session's step count from agent_session:progress", async () => {
    // A session started from the card's opening message but not yet terminal: its
    // events carry no counts, so the card rides the same ephemeral progress rail
    // the timeline does (useAgentActivity). Without it the card sat at "0 steps"
    // for the whole run.
    const { socket, handlers } = fakeSocket()
    vi.spyOn(contextsModule, "useSocket").mockReturnValue(socket)
    await db.events.bulkPut([
      sessionEvent("agent_session:started", 30, {
        sessionId: "sess_C",
        triggerMessageId: "m_open",
        personaName: "Ariadne",
        stepCount: 0,
        messageCount: 0,
      }),
    ])
    mountCard()

    expect(await screen.findByText(/0 steps/)).toBeTruthy()

    act(() => {
      handlers.get("agent_session:progress")?.({
        workspaceId: WS,
        streamId: STREAM,
        sessionId: "sess_C",
        triggerMessageId: "m_open",
        personaName: "Ariadne",
        stepCount: 3,
        messageCount: 1,
        currentStepType: "tool_call",
      })
    })

    expect(await screen.findByText(/3 steps/)).toBeTruthy()
  })

  it("shows 'Interrupted, retrying…' from a persisted interrupted event (survives refresh)", async () => {
    // A retryable attempt failed: the backend persisted a non-terminal
    // `agent_session:interrupted` event. Seeded into IDB with no live socket, it
    // stands in for a page reload mid-retry — the card must read the persisted
    // event as "retrying", never flash the terminal red "Session failed".
    await db.events.bulkPut([
      sessionEvent("agent_session:started", 30, {
        sessionId: "sess_R",
        triggerMessageId: "m_open",
        personaName: "Ariadne",
      }),
      sessionEvent("agent_session:interrupted", 35, {
        sessionId: "sess_R",
        stepCount: 2,
        attempt: 0,
        maxAttempts: 5,
        error: "Error: boom",
      }),
    ])
    mountCard()

    expect(await screen.findByText("Interrupted, retrying…")).toBeTruthy()
    expect(screen.queryByText("Session failed")).toBeNull()
    expect(await screen.findByText(/2 steps/)).toBeTruthy()
  })

  it("shows Stop + Redirect on a running session, and Redirect opens the card composer in place", async () => {
    const user = userEvent.setup()
    // A running session's row mounts the live progress rail (useAgentActivity),
    // which reads the socket — give it a fake one.
    const { socket } = fakeSocket()
    vi.spyOn(contextsModule, "useSocket").mockReturnValue(socket)
    // Prevent the real editor mounting when Redirect opens the composer — the
    // wiring under test is Redirect → open card composer, not editor mechanics.
    spyOnExport(inlineComposerModule, "InlineComposerForm").mockReturnValue(((props: { placeholder: string }) => (
      <div data-testid="reply-composer-open">{props.placeholder}</div>
    )) as never)

    // A running session (started, no terminal event) triggered by the card's
    // opening message: the board card must expose the same Stop/Redirect pair the
    // timeline card does.
    await db.events.bulkPut([
      sessionEvent("agent_session:started", 30, {
        sessionId: "sess_run",
        triggerMessageId: "m_open",
        personaName: "Ariadne",
      }),
    ])
    mountCard()

    expect(await screen.findByRole("button", { name: "Stop" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Redirect" })).toBeTruthy()
    // Composer starts collapsed to its resting affordance.
    expect(screen.queryByTestId("reply-composer-open")).toBeNull()

    await user.click(screen.getByRole("button", { name: "Redirect" }))

    // Redirect opened the card's own composer in place (no navigation) and the
    // fold-in hint confirms the running session will absorb the next message.
    expect(await screen.findByTestId("reply-composer-open")).toBeTruthy()
    expect(screen.getByText("Ariadne will fold your message into the current work")).toBeTruthy()
  })

  it("does NOT render a session whose invoking message is not a conversation member", async () => {
    await db.events.bulkPut([
      sessionEvent("agent_session:started", 30, {
        sessionId: "sess_B",
        triggerMessageId: "m_outsider",
        personaName: "Ariadne",
      }),
      sessionEvent("agent_session:completed", 40, {
        sessionId: "sess_B",
        stepCount: 3,
        duration: 1200,
        messageCount: 1,
      }),
    ])
    mountCard()
    await screen.findByText("Opening body.")
    expect(screen.queryByText("Session complete")).toBeNull()
  })
})

describe("BoardCard conversation actions", () => {
  beforeEach(() => {
    vi.spyOn(conversationReadModule, "useConversationReadController").mockReturnValue({
      value: readValue,
      hasUnread: () => false,
      markReadSilently: () => Promise.resolve(),
      setExplicitUnreadListener: () => {},
      getReadTruth: () => ({ lastReadSequence: null, readMessageIds: [] }),
    })
  })

  it("shows the topic title when the conversation has one", async () => {
    mountCard(makePost({ topicSummary: "Rotate the API tokens", status: "active" }))
    expect(await screen.findByText("Rotate the API tokens")).toBeTruthy()
  })

  it("colorizes a bot message with its actor badge + full-bleed row accent on the board", async () => {
    const { container } = mountCard(makePost({}, { authorType: "bot", authorId: "bot_1" }))
    await screen.findByText("Opening body.")
    // Name-color + inline badge (BOT)...
    expect(screen.getByText("BOT")).toBeTruthy()
    // ...AND the full-bleed rowAccent (tint + inset stripe) on the row's surface div —
    // NOT indented onto the content block. Board messages are standalone
    // (first-from-author), so the standalone branch must carry the accent.
    const botRow = container.querySelector('[data-actor-type="bot"]')
    const surface = botRow?.querySelector(".reveal-host")
    expect(surface?.className).toContain("from-emerald-500/[0.06]")
    // The row breaks out of the card padding so the accent fills to the edges.
    expect(botRow?.className).toContain("-mx-3")
    // The content block itself stays plain (no indent → aligned with user rows).
    expect(botRow?.querySelector(".message-content")?.className).not.toContain("border-l-2")
  })

  it("renders the resolved treatment on a resolved conversation", async () => {
    mountCard(makePost({ topicSummary: "Shipped the redesign", status: "resolved" }))
    await screen.findByText("Shipped the redesign")
    expect(screen.getByLabelText("Resolved")).toBeTruthy()
  })

  it("marks the conversation resolved from the ⋯ menu", async () => {
    const user = userEvent.setup()
    const updateConversation = vi.fn().mockResolvedValue({
      conversation: { id: "conv_1", status: "resolved", messageIds: ["m_open"] },
    })
    mountCard(makePost({ topicSummary: "Rotate the API tokens", status: "active" }), { updateConversation })

    await user.click(await screen.findByRole("button", { name: "Conversation actions" }))
    await user.click(await screen.findByText("Mark resolved"))

    // The menu item's onClick fires the mutation on a microtask after the click
    // resolves, so assert via waitFor — a bare synchronous expect races the
    // dispatch and flakes under CI load (still asserting the exact call args).
    await waitFor(() => expect(updateConversation).toHaveBeenCalledWith(WS, "conv_1", { status: "resolved" }))
  })

  it("hides the conversation from the board via the ⋯ menu", async () => {
    const user = userEvent.setup()
    const hideConversation = vi.fn().mockResolvedValue({ hiddenAt: "2026-07-05T00:00:00.000Z" })
    mountCard(makePost({ topicSummary: "Rotate the API tokens", status: "active" }), { hideConversation })

    await user.click(await screen.findByRole("button", { name: "Conversation actions" }))
    await user.click(await screen.findByText("Hide from board"))

    await waitFor(() => expect(hideConversation).toHaveBeenCalledWith(WS, "conv_1"))
  })
})

describe("BoardCard collapse", () => {
  beforeEach(() => {
    vi.spyOn(conversationReadModule, "useConversationReadController").mockReturnValue({
      value: readValue,
      hasUnread: () => false,
      markReadSilently: () => Promise.resolve(),
      setExplicitUnreadListener: () => {},
      getReadTruth: () => ({ lastReadSequence: null, readMessageIds: [] }),
    })
  })

  function withThreshold(px: number) {
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: {
        timezone: "UTC",
        locale: "en-US",
        boardCardCollapseEnabled: true,
        boardCardCollapseAtHeight: px,
        boardCardCollapseToHeight: 320,
      },
    } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  }

  /** JSDOM reports `scrollHeight` 0 (no layout), so the height-driven default
   *  never fires on its own. Force a rendered height to exercise it, restoring
   *  the prototype descriptor after. */
  function mockScrollHeight(px: number): () => void {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight")
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => px })
    return () => {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollHeight", original)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight
    }
  }

  it("offers the fold control on every card, expanded by default when the body isn't tall", async () => {
    mountCard()
    await screen.findByText("Opening body.")
    // The control is always present (any card is foldable); a short body reads
    // "Collapse" (expanded).
    expect(screen.getByLabelText("Collapse conversation")).toBeTruthy()
    expect(screen.queryByLabelText("Expand conversation")).toBeNull()
  })

  it("folds from the header control and names the folded message count", async () => {
    const user = userEvent.setup()
    mountCard(makePost({ topicSummary: "Rotate the API tokens" }))
    await screen.findByText("Opening body.")

    await user.click(screen.getByLabelText("Collapse conversation"))

    // Header (topic + count) stays; the body remains mounted and visually clipped.
    expect(screen.getByText("Rotate the API tokens")).toBeTruthy()
    expect(screen.getByText("1 message")).toBeTruthy()
    expect(screen.getByText("Opening body.")).toBeTruthy()

    await user.click(screen.getByLabelText("Expand conversation"))
    expect(await screen.findByText("Opening body.")).toBeTruthy()
    expect(screen.queryByText("1 message")).toBeNull()
  })

  it("starts folded when the rendered body is taller than the threshold", async () => {
    withThreshold(500)
    const restore = mockScrollHeight(800)
    try {
      mountCard(makePost({ topicSummary: "Rotate the API tokens" }))
      expect(await screen.findByText("Rotate the API tokens")).toBeTruthy()
      expect(screen.getByLabelText("Expand conversation")).toBeTruthy()
      expect(screen.getByText("Opening body.")).toBeTruthy()
    } finally {
      restore()
    }
  })
})

describe("BoardCard row layout", () => {
  beforeEach(() => {
    vi.spyOn(conversationReadModule, "useConversationReadController").mockReturnValue({
      value: readValue,
      hasUnread: () => false,
      markReadSilently: () => Promise.resolve(),
      setExplicitUnreadListener: () => {},
      getReadTruth: () => ({ lastReadSequence: null, readMessageIds: [] }),
    })
  })

  // The board row must carry the same vertical rhythm as the timeline
  // (MessageEvent), applied to the *accent* row so a persona/bot tint band stays
  // contiguous across a group — not on the outer wrapper as a margin, which
  // reintroduces the between-block gaps this alignment removed (INV-35).
  it("applies the shared message-row padding to the accent row, not the wrapper", async () => {
    mountCard()
    const wrapper = (await screen.findByText("Opening body.")).closest("[data-message-row]")
    expect(wrapper).toBeTruthy()
    expect(wrapper!.className).not.toMatch(/(^|\s)mt-/)
    const accent = wrapper!.querySelector(".reveal-host")
    expect(accent).toBeTruthy()
    for (const cls of MESSAGE_ROW_HEAD_PADDING.split(" ")) {
      expect(accent!.className).toContain(cls)
    }
  })

  // Parity with the timeline row (MessageEvent): on touch the row hands selection
  // to the long-press drawer / swipe-to-quote, so native selection is disabled;
  // on mouse the row stays selectable so the desktop quote-on-selection works.
  // Assert across EVERY rendered row — MessageItem has separate head- and
  // continuation-row containers, so a same-author follow-up covers both paths
  // (an earlier version only patched the head container).
  const withContinuationReply = (): BoardViewPost => {
    const post = makePost()
    return {
      ...post,
      conversation: { ...(post.conversation as object), messageIds: ["m_open", "m_reply"] },
      // Same author, inside GROUP_WINDOW_MS of the opening → renders as a continuation row.
      recentMessages: [
        {
          id: "m_reply",
          streamId: STREAM,
          authorId: "usr_other",
          authorType: "user",
          contentMarkdown: "Reply body.",
          reactions: {},
          attachments: [],
          linkPreviews: [],
          createdAt: "2026-06-22T12:01:00.000Z",
          editedAt: null,
        },
      ],
      totalReplies: 1,
    } as unknown as BoardViewPost
  }

  it("disables text selection on touch input across head and continuation rows", async () => {
    vi.spyOn(inputModeModule, "useInputMode").mockReturnValue("touch")
    mountCard(withContinuationReply())
    await screen.findByText("Reply body.")
    const rows = document.querySelectorAll("[data-message-row]")
    expect(rows.length).toBe(2)
    for (const row of rows) expect(row.className).toContain("select-none")
  })

  it("keeps text selectable on mouse input across head and continuation rows", async () => {
    vi.spyOn(inputModeModule, "useInputMode").mockReturnValue("mouse")
    mountCard(withContinuationReply())
    await screen.findByText("Reply body.")
    const rows = document.querySelectorAll("[data-message-row]")
    expect(rows.length).toBe(2)
    for (const row of rows) expect(row.className).not.toContain("select-none")
  })
})

describe("BoardCard day dividers", () => {
  it("shows no day divider even when its messages straddle a calendar day", async () => {
    // The injector lives at the conversation-panel call site; a collapsed card is
    // a digest, not a timeline.
    const lateNight = new Date(2026, 5, 21, 23, 0, 0)
    const afterMidnight = new Date(2026, 5, 22, 0, 30, 0)
    const post = makePost({ messageIds: ["m_open", "m_reply"] }, { createdAt: lateNight.toISOString() })
    mountCard({
      ...post,
      recentMessages: [
        {
          id: "m_reply",
          streamId: STREAM,
          authorId: "usr_other",
          authorType: "user",
          contentMarkdown: "Reply body.",
          reactions: {},
          attachments: [],
          linkPreviews: [],
          createdAt: afterMidnight.toISOString(),
          editedAt: null,
        },
      ],
      totalReplies: 1,
    } as unknown as BoardViewPost)
    await screen.findByText("Reply body.")
    expect(screen.queryByText(formatDayDivider(new Date(localStartOfDayMs(afterMidnight))))).toBeNull()
  })
})
