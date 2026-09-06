import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StreamTypes, type BoardMassBadge } from "@threahq/types"
import { BoardCard } from "./board-card"
import type { BoardViewPost } from "@/hooks/use-stable-board-view"
import { ServicesProvider, PanelProvider, TraceProvider, MediaGalleryProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import { __clearBoardRailRegistry } from "@/hooks/use-board-card-messages"
import { resetBoardUnreadLatches } from "@/stores/board-unread-latch-store"
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

function cachedStream(id: string): CachedStream {
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
  }
}

let seq = 0
function messageEvent(id: string, seconds: number, content: string): CachedEvent {
  seq += 1
  return {
    id: `evt_${id}`,
    workspaceId: WS,
    streamId: STREAM,
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

/** Reply bodies by id; a test overrides them to drive the minutes estimate. */
let replyBody = (index: number) => `Reply ${index + 1}.`

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

function tree() {
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

function mount() {
  return render(tree())
}

/** The badge's reserved header slot — present whether or not it holds a pill. */
function badgeSlot(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-mass-badge-slot]")
  expect(el, "the header should always carry the badge slot").toBeTruthy()
  return el!
}

function badgeText(): string | null {
  return badgeSlot().textContent || null
}

function dividerLabel(): HTMLElement | undefined {
  return screen.queryAllByText("New").find((el) => el.className.includes("bg-background"))
}

let unreadIds = new Set<string>()
let ledgerRowsPref = 15
let massBadgePref: BoardMassBadge = "count"
const readValue = {
  state: (_streamId: string, messageId: string): RowReadState => (unreadIds.has(messageId) ? "unread" : "read"),
  markReadUpToHere: vi.fn(),
  markUnread: vi.fn(),
}

beforeEach(async () => {
  seq = 0
  unreadIds = new Set()
  ledgerRowsPref = 15
  massBadgePref = "count"
  replyBody = (index) => `Reply ${index + 1}.`
  __clearBoardRailRegistry()
  resetBoardUnreadLatches()
  __clearConversationGraphRegistry()
  await db.events.clear()
  await db.streams.clear()
  await db.conversations.clear()
  await db.streams.put(cachedStream(STREAM))
  await db.conversations.put(post())
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceMetadata").mockReturnValue(undefined as never)
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
        preferences: {
          timezone: "UTC",
          locale: "en-US",
          boardLedgerRows: ledgerRowsPref,
          boardMassBadge: massBadgePref,
        },
      }) as unknown as ReturnType<typeof contextsModule.usePreferences>
  )
  vi.spyOn(conversationReadModule, "useConversationReadController").mockReturnValue({
    value: readValue,
    hasUnread: (messages) => messages.some((m) => unreadIds.has(m.id)),
    markReadSilently: vi.fn().mockResolvedValue(undefined),
    setExplicitUnreadListener: () => {},
    getReadTruth: () => ({ lastReadSequence: null, readMessageIds: [] }),
  })
})

/** Seed the rail after the per-test bodies are chosen. */
async function seedRail() {
  await db.events.bulkPut([
    messageEvent("m_open", 0, "Opening the index migration."),
    ...REPLY_IDS.map((id, i) => messageEvent(id, 10 + i, replyBody(i))),
  ])
}

afterEach(() => vi.restoreAllMocks())

describe("BoardCard mass badge", () => {
  it("counts the unread rows only, whatever their length", async () => {
    // The read rows are far longer than the unread ones, so a badge measuring
    // the whole card would report something other than a count of two.
    replyBody = (index) => (index >= 3 ? "u".repeat(1200) : "r".repeat(4000))
    await seedRail()
    unreadIds = new Set(["r4", "r5"])
    mount()
    await screen.findByText("u".repeat(1200))

    expect(badgeText()).toBe("2 new")
  })

  it("reads a stored count-minutes preference as the count mode", async () => {
    replyBody = () => "x".repeat(1200)
    massBadgePref = "count-minutes" as BoardMassBadge
    await seedRail()
    unreadIds = new Set(["r3", "r4", "r5"])
    mount()
    await screen.findByText("x".repeat(1200))

    expect(badgeText()).toBe("3 new")
  })

  it("hides the badge entirely when the preference is off", async () => {
    massBadgePref = "off"
    await seedRail()
    unreadIds = new Set(["r3", "r4", "r5"])
    mount()
    await screen.findByText("Reply 5.")

    expect(badgeText()).toBeNull()
  })

  it("hides the badge when nothing is unread, keeping the slot", async () => {
    await seedRail()
    mount()
    await screen.findByText("Reply 5.")

    expect(badgeText()).toBeNull()
    expect(badgeSlot()).toBeTruthy()
  })

  it("counts unread hidden behind the head row, where the divider draws nothing", async () => {
    // Two ledger lines + the full tail: r1/r2 collapse into the head row's mass,
    // so the divider can't render — the badge is the only signal for that mass.
    ledgerRowsPref = 2
    await seedRail()
    unreadIds = new Set(REPLY_IDS)
    mount()
    await screen.findByText("Reply 5.")

    expect(document.querySelector('[data-message-id="r1"]')).toBeNull()
    expect(dividerLabel()).toBeUndefined()
    expect(badgeText()).toBe("5 new")
  })

  it("decays live as rows are read, without latching", async () => {
    await seedRail()
    unreadIds = new Set(["r3", "r4", "r5"])
    const { rerender } = mount()
    await screen.findByText("Reply 5.")
    expect(badgeText()).toBe("3 new")

    unreadIds = new Set(["r5"])
    rerender(tree())
    expect(badgeText()).toBe("1 new")

    unreadIds = new Set()
    rerender(tree())
    expect(badgeText()).toBeNull()
  })

  it("keeps the header structure identical with and without the badge", async () => {
    await seedRail()
    unreadIds = new Set(["r5"])
    const { rerender } = mount()
    await screen.findByText("Reply 5.")
    const shape = (): string[] =>
      [...badgeSlot().parentElement!.children].map((el) => (el as HTMLElement).tagName + ":" + el.getAttribute("class"))
    const withBadge = shape()
    expect(badgeText()).toBe("1 new")

    unreadIds = new Set()
    rerender(tree())

    expect(badgeText()).toBeNull()
    expect(shape()).toEqual(withBadge)
  })
})
