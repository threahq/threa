import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardPostMessage } from "@threa/types"
import { BoardCard } from "./board-card"
import type { BoardViewPost } from "@/hooks/use-stable-board-view"
import { ServicesProvider, PanelProvider, TraceProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import { __clearBoardRailRegistry } from "@/hooks/use-board-card-messages"
import { __clearConversationGraphRegistry } from "@/hooks/use-conversation-graph"
// eslint-disable-next-line no-restricted-imports -- test seeds IDB directly to drive the real rail read path
import { db, type CachedEvent } from "@/db"
import * as conversationReadModule from "@/components/message/conversation-read-context"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as messageReactionsModule from "@/hooks/use-message-reactions"
import * as userProfileModule from "@/components/user-profile"
import * as syncEngineModule from "@/sync/sync-engine"
import * as contextsModule from "@/contexts"

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

function mountCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ServicesProvider services={{ conversations: {} as never }}>
          <MemoryRouter initialEntries={[`/w/${WS}/board`]}>
            <TraceProvider>
              <PanelProvider>
                <BoardCard workspaceId={WS} post={makePost()} contextLabel="#general" streamType="channel" />
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
  eventType: "agent_session:started" | "agent_session:completed",
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

const readValue = { state: () => "ungated" as const, markReadUpToHere: vi.fn(), markUnread: vi.fn() }

beforeEach(async () => {
  __clearBoardRailRegistry()
  __clearConversationGraphRegistry()
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
