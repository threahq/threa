import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StreamTypes } from "@threa/types"
import { BoardCard } from "./board-card"
import type { BoardViewPost } from "@/hooks/use-stable-board-view"
import { ServicesProvider, PanelProvider, TraceProvider, MediaGalleryProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import { __clearBoardRailRegistry } from "@/hooks/use-board-card-messages"
import { __clearConversationGraphRegistry } from "@/hooks/use-conversation-graph"
// eslint-disable-next-line no-restricted-imports -- test seeds IDB directly to drive the real rail + graph read paths
import { db, type CachedEvent, type CachedStream, type CachedBoardPost } from "@/db"
import * as conversationReadModule from "@/components/message/conversation-read-context"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as messageReactionsModule from "@/hooks/use-message-reactions"
import * as userProfileModule from "@/components/user-profile"
import * as syncEngineModule from "@/sync/sync-engine"
import * as contextsModule from "@/contexts"
import * as queueDraftModule from "@/hooks/use-queue-draft-message"

const WS = "ws_1"
const CONV = "conv_1"
const STREAM = "stream_1"

function at(seconds: number): string {
  return `2026-06-22T12:00:${String(seconds).padStart(2, "0")}.000Z`
}

function cachedStream(id: string, type: string): CachedStream {
  return {
    id,
    workspaceId: WS,
    type: type as CachedStream["type"],
    displayName: null,
    slug: null,
    description: null,
    visibility: "public",
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "usr_me",
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: null,
    _cachedAt: 0,
  }
}

let seq = 0
function event(eventType: string, seconds: number, payload: unknown, id?: string): CachedEvent {
  seq += 1
  return {
    id: id ?? `evt_${seq}`,
    workspaceId: WS,
    streamId: STREAM,
    sequence: String(seq),
    _sequenceNum: seq,
    eventType: eventType as CachedEvent["eventType"],
    payload: payload as CachedEvent["payload"],
    actorId: "usr_other",
    actorType: "user",
    createdAt: at(seconds),
    _cachedAt: seq,
  }
}

function messageEvent(id: string, seconds: number, content: string): CachedEvent {
  return event("message_created", seconds, { messageId: id, contentMarkdown: content, reactions: {} }, `evt_${id}`)
}

function memoEvent(id: string, seconds: number, memoId: string, title: string): CachedEvent {
  return event(
    "memos:captured",
    seconds,
    { conversationId: CONV, memos: [{ memoId, title, knowledgeType: "fact", sourceMessageIds: ["r1"] }] },
    id
  )
}

function post(): CachedBoardPost {
  return {
    id: CONV,
    workspaceId: WS,
    _lastActivityMs: 0,
    _cachedAt: 0,
    streamIds: [STREAM],
    rootStreamId: STREAM,
    rootStreamType: "channel",
    hasCapturedMemo: false,
    conversation: {
      id: CONV,
      streamId: STREAM,
      workspaceId: WS,
      messageIds: ["m_open", "r1", "r2", "r3"],
      participantIds: [],
      secondaryMessageIds: [],
      topicSummary: "Index migration",
      completenessScore: 0,
      confidence: 1,
      status: "active",
      parentConversationId: null,
      lastActivityAt: at(0),
      createdAt: at(0),
      updatedAt: at(0),
      temporalStaleness: 0,
      effectiveCompleteness: 0,
    },
    openingMessage: {
      id: "m_open",
      streamId: STREAM,
      authorId: "usr_other",
      authorType: "user",
      contentMarkdown: "Opening the index migration.",
      reactions: {},
      attachments: [],
      linkPreviews: [],
      createdAt: at(0),
      editedAt: null,
    },
    recentMessages: [],
    totalReplies: 3,
  } as unknown as CachedBoardPost
}

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ServicesProvider services={{ conversations: {} as never }}>
          <MemoryRouter initialEntries={[`/w/${WS}/board`]}>
            <TraceProvider>
              <PanelProvider>
                <MediaGalleryProvider>
                  <BoardCard
                    workspaceId={WS}
                    post={post() as BoardViewPost}
                    contextLabel="#general"
                    streamType="channel"
                  />
                </MediaGalleryProvider>
              </PanelProvider>
            </TraceProvider>
          </MemoryRouter>
        </ServicesProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

const readValue = { state: () => "ungated" as const, markReadUpToHere: vi.fn(), markUnread: vi.fn() }

beforeEach(async () => {
  seq = 0
  __clearBoardRailRegistry()
  __clearConversationGraphRegistry()
  await db.events.clear()
  await db.streams.clear()
  await db.conversations.clear()
  await db.streams.put(cachedStream(STREAM, StreamTypes.CHANNEL))
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceMetadata").mockReturnValue(undefined as never)
  vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue("usr_me")
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
  vi.spyOn(conversationReadModule, "useConversationReadController").mockReturnValue({
    value: readValue,
    hasUnread: () => false,
    markReadSilently: () => Promise.resolve(),
    setExplicitUnreadListener: () => {},
    getReadTruth: () => ({ lastReadSequence: null, readMessageIds: [] }),
  })
})

afterEach(() => vi.restoreAllMocks())

/** Rendered order of the card's text, so a row's placement is assertable. */
function textOrder(...needles: string[]): number[] {
  const body = document.body.textContent ?? ""
  return needles.map((needle) => body.indexOf(needle))
}

describe("BoardCard ledger events", () => {
  it("renders a capture between the ledger messages as a thin title-only line linking to the memo", async () => {
    await db.events.bulkPut([
      messageEvent("r1", 10, "First reply."),
      memoEvent("evt_memo", 11, "memo_9", "Postgres upserts need the index"),
      messageEvent("r2", 12, "Second reply."),
      messageEvent("r3", 13, "Third reply."),
    ])
    await db.conversations.put(post())
    mount()

    const link = await screen.findByRole("link", { name: /Memo: Postgres upserts need the index/ })
    expect(link).toHaveAttribute("href", "/w/ws_1/memory?memo=memo_9")
    // The full capture row's phrasing (and its memo-opening buttons) is not what
    // a ledger line renders — title only, never the memo body.
    expect(screen.queryByText(/Saved to memory/)).toBeNull()

    const [first, memo, second] = textOrder("First reply.", "Memo: Postgres upserts need the index", "Second reply.")
    expect(first).toBeGreaterThan(-1)
    expect(memo).toBeGreaterThan(first)
    expect(second).toBeGreaterThan(memo)
  })

  it("coalesces a run of three ledger events into one row that expands and re-coalesces", async () => {
    await db.events.bulkPut([
      messageEvent("r1", 10, "First reply."),
      memoEvent("evt_a", 11, "memo_1", "Alpha"),
      memoEvent("evt_b", 12, "memo_2", "Beta"),
      memoEvent("evt_c", 13, "memo_3", "Gamma"),
      messageEvent("r2", 14, "Second reply."),
      messageEvent("r3", 15, "Third reply."),
    ])
    await db.conversations.put(post())
    mount()

    const summary = await screen.findByRole("button", { name: /3 events —/ })
    expect(summary).toHaveTextContent("3 events — Memo: Alpha · Memo: Beta · Memo: Gamma")
    await userEvent.click(summary)

    const group = screen.getByRole("button", { name: "3 events" }).parentElement as HTMLElement
    expect(within(group).getAllByRole("link")).toHaveLength(3)
    expect(within(group).getByRole("link", { name: /Memo: Beta/ })).toHaveAttribute(
      "href",
      "/w/ws_1/memory?memo=memo_2"
    )

    await userEvent.click(screen.getByRole("button", { name: "3 events" }))
    expect(screen.getByRole("button", { name: /3 events —/ })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /Memo: Beta/ })).toBeNull()
  })

  it("keeps an event in the full-tail region fully rendered", async () => {
    await db.events.bulkPut([
      messageEvent("r1", 10, "First reply."),
      messageEvent("r2", 11, "Second reply."),
      messageEvent("r3", 12, "Third reply."),
      memoEvent("evt_tail", 13, "memo_9", "Postgres upserts need the index"),
    ])
    await db.conversations.put(post())
    mount()

    // The full capture row (title as a preview-opening button), not a thin line.
    expect(await screen.findByText(/Saved to memory/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Postgres upserts need the index" })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /Memo: Postgres upserts need the index/ })).toBeNull()
  })
})
