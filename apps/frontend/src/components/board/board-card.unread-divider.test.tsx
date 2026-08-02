import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
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
import type { RowReadState } from "@/components/timeline/read-frontier-context"
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
const REPLY_IDS = ["r1", "r2", "r3", "r4", "r5"]

function at(seconds: number): string {
  return `2026-06-22T12:00:${String(seconds).padStart(2, "0")}.000Z`
}

function cachedStream(id: string, extra: Partial<CachedStream> = {}): CachedStream {
  return {
    id,
    workspaceId: WS,
    type: StreamTypes.CHANNEL as CachedStream["type"],
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
    ...extra,
  }
}

let seq = 0
function messageEvent(id: string, seconds: number, content: string, streamId: string = STREAM): CachedEvent {
  seq += 1
  return {
    id: `evt_${id}`,
    workspaceId: WS,
    streamId,
    sequence: String(seq),
    _sequenceNum: seq,
    eventType: "message_created" as CachedEvent["eventType"],
    payload: { messageId: id, contentMarkdown: content, reactions: {} } as CachedEvent["payload"],
    actorId: "usr_other",
    actorType: "user",
    createdAt: at(seconds),
    _cachedAt: seq,
  }
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
      messageIds: ["m_open", ...REPLY_IDS],
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
    totalReplies: REPLY_IDS.length,
  } as unknown as CachedBoardPost
}

function tree(cardPost: CachedBoardPost = post()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ServicesProvider services={{ conversations: {} as never }}>
          <MemoryRouter initialEntries={[`/w/${WS}/board`]}>
            <TraceProvider>
              <PanelProvider>
                <MediaGalleryProvider>
                  <BoardCard
                    workspaceId={WS}
                    post={cardPost as BoardViewPost}
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

function mount(cardPost?: CachedBoardPost) {
  return render(tree(cardPost))
}

/** Message ids the fake read state reports as unread; mutated between renders. */
let unreadIds = new Set<string>()
const markReadUpToHere = vi.fn()
const markUnread = vi.fn()
const markReadSilently = vi.fn().mockResolvedValue(undefined)
const readValue = {
  state: (_streamId: string, messageId: string): RowReadState => (unreadIds.has(messageId) ? "unread" : "read"),
  markReadUpToHere,
  markUnread,
}

/** The divider's own label — `bg-background` distinguishes it from any other "New". */
function dividerLabel(): HTMLElement | undefined {
  return screen.queryAllByText("New").find((el) => el.className.includes("bg-background"))
}

function rowFor(messageId: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)
  expect(el, `a row should render for ${messageId}`).toBeTruthy()
  return el!
}

function isBefore(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

function ledgerRow(messageId: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-ledger-row][data-message-id="${messageId}"]`)
  expect(el, `${messageId} should render as a ledger lead`).toBeTruthy()
  return el!
}

let ledgerRowsPref = 15

beforeEach(async () => {
  seq = 0
  unreadIds = new Set()
  ledgerRowsPref = 15
  markReadUpToHere.mockClear()
  markUnread.mockClear()
  markReadSilently.mockClear()
  __clearBoardRailRegistry()
  __clearConversationGraphRegistry()
  await db.events.clear()
  await db.streams.clear()
  await db.conversations.clear()
  await db.streams.put(cachedStream(STREAM))
  await db.events.bulkPut([
    messageEvent("m_open", 0, "Opening the index migration."),
    ...REPLY_IDS.map((id, i) => messageEvent(id, 10 + i, `Reply ${i + 1}.`)),
  ])
  await db.conversations.put(post())
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceMetadata").mockReturnValue(undefined as never)
  // The marker's gate: the card's only stream is decidable (it has a read-state row).
  vi.spyOn(workspaceStoreModule, "useWorkspaceUnreadState").mockReturnValue({
    workspaceId: WS,
    unreadCounts: { [STREAM]: 3 },
    mentionCounts: {},
    messageCounts: { [STREAM]: 6 },
    readMessageIds: {},
  } as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreamReadStates").mockReturnValue([
    {
      id: `${WS}:${STREAM}`,
      workspaceId: WS,
      streamId: STREAM,
      lastReadSequence: "1",
      lastReadAt: at(10),
      lastReadEventId: "evt_r1",
    },
  ] as never)
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
  vi.spyOn(contextsModule, "usePreferences").mockImplementation(
    () =>
      ({
        preferences: { timezone: "UTC", locale: "en-US", boardLedgerRows: ledgerRowsPref },
      }) as unknown as ReturnType<typeof contextsModule.usePreferences>
  )
  vi.spyOn(conversationReadModule, "useConversationReadController").mockReturnValue({
    value: readValue,
    hasUnread: (messages) => messages.some((m) => unreadIds.has(m.id)),
    markReadSilently,
    setExplicitUnreadListener: () => {},
    getReadTruth: () => ({ lastReadSequence: null, readMessageIds: [] }),
  })
})

afterEach(() => vi.restoreAllMocks())

describe("BoardCard unread divider", () => {
  it("draws the New line above the first unread lead when the frontier sits mid-ledger", async () => {
    unreadIds = new Set(["r3", "r4", "r5"])
    mount()
    await screen.findByText("Reply 5.")

    const divider = dividerLabel()
    expect(divider, "the New divider should render").toBeTruthy()
    expect(isBefore(rowFor("r2"), divider!)).toBe(true)
    expect(isBefore(divider!, rowFor("r3"))).toBe(true)
    // Chunk 3's lead tint, wired to the same effective read state.
    expect(ledgerRow("r3").className).toContain("border-destructive/70")
    expect(ledgerRow("r2").className).toContain("border-muted-foreground/20")
  })

  it("draws the New line above the full-tail row when that row is the first unread", async () => {
    unreadIds = new Set(["r5"])
    mount()
    await screen.findByText("Reply 5.")

    const divider = dividerLabel()
    expect(divider).toBeTruthy()
    expect(isBefore(ledgerRow("r4"), divider!)).toBe(true)
    expect(isBefore(divider!, rowFor("r5"))).toBe(true)
  })

  it("draws nothing when every row is read", async () => {
    mount()
    await screen.findByText("Reply 5.")
    expect(dividerLabel()).toBeUndefined()
  })

  it("draws nothing when the first unread sits above the head row's range", async () => {
    // Two ledger lines + one full tail: r1/r2 collapse into the head row's mass,
    // so the marker anchors on a message this card renders no row for. The
    // opening stays READ on purpose — an unread opening would latch there and
    // draw a legitimate divider, hiding the hidden-lead case this asserts.
    ledgerRowsPref = 2
    unreadIds = new Set(REPLY_IDS)
    mount()
    await screen.findByText("Reply 5.")

    expect(document.querySelector('[data-message-id="r1"]')).toBeNull()
    expect(dividerLabel()).toBeUndefined()
  })

  it("draws the New line above the opening on an entirely-unread non-contiguous card", async () => {
    // Hidden older mass makes the card non-contiguous, where the opening renders
    // outside the row builder — the divider must still land above it.
    ledgerRowsPref = 2
    unreadIds = new Set(["m_open", ...REPLY_IDS])
    mount()
    await screen.findByText("Reply 5.")

    const divider = dividerLabel()
    expect(divider, "the New divider should render above the opening").toBeTruthy()
    expect(isBefore(divider!, rowFor("m_open"))).toBe(true)
  })

  it("dims in place once the marker's rows are read, without moving", async () => {
    unreadIds = new Set(["r3", "r4", "r5"])
    const { rerender } = mount()
    await screen.findByText("Reply 5.")
    expect(dividerLabel()!.parentElement!.className).toContain("text-destructive")
    expect(isBefore(dividerLabel()!, rowFor("r3"))).toBe(true)

    // Read past the marker. Re-render, never re-mount: the latch is per open.
    unreadIds = new Set()
    rerender(tree())

    const after = dividerLabel()
    expect(after, "the divider stays for this open").toBeTruthy()
    expect(after!.parentElement!.className).toContain("text-muted-foreground")
    expect(after!.parentElement!.className).not.toContain("text-destructive")
    expect(isBefore(rowFor("r2"), after!)).toBe(true)
    expect(isBefore(after!, rowFor("r3"))).toBe(true)
  })

  it("skips an unread swallowed by a depth-collapsed subtree and lands on the first rendered one", async () => {
    // stream_1 › thread_1 › thread_2 › thread_3: the depth-3 subtree collapses to
    // one "continue thread" row, so t3 gets no message row. A marker latched
    // there would draw nothing and never correct itself.
    await db.events.clear()
    await db.conversations.clear()
    await db.streams.bulkPut([
      cachedStream(STREAM),
      cachedStream("thread_1", {
        type: StreamTypes.THREAD as CachedStream["type"],
        parentStreamId: STREAM,
        rootStreamId: STREAM,
        parentMessageId: "m_open",
      }),
      cachedStream("thread_2", {
        type: StreamTypes.THREAD as CachedStream["type"],
        parentStreamId: "thread_1",
        rootStreamId: STREAM,
        parentMessageId: "t1",
      }),
      cachedStream("thread_3", {
        type: StreamTypes.THREAD as CachedStream["type"],
        parentStreamId: "thread_2",
        rootStreamId: STREAM,
        parentMessageId: "t2",
      }),
    ])
    await db.events.bulkPut([
      messageEvent("m_open", 0, "Opening the index migration."),
      messageEvent("t1", 10, "Depth one.", "thread_1"),
      messageEvent("t2", 11, "Depth two.", "thread_2"),
      messageEvent("t3", 12, "Depth three.", "thread_3"),
      messageEvent("r_late", 13, "Back on the base level."),
    ])
    const deepPost = {
      ...post(),
      streamIds: [STREAM, "thread_1", "thread_2", "thread_3"],
      conversation: { ...post().conversation, messageIds: ["m_open", "t1", "t2", "t3", "r_late"] },
      totalReplies: 4,
    } as unknown as CachedBoardPost
    await db.conversations.put(deepPost)
    // Every stream the rows sit on must be decidable, or the marker never latches.
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreamReadStates").mockReturnValue(
      [STREAM, "thread_1", "thread_2", "thread_3"].map((streamId) => ({
        id: `${WS}:${streamId}`,
        workspaceId: WS,
        streamId,
        lastReadSequence: "1",
        lastReadAt: at(10),
        lastReadEventId: "evt_r1",
      })) as never
    )
    unreadIds = new Set(["t3", "r_late"])

    mount(deepPost)
    await screen.findByText("Back on the base level.")

    expect(document.querySelector('[data-message-id="t3"]')).toBeNull()
    const divider = dividerLabel()
    expect(divider, "the divider should land on the first row-rendered unread").toBeTruthy()
    expect(isBefore(divider!, rowFor("r_late"))).toBe(true)
  })

  it("never marks anything read", async () => {
    unreadIds = new Set(["r3", "r4", "r5"])
    mount()
    await screen.findByText("Reply 5.")

    expect(markReadSilently).not.toHaveBeenCalled()
    expect(markReadUpToHere).not.toHaveBeenCalled()
    expect(markUnread).not.toHaveBeenCalled()
  })
})
