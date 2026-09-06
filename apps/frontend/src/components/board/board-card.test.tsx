import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetConversationMessageSnapshots } from "@/stores/conversation-messages-store"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import type { Socket } from "socket.io-client"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StreamTypes, type BoardPostMessage } from "@threahq/types"
import { BoardCard } from "./board-card"
import type { BoardViewPost } from "@/hooks/use-stable-board-view"
import { ServicesProvider, PanelProvider, TraceProvider, MediaGalleryProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import { __clearBoardRailRegistry } from "@/hooks/use-board-card-messages"
import { __clearConversationGraphRegistry } from "@/hooks/use-conversation-graph"
import { __resetCollapseCacheForTests } from "@/lib/markdown/collapse-cache"
import {
  upsertAgentSession,
  updateAgentSessionProgress,
  __resetAgentActivityStore,
} from "@/stores/agent-activity-store"
// eslint-disable-next-line no-restricted-imports -- test seeds IDB directly to drive the real rail read path
import { db, type CachedEvent, type CachedStream } from "@/db"
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
import * as boardStoreModule from "@/stores/board-store"
import * as streamStoreModule from "@/stores/stream-store"
import * as revealAnchorModule from "@/hooks/use-board-card-reveal-anchor"
import { setBoardFlash, resetBoardFlashStoreCache } from "@/stores/board-flash-store"
import { spyOnExport } from "@/test/spy"
import { MESSAGE_ROW_CONTINUATION_PADDING, MESSAGE_ROW_HEAD_PADDING } from "@/components/message/message-row-layout"
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
  const tree = (current: BoardViewPost) => cardTree(current, conversations, queryClient)
  const result = render(tree(post))
  // Re-render the SAME card with a fresh post — the shape a live board update
  // takes (the Dexie liveQuery hands the card a new post object in place).
  return { ...result, rerenderPost: (next: BoardViewPost) => result.rerender(tree(next)) }
}

function cardTree(post: BoardViewPost, conversations: Record<string, unknown>, queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ServicesProvider services={{ conversations: conversations as never }}>
          <MemoryRouter initialEntries={[`/w/${WS}/board`]}>
            <TraceProvider>
              <PanelProvider>
                <MediaGalleryProvider>
                  <BoardCard workspaceId={WS} post={post} contextLabel="#general" streamType="channel" />
                </MediaGalleryProvider>
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

/** A command lifecycle event, author-scoped like the wire. Hosted on the card's
 *  stream unless a host stream is named (a branch-reply command). */
function commandEvent(
  eventType: "command_dispatched" | "command_completed" | "command_failed",
  seconds: number,
  actorId: string,
  payload: Record<string, unknown>,
  hostStreamId: string = STREAM
): CachedEvent {
  return {
    id: `${eventType}_${seconds}`,
    workspaceId: WS,
    streamId: hostStreamId,
    sequence: String(seconds),
    _sequenceNum: seconds,
    eventType,
    payload,
    actorId,
    actorType: "user",
    createdAt: `2026-06-22T12:00:${String(seconds).padStart(2, "0")}.000Z`,
    _cachedAt: seconds,
  }
}

/** A cached stream row: the card's channel when `parentStreamId` is null, else a
 *  thread hanging off `parentAnchorId`. */
function threadStream(
  id: string,
  parentStreamId: string | null,
  rootStreamId: string | null,
  parentAnchorId: string | null
): CachedStream {
  return {
    id,
    workspaceId: WS,
    type: parentStreamId ? StreamTypes.THREAD : StreamTypes.CHANNEL,
    displayName: null,
    slug: id,
    description: null,
    visibility: "public",
    parentStreamId,
    parentAnchorId,
    rootStreamId,
    createdAt: "2026-06-22T11:00:00.000Z",
    updatedAt: "2026-06-22T11:00:00.000Z",
  } as unknown as CachedStream
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
  __resetAgentActivityStore()
  __clearBoardRailRegistry()
  __clearConversationGraphRegistry()
  __resetCollapseCacheForTests()
  await db.events.clear()
  await db.conversationMessages.clear()
  __resetConversationMessageSnapshots()
  await db.conversations.clear()
  await db.streams.clear()
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

  it("renders the command chip for a command dispatched into this conversation, and drops another member's", async () => {
    await db.events.bulkPut([
      commandEvent("command_dispatched", 50, "usr_me", {
        commandId: "cmd_1",
        name: "compact",
        args: "",
        status: "dispatched",
        conversationId: "conv_1",
      }),
      commandEvent("command_completed", 51, "usr_me", { commandId: "cmd_1" }),
      commandEvent("command_dispatched", 52, "usr_other", {
        commandId: "cmd_other",
        name: "kick",
        args: "",
        status: "dispatched",
        conversationId: "conv_1",
      }),
    ])
    mountCard()
    expect(await screen.findByText("/compact")).toBeTruthy()
    expect(screen.getByText("completed")).toBeTruthy()
    expect(screen.queryByText("/kick")).toBeNull()
  })

  it("renders the command chip for a command hosted on an overflowed branch stream", async () => {
    // The board used to place event rows by `event.streamId`: a slash command typed
    // into a deep branch reply is hosted on that branch's thread stream, which
    // collapses behind a `continue thread` row, so the chip vanished. Card-level
    // proof (resolver + row builder + render) of the depth-0 anchoring pinned in
    // board-row-item.test.ts. Graph mirrors that test: root→t1→t2→t3, rel-depth 3.
    await db.streams.bulkPut([
      threadStream(STREAM, null, null, null),
      threadStream("t1", STREAM, STREAM, "m_open"),
      threadStream("t2", "t1", STREAM, "m_b1"),
      threadStream("t3", "t2", STREAM, "m_b2"),
    ])
    await db.events.bulkPut([
      messageEvent("m_open", "Opening body.", 10),
      messageEvent("m_b1", "Branch one.", 20, undefined, "t1"),
      messageEvent("m_b2", "Branch two.", 30, undefined, "t2"),
      messageEvent("m_b3", "Branch three.", 40, undefined, "t3"),
      commandEvent(
        "command_dispatched",
        50,
        "usr_me",
        { commandId: "cmd_deep", name: "compact", args: "", status: "dispatched", conversationId: "conv_1" },
        "t3"
      ),
      commandEvent("command_completed", 51, "usr_me", { commandId: "cmd_deep" }, "t3"),
    ])
    const post = makePost({ messageIds: ["m_open", "m_b1", "m_b2", "m_b3"] })
    mountCard({ ...post, streamIds: [STREAM, "t1", "t2", "t3"] } as unknown as BoardViewPost)

    // The host stream really is collapsed behind the spanning-overflow row — the
    // chip's host row is not rendered, so the chip can only survive by anchoring
    // to the conversation.
    expect(await screen.findByText("Continue this thread")).toBeTruthy()
    expect(screen.queryByText("Branch three.")).toBeNull()
    expect(await screen.findByText("/compact")).toBeTruthy()
    expect(screen.getByText(/completed/)).toBeTruthy()
  })

  it("live-updates a running session's step count from the agent activity store", async () => {
    // A session started from the card's opening message but not yet terminal: its
    // events carry no counts. They arrive as `agent_session:progress` ticks, folded
    // into the module store by workspace-sync's single subscription — the row reads
    // them there, so it is live whenever it mounts, not only when it was mounted at
    // room-join time. Without it the card sat at "0 steps" for the whole run.
    await db.events.bulkPut([
      sessionEvent("agent_session:started", 30, {
        sessionId: "sess_C",
        triggerMessageId: "m_open",
        personaName: "Ariadne",
        stepCount: 0,
        messageCount: 0,
      }),
    ])
    upsertAgentSession(WS, {
      sessionId: "sess_C",
      streamId: STREAM,
      rootStreamId: STREAM,
      personaName: "Ariadne",
      startedAt: "2026-06-22T12:00:30.000Z",
    })
    mountCard()

    expect(await screen.findByText("0 steps • 0 messages sent")).toBeTruthy()

    act(() => {
      updateAgentSessionProgress(WS, "sess_C", { stepCount: 3, messageCount: 1 })
    })

    expect(await screen.findByText("3 steps • 1 message sent")).toBeTruthy()
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
    // A running session's row reads live progress from the agent-activity store,
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

/** A delegation event on the card's stream, seeded into IDB like the session ones. */
function delegationEvent(
  eventType: "delegation:created" | "delegation:status_changed",
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

describe("BoardCard delegations", () => {
  beforeEach(() => {
    vi.spyOn(conversationReadModule, "useConversationReadController").mockReturnValue({
      value: readValue,
      hasUnread: () => false,
      markReadSilently: () => Promise.resolve(),
      setExplicitUnreadListener: () => {},
      getReadTruth: () => ({ lastReadSequence: null, readMessageIds: [] }),
    })
  })

  it("shows a delegation card for a delegation created from its conversation", async () => {
    await db.events.bulkPut([
      delegationEvent("delegation:created", 30, {
        delegationId: "dlg_1",
        title: "Add rate limiting",
        brief: "Token bucket.",
        contextRefs: [],
        sourceConversationId: "conv_1",
      }),
      // Another conversation's delegation must stay off this card.
      delegationEvent("delegation:created", 40, {
        delegationId: "dlg_2",
        title: "Somebody else's task",
        brief: "Not here.",
        contextRefs: [],
        sourceConversationId: "conv_other",
      }),
    ])
    mountCard()
    expect(await screen.findByText("Add rate limiting")).toBeTruthy()
    expect(screen.queryByText("Somebody else's task")).toBeNull()
  })

  it("reflects the latest status patch on the delegation card", async () => {
    await db.events.bulkPut([
      delegationEvent("delegation:created", 30, {
        delegationId: "dlg_1",
        title: "Add rate limiting",
        brief: "Token bucket.",
        contextRefs: [],
        sourceConversationId: "conv_1",
      }),
      delegationEvent("delegation:status_changed", 40, { delegationId: "dlg_1", status: "claimed" }),
      delegationEvent("delegation:status_changed", 50, { delegationId: "dlg_1", status: "completed" }),
    ])
    mountCard()
    await screen.findByText("Add rate limiting")
    expect(screen.getByText(/· Completed$/)).toBeTruthy()
    expect(screen.queryByText(/· Claimed$/)).toBeNull()
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

describe("BoardCard deleted messages", () => {
  it("draws a tombstone in the collapsed card's reply preview, without its body", async () => {
    // Same data, different view: a deleted reply reads as deleted on the collapsed
    // card too, spending a preview slot rather than vanishing and silently pulling
    // every row below it up. It counts zero toward the "N more" gap either way.
    await db.events.bulkPut([
      messageEvent("m_open", "Opening body.", 10),
      messageEvent("m_r1", "A live reply.", 20),
      messageEvent("m_r2", "The deleted body.", 30, "2026-06-22T12:05:00.000Z"),
    ])
    mountCard(makePost({ messageIds: ["m_open", "m_r1", "m_r2"] }))

    expect(await screen.findByText("A live reply.")).toBeTruthy()
    expect(await screen.findByText("This message was deleted")).toBeTruthy()
    expect(screen.queryByText("The deleted body.")).toBeNull()
  })

  it("renders a tombstone, not a blank row, for a deleted reply on the cached projection", async () => {
    // No IDB events: the rail never sees the conversation, so the card falls back
    // to the server projection, whose deleted rows arrive blanked but flagged.
    const post = makePost({ messageIds: ["m_open", "m_r1"] })
    ;(post as unknown as { recentMessages: unknown[] }).recentMessages = [
      {
        id: "m_r1",
        streamId: STREAM,
        authorId: "usr_other",
        authorType: "user",
        contentMarkdown: "",
        reactions: {},
        attachments: [],
        linkPreviews: [],
        createdAt: "2026-06-22T12:05:00.000Z",
        editedAt: null,
        deletedAt: "2026-06-22T12:06:00.000Z",
      },
    ]
    ;(post as unknown as { totalReplies: number }).totalReplies = 1
    const { container } = mountCard(post)

    expect(await screen.findByText("This message was deleted")).toBeTruthy()
    expect(container.querySelector('[data-message-id="m_r1"]')?.textContent).toBe("This message was deleted")
  })

  it("renders a tombstone, not a blank row, for a deleted reply from the backfill", async () => {
    const getBoardMessages = vi.fn().mockResolvedValue([
      openingMessage(),
      {
        id: "m_r2",
        streamId: STREAM,
        authorId: "usr_other",
        authorType: "user",
        contentMarkdown: "",
        reactions: {},
        attachments: [],
        linkPreviews: [],
        createdAt: "2026-06-22T12:10:00.000Z",
        editedAt: null,
        deletedAt: "2026-06-22T12:11:00.000Z",
      },
    ])
    // The rail has READ and holds the opening — the backfill only arms on a
    // rail-resolved card — but the reply member is out of its window.
    await db.events.bulkPut([messageEvent("m_open", "Opening body.", 10)])
    const post = makePost({ messageIds: ["m_open", "m_r2"] })
    ;(post as unknown as { totalReplies: number }).totalReplies = 1
    const { container } = mountCard(post, { getBoardMessages })

    // The ledger wants the whole window, so the backfill arms on its own.
    expect(await screen.findByText("This message was deleted")).toBeTruthy()
    expect(container.querySelector('[data-message-id="m_r2"]')?.textContent).toBe("This message was deleted")
  })

  it("renders a tombstone for a deleted reply once the rail is complete", async () => {
    // The rail path: every reply is local, so the card falls through to
    // `railReplies`, which carries the tombstone in its own chronological slot —
    // the same row the projection and backfill paths draw, so nothing reflows as
    // sync completes. It is shown but counts as zero, so it never moves the gap.
    await db.events.bulkPut([
      messageEvent("m_open", "Opening body.", 10),
      messageEvent("m_r1", "First reply.", 11),
      messageEvent("m_r2", "Second reply.", 12),
      messageEvent("m_rd", "The deleted body.", 13, "2026-06-22T12:05:00.000Z"),
      messageEvent("m_r3", "Third reply.", 14),
      messageEvent("m_r4", "Fourth reply.", 15),
      messageEvent("m_r5", "Fifth reply.", 16),
    ])
    const post = makePost({ messageIds: ["m_open", "m_r1", "m_r2", "m_rd", "m_r3", "m_r4", "m_r5"] })
    ;(post as unknown as { totalReplies: number }).totalReplies = 5
    mountCard(post)

    expect(await screen.findByText("This message was deleted")).toBeTruthy()
    expect(screen.queryByText("The deleted body.")).toBeNull()
    expect(screen.getByText("First reply.")).toBeTruthy()
    expect(screen.getByText("Fifth reply.")).toBeTruthy()
  })
})

describe("BoardCard unread dot on a deleted opening", () => {
  it("keeps the dot off when the only known message is a deleted opening", async () => {
    // Projection path (no IDB events): the opening arrives blanked but flagged.
    // A tombstone renders no observable row, so auto-read can never clear a dot it
    // lit — it must not reach the unread derivation at all. `hasUnread` here reports
    // on whatever set the card hands it, so the assertion is about that set.
    vi.spyOn(conversationReadModule, "useConversationReadController").mockReturnValue({
      value: readValue,
      hasUnread: (messages) => messages.length > 0,
      markReadSilently: () => Promise.resolve(),
      setExplicitUnreadListener: () => {},
      getReadTruth: () => ({ lastReadSequence: null, readMessageIds: [] }),
    })
    const post = makePost({ messageIds: ["m_open"] }, { contentMarkdown: "", deletedAt: "2026-06-22T12:06:00.000Z" })
    mountCard(post)

    expect(await screen.findByText("This message was deleted")).toBeTruthy()
    expect(screen.queryByLabelText("Unread")).toBeNull()
  })
})

/** A `message_created` row on the card's stream, seeded into IDB so the card's
 *  rail reads it like the timeline does. */
function messageEvent(
  messageId: string,
  contentMarkdown: string,
  seconds: number,
  deletedAt?: string,
  hostStreamId: string = STREAM
): CachedEvent {
  return {
    ...sessionEvent("agent_session:started", seconds, { messageId, contentMarkdown, reactions: {}, deletedAt }),
    id: `evt_${messageId}`,
    streamId: hostStreamId,
    eventType: "message_created",
    actorId: "usr_me",
    actorType: "user",
  }
}

/** The settling mark's own elements on a rendered row: the dashed rail overlay
 *  and the content block whose opacity the texture mutes. */
function settlingParts(container: HTMLElement, messageId: string) {
  const row = container.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null
  if (!row) throw new Error(`no row for ${messageId}`)
  const rail = row.querySelector(".border-dashed") as HTMLElement | null
  const content = row.querySelector(".message-content") as HTMLElement | null
  return { row, rail, content }
}

describe("BoardCard settling mark", () => {
  function settlingPost(ids: string[], conversation: Record<string, unknown> = {}) {
    const post = makePost(conversation)
    ;(post as unknown as { settlingMessageIds: string[] }).settlingMessageIds = ids
    return post
  }

  it("wears the dashed rail and muted content when the row is in settlingMessageIds", async () => {
    const { container } = mountCard(settlingPost(["m_open"]))
    await screen.findByText("Opening body.")

    const { row, rail, content } = settlingParts(container, "m_open")
    expect(row.hasAttribute("data-settling")).toBe(true)
    expect(rail?.className).toContain("border-muted-foreground/40")
    expect(content?.className).toContain("opacity-70")
    expect(screen.getByText("Still settling — this message may move to another topic")).toBeTruthy()
  })

  it("leaves a settled row unmarked — no rail color, no opacity, no hint", async () => {
    const { container } = mountCard(settlingPost([]))
    await screen.findByText("Opening body.")

    const { row, rail, content } = settlingParts(container, "m_open")
    expect(row.hasAttribute("data-settling")).toBe(false)
    expect(rail?.className).toContain("border-transparent")
    expect(rail?.className).not.toContain("border-muted-foreground")
    expect(content?.className).not.toContain("opacity-")
    expect(screen.queryByText("Still settling — this message may move to another topic")).toBeNull()
  })

  it("adds no box metrics to a row: the mark is an absolute overlay and the row's own classes are identical", async () => {
    // INV-21: toggling settling must move nothing. The row container's classes
    // (padding, borders, insets) are byte-identical settled vs settling, and the
    // rail overlay is absolutely positioned at zero width — it can only paint.
    const settled = mountCard(settlingPost([]))
    await screen.findByText("Opening body.")
    const settledRow = settlingParts(settled.container, "m_open")
    const settledClasses = settledRow.row.querySelector(".message-hover-wash")?.className
    settled.unmount()

    __clearBoardRailRegistry()
    const marked = mountCard(settlingPost(["m_open"]))
    await screen.findByText("Opening body.")
    const markedRow = settlingParts(marked.container, "m_open")
    expect(markedRow.row.querySelector(".message-hover-wash")?.className).toBe(settledClasses)
    expect(markedRow.rail?.className).toContain("absolute")
    expect(markedRow.rail?.className).toContain("w-0")
    expect(markedRow.rail?.className).toContain("pointer-events-none")
  })

  it("fades rather than pops: the mark's properties carry a transition on every row", async () => {
    const { container } = mountCard(settlingPost(["m_open"]))
    await screen.findByText("Opening body.")
    const { rail, content } = settlingParts(container, "m_open")
    expect(rail?.className).toContain("transition-colors")
    expect(rail?.className).toContain("duration-300")
    expect(content?.className).toContain("transition-opacity")
    expect(content?.className).toContain("duration-300")
  })

  it("drops the mark in place when the settle echo updates the post", async () => {
    // The live path: `conversation:updated` → `mergeBoardConversation` → the
    // Dexie liveQuery hands the card a post with a smaller settling set. Driven
    // here as the re-render that produces, with the same row identity.
    const { container, rerenderPost } = mountCard(settlingPost(["m_open"]))
    await screen.findByText("Opening body.")
    expect(settlingParts(container, "m_open").row.hasAttribute("data-settling")).toBe(true)

    rerenderPost(settlingPost([]))
    await waitFor(() => expect(settlingParts(container, "m_open").row.hasAttribute("data-settling")).toBe(false))
    expect(settlingParts(container, "m_open").content?.className).not.toContain("opacity-")
  })

  it("never marks a tombstone: a deleted settling row renders as deleted only", async () => {
    await db.events.bulkPut([
      messageEvent("m_open", "Opening body.", 10),
      messageEvent("m_r1", "The deleted body.", 20, "2026-06-22T12:05:00.000Z"),
    ])
    const { container } = mountCard(settlingPost(["m_open", "m_r1"], { messageIds: ["m_open", "m_r1"] }))

    expect(await screen.findByText("This message was deleted")).toBeTruthy()
    expect(container.querySelector('[data-message-id="m_r1"]')?.textContent).toBe("This message was deleted")
    // The settling id names a row the card doesn't render — it must not conjure one.
    expect(container.querySelectorAll("[data-settling]").length).toBe(1)
  })
})

describe("BoardCard settling actions", () => {
  function settlingPost(ids: string[]) {
    const post = makePost()
    ;(post as unknown as { settlingMessageIds: string[] }).settlingMessageIds = ids
    return post
  }

  it("puts the keep-here button leftmost in the hover toolbar of a settling row", async () => {
    const { container } = mountCard(settlingPost(["m_open"]), { settleMessage: vi.fn() })
    await screen.findByText("Opening body.")

    const toolbar = container.querySelector(".reveal-actions-hover-only > div") as HTMLElement
    const first = toolbar.firstElementChild as HTMLElement
    expect(first.getAttribute("aria-label")).toBe("Keep here")
  })

  it("leaves a settled row's toolbar exactly as it was — no settling buttons at all", async () => {
    const { container } = mountCard(settlingPost([]), { settleMessage: vi.fn() })
    await screen.findByText("Opening body.")

    const toolbar = container.querySelector(".reveal-actions-hover-only > div") as HTMLElement
    expect(
      [...toolbar.children]
        .map((el) => el.getAttribute("aria-label"))
        .filter((l) => l === "Keep here" || l === "Not this topic…")
    ).toEqual([])
  })

  it("hides 'Not this topic' when the row has no other topic to move to (never a dead menu item)", async () => {
    mountCard(settlingPost(["m_open"]), { settleMessage: vi.fn() })
    await screen.findByText("Opening body.")

    expect(screen.queryByLabelText("Not this topic…")).toBeNull()
  })

  it("offers the stream's other conversations as 'Not this topic' targets, with no duplicate 'Move to sub-topic…' beside it", async () => {
    // The common case: a channel's main conversation, no sub-topics. Without the
    // sibling widening the correction half of the chip would never render; with
    // both entries wired it would render twice (same icon, same dialog).
    const boardPosts = vi.spyOn(boardStoreModule, "useBoardPosts").mockReturnValue([
      { id: "conv_1", workspaceId: WS, conversation: { id: "conv_1", streamId: STREAM, messageIds: ["m_open"] } },
      {
        id: "conv_sibling",
        workspaceId: WS,
        conversation: {
          id: "conv_sibling",
          streamId: STREAM,
          topicSummary: "Deploy plan",
          messageIds: ["m_other"],
        },
        _lastActivityMs: 1,
      },
    ] as never)
    mountCard(settlingPost(["m_open"]), { settleMessage: vi.fn() })
    await screen.findByText("Opening body.")

    expect(screen.getAllByLabelText("Not this topic…")).toHaveLength(1)
    await userEvent.click(screen.getAllByLabelText("Message actions")[0])
    const entries = (await screen.findAllByRole("menuitem")).map((el) => el.textContent)
    expect(entries.filter((t) => t?.includes("Not this topic") || t?.includes("Move to sub-topic"))).toEqual([
      "Not this topic…",
    ])
    boardPosts.mockRestore()
  })

  it("settles the message on click and stays silent about it (INV-63)", async () => {
    const settleMessage = vi.fn().mockResolvedValue({
      conversation: { id: "conv_1", streamId: STREAM, messageIds: ["m_open"] },
      previousConversation: null,
      settlingMessageIds: [],
    })
    const success = vi.spyOn(toast, "success")
    mountCard(settlingPost(["m_open"]), { settleMessage })
    await screen.findByText("Opening body.")

    await userEvent.click(screen.getByLabelText("Keep here"))

    await waitFor(() => expect(settleMessage).toHaveBeenCalledWith(WS, "conv_1", "m_open"))
    expect(success).not.toHaveBeenCalled()
  })
})

describe("BoardCard backfill invalidation", () => {
  it("refetches when membership gains an id neither the rail nor the store can render", async () => {
    // The card shares `useConversationBackfill` with the panel, so it revalidates
    // on a genuinely new member instead of waiting out the 60s `staleTime`.
    const getBoardMessages = vi
      .fn()
      .mockResolvedValue([
        openingMessage(),
        openingMessage({ id: "m_r1", contentMarkdown: "Reply body.", createdAt: "2026-06-22T12:00:10.000Z" }),
      ])
    await db.events.bulkPut([messageEvent("m_open", "Opening body.", 10)])
    const post = makePost({ messageIds: ["m_open", "m_r1"] })
    ;(post as unknown as { totalReplies: number }).totalReplies = 1
    const { rerenderPost } = mountCard(post, { getBoardMessages })

    await waitFor(() => expect(getBoardMessages).toHaveBeenCalledTimes(1))

    const grown = makePost({ messageIds: ["m_open", "m_r1", "m_r2"] })
    ;(grown as unknown as { totalReplies: number }).totalReplies = 2
    act(() => rerenderPost(grown))

    await waitFor(() => expect(getBoardMessages.mock.calls.length).toBeGreaterThan(1))
  })
})

/** `count` replies on the local rail, each a two-line body: the first line is
 *  what a collapsed ledger row leads with, the second only exists on the full
 *  message row — so "collapsed" and "expanded" are distinguishable by text. */
async function seedLedgerRail(count: number, options: { deletedIndex?: number } = {}) {
  const ids = Array.from({ length: count }, (_, i) => `m_r${i + 1}`)
  await db.events.bulkPut([
    messageEvent("m_open", "Opening body.", 10),
    ...ids.map((id, i) =>
      messageEvent(
        id,
        `Reply ${i + 1}.\n\nBody of reply ${i + 1}.`,
        11 + i,
        options.deletedIndex === i ? "2026-06-22T12:05:00.000Z" : undefined
      )
    ),
  ])
  const post = makePost({ messageIds: ["m_open", ...ids] })
  ;(post as unknown as { totalReplies: number }).totalReplies = options.deletedIndex === undefined ? count : count - 1
  return post
}

function withPreferences(preferences: Record<string, unknown>) {
  vi.mocked(contextsModule.usePreferences).mockReturnValue({
    preferences: { timezone: "UTC", locale: "en-US", ...preferences },
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
}

const ledgerRows = (container: HTMLElement) => container.querySelectorAll("[data-ledger-row]")

describe("BoardCard ledger", () => {
  it("keeps the newest reply full and renders every older one as a lead line", async () => {
    const { container } = mountCard(await seedLedgerRail(8))

    // The newest reply is the full row: its body is on screen.
    expect(await screen.findByText("Body of reply 8.")).toBeTruthy()
    // The seven older ones are leads — first line only, body withheld.
    await waitFor(() => expect(ledgerRows(container).length).toBe(7))
    expect(screen.getByText("Reply 7.")).toBeTruthy()
    expect(screen.queryByText("Body of reply 7.")).toBeNull()
    expect(screen.queryByText("Body of reply 1.")).toBeNull()
    // Everything fits the ledger window, so there is no earlier-mass head row.
    expect(screen.queryByText(/earlier/)).toBeNull()
  })

  it("keeps `boardFullTailCount` newest replies full", async () => {
    withPreferences({ boardFullTailCount: 2 })
    const { container } = mountCard(await seedLedgerRail(8))

    expect(await screen.findByText("Body of reply 8.")).toBeTruthy()
    expect(screen.getByText("Body of reply 7.")).toBeTruthy()
    await waitFor(() => expect(ledgerRows(container).length).toBe(6))
    expect(screen.queryByText("Body of reply 6.")).toBeNull()
  })

  it("collapses the mass above the ledger window into one head row linking to the panel", async () => {
    // 20 replies: 1 stays full, 15 ledger rows, the remaining 4 are earlier mass.
    const { container } = mountCard(await seedLedgerRail(20))

    const head = await screen.findByText(/^4 earlier · /)
    expect(ledgerRows(container).length).toBe(15)
    expect(head.closest("a")?.getAttribute("href")).toBe(`/w/${WS}/board?panel=conv%3Aconv_1`)
    // The head row stands for the oldest four; the fifth is the ledger's first row.
    expect(screen.queryByText("Reply 4.")).toBeNull()
    expect(screen.getByText("Reply 5.")).toBeTruthy()
  })

  it("does not count a tombstone hidden above the window in the head row", async () => {
    // 20 replies, the second deleted: it falls in the hidden-older range, and
    // `totalReplies` counts tombstones as zero — so must the head row.
    mountCard(await seedLedgerRail(20, { deletedIndex: 1 }))

    expect(await screen.findByText(/^3 earlier · /)).toBeTruthy()
  })

  it("opens a ledger row into the full message in place, and minimizes it back to a lead", async () => {
    mountCard(await seedLedgerRail(8))

    await userEvent.click(await screen.findByText("Reply 3."))
    expect(await screen.findByText("Body of reply 3.")).toBeTruthy()

    await userEvent.click(screen.getByLabelText("Collapse message"))
    await waitFor(() => expect(screen.queryByText("Body of reply 3.")).toBeNull())
    expect(screen.getByText("Reply 3.")).toBeTruthy()
  })

  it("renders a mid-ledger tombstone as a deleted lead", async () => {
    const { container } = mountCard(await seedLedgerRail(8, { deletedIndex: 2 }))

    expect(await screen.findByText("This message was deleted")).toBeTruthy()
    expect(screen.queryByText("Reply 3.")).toBeNull()
    expect(container.querySelector('[data-ledger-row][data-message-id="m_r3"]')).toBeTruthy()
  })

  it("gives a lead no observable row (only a mounted MessageItem carries one), while leads stay inside the card's whole-card read scope", async () => {
    // Auto-read observes `data-message-row` (use-conversation-auto-read), so a lead
    // never DWELLS as an observed row; expanding mounts the real MessageItem, which
    // brings the attribute with it. That is NOT lead-level unread protection: read
    // mechanics are unchanged by the ledger — the leads are still in the card's read
    // set, so the cutoff through a read tail row marks them read exactly as before
    // (whole-card read; lead-granular read waits for sparse-read).
    const hasUnread = vi.fn().mockReturnValue(false)
    vi.spyOn(conversationReadModule, "useConversationReadController").mockReturnValue({
      value: readValue,
      hasUnread,
      markReadSilently: () => Promise.resolve(),
      setExplicitUnreadListener: () => {},
      getReadTruth: () => ({ lastReadSequence: null, readMessageIds: [] }),
    })
    const { container } = mountCard(await seedLedgerRail(8))

    await screen.findByText("Body of reply 8.")
    expect(container.querySelector('[data-message-row][data-message-id="m_r3"]')).toBeNull()
    expect(container.querySelector('[data-ledger-row][data-message-id="m_r3"]')).toBeTruthy()
    // The lead is a rendering choice, not a read-scope one: m_r3 is still one of the
    // card's known messages, so it lights the dot and the cutoff can clear it.
    await waitFor(() =>
      expect(hasUnread.mock.calls.some((call) => (call[0] as { id: string }[]).some((m) => m.id === "m_r3"))).toBe(true)
    )

    await userEvent.click(screen.getByText("Reply 3."))

    await waitFor(() => expect(container.querySelector('[data-message-row][data-message-id="m_r3"]')).toBeTruthy())
  })

  it("gives the first full row after the leads its own header, even when the lead above shares its author", async () => {
    // Adjacency runs over the raw reply run, so the tail's first row would inherit
    // `continuation` from a row that renders as a headerless lead line.
    const { container } = mountCard(await seedLedgerRail(8))

    await screen.findByText("Body of reply 8.")
    const row = container.querySelector('[data-message-row][data-message-id="m_r8"]')
    expect(row).toBeTruthy()
    const accent = row!.querySelector(".reveal-host")
    for (const cls of MESSAGE_ROW_HEAD_PADDING.split(" ")) expect(accent!.className).toContain(cls)
    // ...and not the continuation row's, which carries neither avatar nor author.
    expect(accent!.className).not.toContain(MESSAGE_ROW_CONTINUATION_PADDING)
  })

  it("never demotes a full row to a lead: a newer reply extends the tail instead of rolling it", async () => {
    const post = await seedLedgerRail(8)
    const { container, rerenderPost } = mountCard(post)

    await screen.findByText("Body of reply 8.")
    await waitFor(() => expect(ledgerRows(container).length).toBe(7))

    // A newer reply lands on the rail. A rolling window would demote m_r8 (its
    // MessageItem unmounting, taking any open edit buffer with it); the monotone
    // tail keeps it full and appends the new row.
    await db.events.bulkPut([messageEvent("m_r9", "Reply 9.\n\nBody of reply 9.", 19)])
    const grown = makePost({ messageIds: ["m_open", ...Array.from({ length: 9 }, (_, i) => `m_r${i + 1}`)] })
    ;(grown as unknown as { totalReplies: number }).totalReplies = 9
    act(() => rerenderPost(grown))

    expect(await screen.findByText("Body of reply 9.")).toBeTruthy()
    expect(screen.getByText("Body of reply 8.")).toBeTruthy()
    expect(container.querySelector('[data-message-row][data-message-id="m_r8"]')).toBeTruthy()
    expect(container.querySelector('[data-ledger-row][data-message-id="m_r8"]')).toBeNull()
    expect(ledgerRows(container).length).toBe(7)
  })

  it("re-partitions from scratch when the card is recycled onto another conversation", async () => {
    const { container, rerenderPost } = mountCard(await seedLedgerRail(8))
    await screen.findByText("Body of reply 8.")
    await waitFor(() => expect(ledgerRows(container).length).toBe(7))

    await db.events.bulkPut([
      messageEvent("m2_open", "Other opening.", 40),
      messageEvent("m2_r1", "Other reply 1.\n\nOther body 1.", 41),
      messageEvent("m2_r2", "Other reply 2.\n\nOther body 2.", 42),
    ])
    const other = makePost({ id: "conv_2", messageIds: ["m2_open", "m2_r1", "m2_r2"] }) as BoardViewPost
    ;(other.conversation as unknown as { id: string }).id = "conv_2"
    ;(other as unknown as { openingMessage: BoardPostMessage }).openingMessage = openingMessage({ id: "m2_open" })
    ;(other as unknown as { totalReplies: number }).totalReplies = 2
    act(() => rerenderPost(other))

    // Fresh newest-N partition on the new conversation: one full row, one lead.
    expect(await screen.findByText("Other body 2.")).toBeTruthy()
    await waitFor(() => expect(ledgerRows(container).length).toBe(1))
    expect(screen.queryByText("Other body 1.")).toBeNull()
  })

  it("says it is loading, then offers a retry, when the earlier mass is only on the server", async () => {
    // The rail carries the newest reply only, so the ledger's older rows have to
    // come from the backfill — the wait and its failure take the head row's slot.
    const getBoardMessages = vi.fn().mockRejectedValue(new Error("offline"))
    await db.events.bulkPut([messageEvent("m_open", "Opening body.", 10), messageEvent("m_r9", "Reply 9.", 30)])
    const post = makePost({ messageIds: ["m_open", ...Array.from({ length: 9 }, (_, i) => `m_r${i + 1}`)] })
    ;(post as unknown as { totalReplies: number }).totalReplies = 9
    mountCard(post, { getBoardMessages })

    expect(await screen.findByText("Loading older messages…")).toBeTruthy()
    // The label lands only after the query's single retry (#1714), which waits out
    // TanStack's ~1s backoff — past findByText's default timeout.
    const failed = await screen.findByText("Couldn't load older messages. Retry.", undefined, { timeout: 5000 })
    // One row, whatever it says: no head row beside the failure (INV-21).
    expect(screen.queryByText(/earlier/)).toBeNull()

    getBoardMessages.mockClear()
    await userEvent.click(failed)
    await waitFor(() => expect(getBoardMessages).toHaveBeenCalled())
  })
})

/** Installs a controllable IntersectionObserver: jsdom ships none, and the card
 *  fails open without one. Returns a setter that drives every live observer. */
function stubIntersectionObserver(initiallyIntersecting: boolean) {
  interface Entry {
    isIntersecting: boolean
    target: Element
    boundingClientRect: { top: number }
    rootBounds: { top: number }
  }
  const live = new Set<{ cb: (entries: Entry[]) => void; targets: Set<Element> }>()
  let intersecting = initiallyIntersecting
  let targetTop = 0
  class Stub {
    private entry = { cb: (_: Entry[]) => {}, targets: new Set<Element>() }
    constructor(cb: (entries: Entry[]) => void) {
      this.entry.cb = cb
      live.add(this.entry)
    }
    observe(target: Element) {
      this.entry.targets.add(target)
      this.entry.cb([
        { isIntersecting: intersecting, target, boundingClientRect: { top: targetTop }, rootBounds: { top: 0 } },
      ])
    }
    unobserve(target: Element) {
      this.entry.targets.delete(target)
    }
    disconnect() {
      live.delete(this.entry)
    }
  }
  vi.stubGlobal("IntersectionObserver", Stub)
  return (next: boolean, nextTargetTop = next ? 0 : 1) => {
    intersecting = next
    targetTop = nextTargetTop
    act(() => {
      for (const { cb, targets } of live)
        cb(
          [...targets].map((target) => ({
            isIntersecting: next,
            target,
            boundingClientRect: { top: targetTop },
            rootBounds: { top: 0 },
          }))
        )
    })
  }
}

describe("BoardCard sticky header", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("pins on phone widths and trims only the pinned mobile header", async () => {
    const setIntersecting = stubIntersectionObserver(true)
    mountCard(makePost())

    await screen.findByText("Opening body.")
    const header = document.querySelector<HTMLElement>("[data-board-card-header]")
    expect(header).not.toBeNull()
    expect(header?.className).toContain("sticky")
    expect(header?.className).toContain("top-0")
    expect(header?.className).not.toContain("pt-2")

    setIntersecting(false)
    expect(header?.className).not.toContain("pt-2")

    setIntersecting(false, -1)
    expect(header?.className).toContain("pt-2")
    expect(header?.className).toContain("pb-1.5")
    expect(header?.className).toContain("mb-1.5")
    expect(header?.className).toContain("sm:pt-4")
  })

  it("shows context at rest but drops it from the pinned phone header", async () => {
    const setIntersecting = stubIntersectionObserver(true)
    mountCard(makePost({ topicSummary: "Rotate the API tokens" }))

    const contextRow = (await screen.findByRole("link", { name: "#general" })).parentElement
    const spacer = document.querySelector<HTMLElement>("[data-board-card-context-spacer]")
    expect(contextRow?.className).not.toContain("hidden")
    expect(spacer?.className).toContain("h-0")

    setIntersecting(false, -1)
    expect(contextRow?.className).toContain("hidden")
    expect(contextRow?.className).toContain("sm:flex")
    expect(spacer?.className).toContain("h-6")
  })
})

describe("BoardCard backfill arming", () => {
  afterEach(() => vi.unstubAllGlobals())

  /** A card whose rail has READ and holds the opening, but whose one reply member
   *  is outside the rail's window — the only shape that wants a backfill. */
  async function railResolvedIncompletePost() {
    await db.events.bulkPut([messageEvent("m_open", "Opening body.", 10)])
    const post = makePost({ messageIds: ["m_open", "m_r1"] })
    ;(post as unknown as { totalReplies: number }).totalReplies = 1
    return post
  }

  it("does not fetch on a projection-sourced card: its rail hasn't read yet", async () => {
    // No IDB events at all → `source === "projection"`. Every mounted card firing
    // here was the whole board's mount-time fetch storm.
    stubIntersectionObserver(true)
    const getBoardMessages = vi.fn().mockResolvedValue([])
    const post = makePost({ messageIds: ["m_open", "m_r1"] })
    ;(post as unknown as { totalReplies: number }).totalReplies = 1
    mountCard(post, { getBoardMessages })

    await screen.findByText("Opening body.")
    await waitFor(() => expect(screen.getByText(/1 earlier/)).toBeTruthy())
    expect(getBoardMessages).not.toHaveBeenCalled()
    // ...and it says so honestly: no "Loading…" label with no request behind it.
    expect(screen.queryByText("Loading older messages…")).toBeNull()
  })

  it("does not fetch for a rail-resolved incomplete card while it is off screen", async () => {
    stubIntersectionObserver(false)
    const getBoardMessages = vi.fn().mockResolvedValue([])
    mountCard(await railResolvedIncompletePost(), { getBoardMessages })

    await screen.findByText("Opening body.")
    await waitFor(() => expect(screen.getByText(/1 earlier/)).toBeTruthy())
    expect(getBoardMessages).not.toHaveBeenCalled()
  })

  it("fetches once a rail-resolved incomplete card enters the viewport", async () => {
    const setIntersecting = stubIntersectionObserver(false)
    const getBoardMessages = vi.fn().mockResolvedValue([openingMessage()])
    mountCard(await railResolvedIncompletePost(), { getBoardMessages })

    await screen.findByText("Opening body.")
    expect(getBoardMessages).not.toHaveBeenCalled()

    setIntersecting(true)
    await waitFor(() => expect(getBoardMessages).toHaveBeenCalledTimes(1))
  })

  it("arms the reveal window on the backfill's rising edge, landmarked on a real row, and never while idle", async () => {
    const beginReveal = vi.fn()
    const closeReveal = vi.fn()
    spyOnExport(revealAnchorModule, "useBoardCardRevealAnchor").mockReturnValue((() => ({
      beginReveal,
      closeReveal,
    })) as never)
    stubIntersectionObserver(true)
    // Idle: a complete rail wants no backfill, so nothing arms — a live tail reply
    // must still push the view normally.
    await db.events.bulkPut([messageEvent("m_open", "Opening body.", 10), messageEvent("m_r1", "Reply 1.", 11)])
    const complete = makePost({ messageIds: ["m_open", "m_r1"] })
    ;(complete as unknown as { totalReplies: number }).totalReplies = 1
    const idle = mountCard(complete, { getBoardMessages: vi.fn() })
    await screen.findByText("Reply 1.")
    expect(beginReveal).not.toHaveBeenCalled()
    idle.unmount()

    // In flight: armed, holding a row element that is actually in the document.
    await db.events.clear()
    const getBoardMessages = vi.fn(() => new Promise<never>(() => {}))
    // The rail holds the opening and the newest reply; the older member (m_r1) is
    // only on the server, so it lands ABOVE the tail — the jump this compensates.
    await db.events.bulkPut([messageEvent("m_open", "Opening body.", 10), messageEvent("m_r2", "Reply 2.", 12)])
    const post = makePost({ messageIds: ["m_open", "m_r1", "m_r2"] })
    ;(post as unknown as { totalReplies: number }).totalReplies = 2
    const { container } = mountCard(post, { getBoardMessages })

    await waitFor(() => expect(beginReveal).toHaveBeenCalled())
    const [options] = beginReveal.mock.calls.at(-1) as [{ mode: string; landmark: HTMLElement | null }]
    expect(options.mode).toBe("scroll")
    expect(options.landmark).toBe(container.querySelector('[data-message-row][data-message-id="m_r2"]'))
  })
})

describe("BoardCard — archived is read-only (INV-62)", () => {
  it("replaces the reply affordance with the archived notice", async () => {
    spyOnExport(streamStoreModule, "useStreamFromStore").mockReturnValue(((id: string | undefined) =>
      id === STREAM ? { id: STREAM, type: "channel", archivedAt: "2026-06-23T12:00:00.000Z" } : undefined) as never)
    mountCard()
    expect(
      await screen.findByText("This conversation has been archived. It can be read but not extended.")
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Write a reply…" })).toBeNull()
  })

  it("keeps the reply affordance on an unarchived card", async () => {
    mountCard()
    expect(await screen.findByRole("button", { name: "Write a reply…" })).toBeTruthy()
    expect(screen.queryByText("This conversation has been archived. It can be read but not extended.")).toBeNull()
  })
})

describe("BoardCard — archived gating with no anchor stream row", () => {
  it("seals the card from the post's rootArchived verdict when the anchor row is absent", async () => {
    mountCard({ ...makePost(), rootArchived: true } as BoardViewPost)
    expect(
      await screen.findByText(
        "The stream this conversation belongs to has been archived. It can be read but not extended."
      )
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Write a reply…" })).toBeNull()
  })

  it("offers no branch affordances on an archived card", async () => {
    mountCard({ ...makePost(), rootArchived: true } as BoardViewPost)
    await screen.findByText("Opening body.")

    await userEvent.click(screen.getAllByLabelText("Message actions")[0])
    const entries = (await screen.findAllByRole("menuitem")).map((el) => el.textContent)
    expect(entries.filter((t) => t?.includes("sub-topic"))).toEqual([])
    expect(entries.filter((t) => t?.includes("Quote reply"))).toEqual([])
    expect(screen.queryByTestId("reply-composer-open")).toBeNull()
  })

  it("keeps the branch affordances on an unarchived card", async () => {
    mountCard()
    await screen.findByText("Opening body.")

    await userEvent.click(screen.getAllByLabelText("Message actions")[0])
    const entries = (await screen.findAllByRole("menuitem")).map((el) => el.textContent)
    expect(entries.filter((t) => t?.includes("sub-topic")).length).toBeGreaterThan(0)
    expect(entries.filter((t) => t?.includes("Quote reply")).length).toBeGreaterThan(0)
  })
})
