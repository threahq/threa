import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import { Fragment, createElement } from "react"
import * as boardFeedListModule from "@/components/board/board-feed-list"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardPost, BoardPostMessage, BoardView, ConversationWithStaleness } from "@threahq/types"
import { BoardPage } from "./board"
import * as boardStoreModule from "@/stores/board-store"
import { ServicesProvider, SidebarProvider, PanelProvider, MediaGalleryProvider, TraceProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import { workspaceKeys } from "@/hooks/use-workspaces"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as messageReactionsModule from "@/hooks/use-message-reactions"
import * as syncEngineModule from "@/sync/sync-engine"
import * as userProfileModule from "@/components/user-profile"
import * as contextsModule from "@/contexts"
import * as queueDraftModule from "@/hooks/use-queue-draft-message"
import * as pointerModule from "@/hooks/use-pointer"
import * as panelHostModule from "@/components/layout/panel-host"
// eslint-disable-next-line no-restricted-imports -- test seeds IDB directly to drive the real rail read path
import { db } from "@/db"
import { __resetConversationMessageSnapshots, seedConversationMessages } from "@/stores/conversation-messages-store"
import { __clearBoardDraftsRegistry } from "@/hooks/use-scope-draft-preview"
import { boardReplyDraftKey, boardBranchReplyDraftKey, boardSubtopicDraftKey } from "@/lib/board/draft-keys"

const WORKSPACE_ID = "ws_1"

function makeConversation(overrides: Partial<ConversationWithStaleness> = {}): ConversationWithStaleness {
  const now = "2026-06-22T12:00:00.000Z"
  return {
    id: "conv_1",
    streamId: "stream_1",
    workspaceId: WORKSPACE_ID,
    messageIds: ["msg_1", "msg_2", "msg_3"],
    participantIds: ["usr_me"],
    secondaryMessageIds: [],
    topicSummary: "CC Teams tokens",
    summary: null,
    completenessScore: 4,
    confidence: 0.8,
    status: "active",
    parentConversationId: null,
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
    temporalStaleness: 0,
    effectiveCompleteness: 4,
    ...overrides,
  }
}

function makeOpeningMessage(overrides: Partial<BoardPostMessage> = {}): BoardPostMessage {
  return {
    id: "msg_1",
    streamId: "stream_1",
    // usr_me isn't in the mocked user cache, so the author renders as a short id
    // — distinct from any DM-peer name asserted on elsewhere.
    authorId: "usr_me",
    authorType: "user",
    contentMarkdown: "Opening message body.",
    reactions: {},
    attachments: [],
    linkPreviews: [],
    createdAt: "2026-06-22T12:00:00.000Z",
    editedAt: null,
    ...overrides,
  }
}

function makePost(
  convOverrides: Partial<ConversationWithStaleness> = {},
  msgOverrides: Partial<BoardPostMessage> | null = {},
  recentMessages: BoardPostMessage[] = [],
  totalReplies?: number
): BoardPost {
  const conversation = makeConversation(convOverrides)
  const openingMessage =
    msgOverrides === null ? null : makeOpeningMessage({ streamId: conversation.streamId, ...msgOverrides })
  return {
    conversation,
    openingMessage,
    recentMessages,
    // Default mirrors a non-thread post: every message after the origin is a reply.
    totalReplies: totalReplies ?? Math.max(0, conversation.messageIds.length - 1),
    // The streams the card reads — anchor plus any opening/recent message's stream.
    streamIds: [
      ...new Set([
        conversation.streamId,
        ...(openingMessage ? [openingMessage.streamId] : []),
        ...recentMessages.map((m) => m.streamId),
      ]),
    ],
    hasCapturedMemo: false,
    settlingMessageIds: [],
    isMine: false,
  }
}

function makeBoardView(overrides: Partial<BoardView> = {}): BoardView {
  return {
    id: "boardview_1",
    name: "Channels, mine",
    baseLens: "mine",
    scopeStreamIds: [],
    scopeStreamTypes: ["channel"],
    scopeLabelIds: [],
    excludeStreamIds: [],
    excludeStreamTypes: [],
    excludeLabelIds: [],
    sortOrder: 0,
    ...overrides,
  }
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>
}

function mountBoard(
  posts: BoardPost[],
  opts: {
    nextCursor?: string | null
    fail?: boolean
    failMessages?: boolean
    /** URL to mount at — set `/w/<ws>/board?lens=<lens>` to exercise a lens. */
    entry?: string
    /** Seeds the saved-view list into the bootstrap cache (what `useBoardViews` reads). */
    boardViews?: BoardView[]
    /** What the server backfill returns for a card whose rail misses members. */
    boardMessages?: BoardPostMessage[]
  } = {}
) {
  const {
    nextCursor = null,
    fail = false,
    failMessages = false,
    entry = `/w/${WORKSPACE_ID}/board`,
    boardViews,
    boardMessages = [],
  } = opts
  const listByWorkspace = vi.fn(async () => {
    if (fail) throw new Error("boom")
    return { posts, nextCursor }
  })
  const getBoardMessages = vi.fn(async () => {
    if (failMessages) throw new Error("boom")
    return boardMessages
  })
  // The board reads its feed reactively from the conversations IDB store; mock
  // that store hook to return the test's posts (the IDB read/sort/merge path is
  // covered directly in board-store.test). The query still seeds IDB and drives
  // pagination/loading/error, so `listByWorkspace` is exercised as before.
  vi.spyOn(boardStoreModule, "useBoardPosts").mockReturnValue(posts as never)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // `boardViews` seeds the saved-view list `useBoardViews` reads from bootstrap.
  queryClient.setQueryData(workspaceKeys.bootstrap(WORKSPACE_ID), {
    boardViews: boardViews ?? [],
  })
  const buildTree = () => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ServicesProvider services={{ conversations: { listByWorkspace, getBoardMessages } as never }}>
          <SidebarProvider>
            <MemoryRouter initialEntries={[entry]}>
              <TraceProvider>
                <PanelProvider>
                  <MediaGalleryProvider>
                    <LocationProbe />
                    <Routes>
                      <Route path="/w/:workspaceId/board" element={<BoardPage />} />
                    </Routes>
                  </MediaGalleryProvider>
                </PanelProvider>
              </TraceProvider>
            </MemoryRouter>
          </SidebarProvider>
        </ServicesProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
  const { rerender } = render(buildTree())
  // Re-render with a FRESH element tree: handing `rerender` the same element
  // object bails out of reconciliation, so the new feed would never be read.
  const rerenderWith = (nextPosts: BoardPost[]) => {
    vi.spyOn(boardStoreModule, "useBoardPosts").mockReturnValue(nextPosts as never)
    rerender(buildTree())
  }
  return { listByWorkspace, tree: buildTree(), rerender, rerenderWith }
}

beforeEach(async () => {
  // The rail reads real IDB — a seeded event must not leak into the next test.
  await db.events.clear()
  await db.conversationMessages.clear()
  __resetConversationMessageSnapshots()
  // `virtua` renders zero items under jsdom's zero-height, no-op-ResizeObserver
  // layout, so swap the board's virtualization seam for a passthrough that renders
  // every child — these integration tests exercise the real cards; the windowing
  // itself is verified in a browser.
  vi.spyOn(boardFeedListModule, "BoardFeedList").mockImplementation(({ children }) =>
    createElement(Fragment, null, children)
  )
  // BoardCard resolves the stream label + author + emoji via the workspace caches.
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceMetadata").mockReturnValue(undefined as never)
  // BoardCard reads the viewer id for reaction state; sourced from auth, which
  // isn't mounted in this harness.
  vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue("usr_me")
  // BoardCard hosts the inline branch composer, whose queue hook needs the
  // pending-messages provider — stub the hook so the harness stays lean.
  vi.spyOn(queueDraftModule, "useQueueDraftMessage").mockReturnValue({
    queueDraftMessage: vi.fn().mockResolvedValue({ clientId: "client_1" }),
    currentUserId: "usr_me",
  } as unknown as ReturnType<typeof queueDraftModule.useQueueDraftMessage>)
  // Reactions reuse the timeline's <MessageReactions>, whose toggle hook reaches
  // for the SyncEngine. Stub the hook so the real component still renders.
  vi.spyOn(messageReactionsModule, "useMessageReactions").mockReturnValue({
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    toggleReaction: vi.fn(),
    toggleByEmoji: vi.fn(),
  } as unknown as ReturnType<typeof messageReactionsModule.useMessageReactions>)
  // The board declares its on-screen card streams to the SyncEngine to keep them
  // live; the engine isn't wired in this harness, so stub the hook.
  vi.spyOn(syncEngineModule, "useSyncEngine").mockReturnValue({
    setBoardStreamIds: vi.fn(),
    setPanelStreamIds: vi.fn(),
  } as unknown as ReturnType<typeof syncEngineModule.useSyncEngine>)
  // Author names open the profile via UserProfileProvider, not mounted here.
  vi.spyOn(userProfileModule, "useUserProfile").mockReturnValue({ openUserProfile: vi.fn() })
  // RelativeTime reads timezone/locale from the preferences context.
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { timezone: "UTC", locale: "en-US" },
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  // BoardPage resolves the home (bare `/board` entry alias) from the
  // preferences context; default to All.
  vi.spyOn(contextsModule, "usePreferencesOptional").mockReturnValue({
    preferences: { boardDefaultLens: "all" },
  } as unknown as ReturnType<typeof contextsModule.usePreferencesOptional>)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("BoardPage", () => {
  it("renders the empty state when there are no conversations", async () => {
    mountBoard([])
    expect(await screen.findByText("Nothing on the board yet")).toBeTruthy()
  })

  it("captures stray typing into the feed's composer zone (type-to-focus is mounted)", async () => {
    mountBoard([makePost({}, { contentMarkdown: "Rotate the tokens before Friday." })])
    await screen.findByText("Rotate the tokens before Friday.")

    const zone = document.querySelector<HTMLElement>('main[data-editor-zone="main"]')
    expect(zone).not.toBeNull()
    const editor = document.createElement("div")
    editor.setAttribute("contenteditable", "true")
    // jsdom gives everything zero client rects; the zone lookup takes the last
    // editor that is rendered AND on screen, so this stand-in has to report both.
    Object.defineProperty(editor, "getClientRects", { value: () => [{ width: 10, height: 10 }] })
    Object.defineProperty(editor, "getBoundingClientRect", {
      value: () => ({ top: 100, bottom: 140, left: 0, right: 300 }),
    })
    zone!.appendChild(editor)

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }))
    })

    expect(document.activeElement).toBe(editor)
  })

  it("renders the opening-message body", async () => {
    mountBoard([makePost({}, { contentMarkdown: "Rotate the tokens before Friday." })])
    expect(await screen.findByText("Rotate the tokens before Friday.")).toBeTruthy()
  })

  it("shows only the viewer's own conversations on the Mine lens", async () => {
    // Server precomputes `isMine`; the Mine lens is wired into the same
    // client filter (`matchesBoardLens`) the other lenses ride, keyed off the
    // `?lens=mine` query param.
    const mine = { ...makePost({ id: "conv_mine" }, { contentMarkdown: "My own topic." }), isMine: true }
    const notMine = { ...makePost({ id: "conv_other" }, { contentMarkdown: "Someone else's topic." }), isMine: false }
    mountBoard([mine, notMine], { entry: `/w/${WORKSPACE_ID}/board?lens=mine` })

    expect(await screen.findByText("My own topic.")).toBeTruthy()
    expect(screen.queryByText("Someone else's topic.")).toBeNull()
  })

  it("lands the bare `/board` entry alias on the viewer's home-lens preference", async () => {
    // boardDefaultLens picks where the query-less entry redirects; here Mine, so
    // the entry resolves to `?lens=mine` and filters down to the viewer's own
    // conversations.
    vi.mocked(contextsModule.usePreferencesOptional).mockReturnValue({
      preferences: { boardDefaultLens: "mine" },
    } as unknown as ReturnType<typeof contextsModule.usePreferencesOptional>)
    const mine = { ...makePost({ id: "conv_mine" }, { contentMarkdown: "My own topic." }), isMine: true }
    const notMine = { ...makePost({ id: "conv_other" }, { contentMarkdown: "Someone else's topic." }), isMine: false }
    mountBoard([mine, notMine], { entry: `/w/${WORKSPACE_ID}/board` })

    expect(await screen.findByText("My own topic.")).toBeTruthy()
    expect(screen.queryByText("Someone else's topic.")).toBeNull()
  })

  it("bounces bare `/board` to the saved-view home when one is set", async () => {
    // boardDefaultViewId names a saved view; the bare `/board` resolves it to the
    // view's canonical filtered URL (base lens segment + `?is=channel`).
    vi.mocked(contextsModule.usePreferencesOptional).mockReturnValue({
      preferences: { boardDefaultLens: "all", boardDefaultViewId: "boardview_1" },
    } as unknown as ReturnType<typeof contextsModule.usePreferencesOptional>)
    mountBoard([], { boardViews: [makeBoardView()] })
    const probe = await screen.findByTestId("location")
    await vi.waitFor(() => expect(probe.textContent).toBe(`/w/${WORKSPACE_ID}/board?lens=mine&is=channel`))
  })

  it("offers 'Show everything' on the viewer's own empty saved-view home (its filters are clearable)", async () => {
    // The saved-view home is itself a narrowing. The old home-relative baseline
    // treated it as unfiltered — which made its filters unclearable (the bounce
    // Kris hit). Absolute baseline: the CTA shows, targeting explicit ?lens=all.
    vi.mocked(contextsModule.usePreferences).mockReturnValue({
      preferences: { timezone: "UTC", locale: "en-US", boardDefaultLens: "all", boardDefaultViewId: "boardview_1" },
    } as unknown as ReturnType<typeof contextsModule.usePreferences>)
    vi.mocked(contextsModule.usePreferencesOptional).mockReturnValue({
      preferences: { boardDefaultLens: "all", boardDefaultViewId: "boardview_1" },
    } as unknown as ReturnType<typeof contextsModule.usePreferencesOptional>)
    // The saved view's own URL (`makeBoardView` → active + `?is=channel`).
    mountBoard([], { boardViews: [makeBoardView()], entry: `/w/${WORKSPACE_ID}/board?lens=mine&is=channel` })
    expect(await screen.findByText("Nothing here right now")).toBeTruthy()
    const cta = await screen.findByRole("link", { name: "Show everything" })
    expect(cta.getAttribute("href")).toBe(`/w/${WORKSPACE_ID}/board?lens=all`)
  })

  it("stays put when a saved view is pinned as home while on an explicit board URL", async () => {
    // Pinning a view as home is a preference change, not a navigation. Rendered
    // board URLs always carry `?lens=`, so the entry-alias redirect (which only
    // fires on the query-less path) can never yank the viewer off the page.
    vi.mocked(contextsModule.usePreferencesOptional).mockReturnValue({
      preferences: { boardDefaultLens: "all", boardDefaultViewId: null },
    } as unknown as ReturnType<typeof contextsModule.usePreferencesOptional>)
    const post = makePost({ id: "conv_x" }, { contentMarkdown: "Board still here." })
    const { tree, rerender } = mountBoard([post], {
      boardViews: [makeBoardView()],
      entry: `/w/${WORKSPACE_ID}/board?lens=all`,
    })
    expect(await screen.findByText("Board still here.")).toBeTruthy()

    // Pin a saved view as home — same URL, no navigation.
    vi.mocked(contextsModule.usePreferencesOptional).mockReturnValue({
      preferences: { boardDefaultLens: "all", boardDefaultViewId: "boardview_1" },
    } as unknown as ReturnType<typeof contextsModule.usePreferencesOptional>)
    rerender(tree)

    expect(screen.getByTestId("location").textContent).toBe(`/w/${WORKSPACE_ID}/board?lens=all`)
    expect(screen.getByText("Board still here.")).toBeTruthy()
  })

  it("shows the empty state without a 'Show everything' CTA on the unfiltered All lens", async () => {
    mountBoard([], { entry: `/w/${WORKSPACE_ID}/board?lens=all` })
    expect(await screen.findByText("Nothing on the board yet")).toBeTruthy()
    expect(screen.queryByText("Show everything")).toBeNull()
  })

  it("shows 'Show everything' on an empty non-All lens", async () => {
    mountBoard([], { entry: `/w/${WORKSPACE_ID}/board?lens=mine` })
    expect(await screen.findByText("Nothing here for you yet")).toBeTruthy()
    expect(await screen.findByText("Show everything")).toBeTruthy()
  })

  it("offers an inline reply affordance on each post", async () => {
    mountBoard([makePost({}, { contentMarkdown: "Rotate the tokens before Friday." })])
    await screen.findByText("Rotate the tokens before Friday.")
    // Collapsed to a single resting line until activated — the heavy composer
    // mounts only on click. Mirrors the composer's own placeholder copy.
    expect(screen.getByRole("button", { name: "Write a reply…" })).toBeTruthy()
  })

  it("renders the older replies as ledger lead rows, the newest one full", async () => {
    // 5 messages: opening + 3 shown replies; the ledger keeps the newest full and
    // leads the two before it. The one member nothing local can render is earlier
    // mass, so it rides the head row rather than a lead of its own.
    const recent = [
      makeOpeningMessage({ id: "m3" }),
      makeOpeningMessage({ id: "m4" }),
      makeOpeningMessage({ id: "m5" }),
    ]
    mountBoard([makePost({ messageIds: ["m1", "m2", "m3", "m4", "m5"] }, { id: "m1" }, recent)])
    await screen.findAllByText("Opening message body.")
    await vi.waitFor(() => expect(document.querySelectorAll("[data-ledger-row]").length).toBe(2))
    expect(await screen.findByText(/^1 earlier/)).toBeTruthy()
  })

  it("has the backfilled older leads in the card's FIRST revealed frame", async () => {
    // The warm-reload shape from the pop-in report: the projection window carries
    // only the newest reply, the rail has read but doesn't cover membership, and
    // the older leads live in the backfill store. Their per-card liveQuery can't
    // emit until a tick after the rail resolves, so without the primed snapshot
    // the card paints its projection window first and the leads pop in after.
    const older = [
      makeOpeningMessage({ id: "m3", contentMarkdown: "Older lead three." }),
      makeOpeningMessage({ id: "m4", contentMarkdown: "Older lead four." }),
    ]
    const newest = makeOpeningMessage({ id: "m5", contentMarkdown: "Newest reply body." })
    await seedConversationMessages(WORKSPACE_ID, "conv_1", [...older, newest])
    await db.events.put({
      id: "evt_m5",
      workspaceId: WORKSPACE_ID,
      streamId: "stream_1",
      sequence: "50",
      _sequenceNum: 50,
      eventType: "message_created",
      payload: { messageId: "m5", contentMarkdown: "Newest reply body.", reactions: {} },
      actorId: "usr_me",
      actorType: "user",
      createdAt: "2026-06-22T12:00:00.000Z",
      _cachedAt: 50,
    })

    mountBoard([makePost({ messageIds: ["m1", "m3", "m4", "m5"] }, { id: "m1" }, [newest])], {
      boardMessages: [...older, newest],
    })

    // The reveal is all-or-nothing: the frame that first shows the card must
    // already carry the leads. No second wait — that's the whole assertion.
    await screen.findByText("Newest reply body.")
    expect(screen.getByText("Older lead three.")).toBeTruthy()
    expect(screen.getByText("Older lead four.")).toBeTruthy()
  })

  it("offers a retry when the earlier mass can't be fetched", async () => {
    const recent = [
      makeOpeningMessage({ id: "m3" }),
      makeOpeningMessage({ id: "m4" }),
      makeOpeningMessage({ id: "m5" }),
    ]
    // The backfill only arms on a card whose rail has READ (a projection-sourced
    // card is still resolving), so seed the opening onto the rail — the older
    // members stay server-only, which is what the failing fetch is for.
    await db.events.put({
      id: "evt_m1",
      workspaceId: WORKSPACE_ID,
      streamId: "stream_1",
      sequence: "10",
      _sequenceNum: 10,
      eventType: "message_created",
      payload: { messageId: "m1", contentMarkdown: "Opening message body.", reactions: {} },
      actorId: "usr_me",
      actorType: "user",
      createdAt: "2026-06-22T12:00:00.000Z",
      _cachedAt: 10,
    })
    mountBoard([makePost({ messageIds: ["m1", "m2", "m3", "m4", "m5"] }, { id: "m1" }, recent)], { failMessages: true })
    // The ledger wants the whole window, so the backfill arms without a gesture.
    // It retries once (retry: 1, ~1s backoff) before surfacing the error label, so
    // the wait must span the retry cycle.
    expect(await screen.findByText("Couldn't load older messages. Retry.", undefined, { timeout: 4000 })).toBeTruthy()
  })

  it("shows no head row when the whole conversation already fits the ledger", async () => {
    const recent = [makeOpeningMessage({ id: "m2" }), makeOpeningMessage({ id: "m3" })]
    mountBoard([makePost({ messageIds: ["m1", "m2", "m3"] }, { id: "m1" }, recent)])
    await screen.findAllByText("Opening message body.")
    expect(screen.queryByText(/earlier/)).toBeNull()
  })

  it("renders reactions on the opening message", async () => {
    mountBoard([makePost({ messageIds: ["m1"] }, { id: "m1", reactions: { ":tada:": ["usr_a", "usr_b"] } })])
    await screen.findByText("Opening message body.")
    // No emoji map in the test cache, so the shortcode renders as-is with its count.
    expect(screen.getByText(":tada:")).toBeTruthy()
    expect(screen.getByText("2")).toBeTruthy()
  })

  it("groups posts into recency sections under the right headers", async () => {
    // Timestamps relative to now so the buckets are deterministic regardless of
    // when the suite runs (recencyBucket compares against the current day).
    const today = new Date().toISOString()
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString()
    mountBoard([
      makePost(
        { id: "conv_today", messageIds: ["a1"], lastActivityAt: today },
        { id: "a1", contentMarkdown: "Fresh body" }
      ),
      makePost(
        { id: "conv_old", streamId: "stream_2", messageIds: ["b1"], lastActivityAt: fiveDaysAgo },
        { id: "b1", contentMarkdown: "Older body" }
      ),
    ])

    // The feed is one flat virtualized row list, so recency headers and cards are
    // siblings ordered by document position rather than nested in <section>s. Each
    // card sits directly under its own header: Today → Fresh body → Earlier this
    // week → Older body, in that order.
    const todayHeader = await screen.findByText("Today")
    const freshBody = screen.getByText("Fresh body")
    const weekHeader = screen.getByText("Earlier this week")
    const olderBody = screen.getByText("Older body")
    const precedes = (a: HTMLElement, b: HTMLElement) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(precedes(todayHeader, freshBody)).toBe(true)
    expect(precedes(freshBody, weekHeader)).toBe(true)
    expect(precedes(weekHeader, olderBody)).toBe(true)
  })

  it("shows an error state with a retry, not the empty state, when the fetch fails", async () => {
    mountBoard([], { fail: true })
    expect(await screen.findByText("Couldn't load the board")).toBeTruthy()
    expect(screen.getByText("Try again")).toBeTruthy()
    expect(screen.queryByText("Nothing on the board yet")).toBeNull()
  })

  it("offers Load more when there is another page", async () => {
    mountBoard([makePost()], { nextCursor: "2026-06-22T12:00:00.000Z|conv_1" })
    expect(await screen.findByText("Opening message body.")).toBeTruthy()
    // Load more is driven by the query's async `hasNextPage` (the feed itself
    // renders synchronously from the store), so wait for it to resolve.
    expect(await screen.findByRole("button", { name: "Load more" })).toBeTruthy()
  })

  it("permalinks each message to itself in its stream timeline (no conversations pane)", async () => {
    mountBoard([makePost()])
    await screen.findByText("Opening message body.")
    // The body renders as a real message (not wrapped in a link); the timestamp
    // is the permalink into the stream.
    const permalink = screen
      .getAllByRole("link")
      .find((a) => a.getAttribute("href") === `/w/${WORKSPACE_ID}/s/stream_1?m=msg_1`)
    expect(permalink).toBeTruthy()
  })

  it("uses the scratchpad's name as the card's stream locator", async () => {
    vi.mocked(workspaceStoreModule.useWorkspaceStreams).mockReturnValue([
      { id: "stream_sp", type: "scratchpad", displayName: "My Notes" },
    ] as never)
    mountBoard([makePost({ id: "conv_sp", streamId: "stream_sp" })])

    expect(await screen.findByRole("link", { name: "My Notes" })).toBeTruthy()
  })

  it("resolves a DM peer as the card's stream locator", async () => {
    vi.mocked(workspaceStoreModule.useWorkspaceStreams).mockReturnValue([
      { id: "stream_dm", type: "dm", displayName: null },
    ] as never)
    vi.mocked(workspaceStoreModule.useWorkspaceDmPeers).mockReturnValue([
      { streamId: "stream_dm", userId: "usr_pierre" },
    ] as never)
    vi.mocked(workspaceStoreModule.useWorkspaceUsers).mockReturnValue([{ id: "usr_pierre", name: "Pierre" }] as never)
    mountBoard([makePost({ id: "conv_dm", streamId: "stream_dm", messageIds: ["d1"] }, { id: "d1" })])

    expect(await screen.findByRole("link", { name: "Pierre" })).toBeTruthy()
  })

  it("keeps the board column mounted, hidden and inert behind a fullscreen mobile panel", async () => {
    vi.spyOn(pointerModule, "useIsMobileOrCoarse").mockReturnValue(true)
    // The panel's own content is covered by its own suites and needs providers
    // this harness doesn't mount; what's under test here is what happens to the
    // board column beside it.
    vi.spyOn(panelHostModule, "PanelHost").mockImplementation(() => createElement("div", null, "panel content"))
    mountBoard([makePost({}, { contentMarkdown: "Rotate the tokens before Friday." })], {
      entry: `/w/${WORKSPACE_ID}/board?lens=all&panel=stream_panel`,
    })

    expect(await screen.findByText("panel content")).toBeTruthy()
    // Unmounting the column destroys the scroller's box along with its offset, so
    // closing the panel would re-enter the virtualized feed at the top.
    const body = await screen.findByText("Rotate the tokens before Friday.")
    const hidden = body.closest("[inert]")
    expect(hidden).not.toBeNull()
    expect(hidden?.className).toContain("invisible")
  })

  it("does not show the new pill for activity on cards already in the view", async () => {
    const first = makePost(
      { id: "conv_first", messageIds: ["m_first"], lastActivityAt: "2026-06-22T12:00:00.000Z" },
      { id: "m_first", contentMarkdown: "First card body." }
    )
    const second = makePost(
      { id: "conv_second", messageIds: ["m_second"], lastActivityAt: "2026-06-22T11:00:00.000Z" },
      { id: "m_second", contentMarkdown: "Second card body." }
    )
    const { rerenderWith } = mountBoard([first, second])
    await screen.findByText("First card body.")
    await screen.findByText("Second card body.")

    await act(async () => {
      rerenderWith([
        makePost(
          { id: "conv_second", messageIds: ["m_second"], lastActivityAt: "2026-06-22T14:00:00.000Z" },
          { id: "m_second", contentMarkdown: "Second card body." }
        ),
        first,
      ])
    })

    expect(screen.queryByText(/update available/)).toBeNull()
    expect(screen.getByText("First card body.")).toBeTruthy()
    expect(screen.getByText("Second card body.")).toBeTruthy()
  })
})

describe("BoardPage unread view", () => {
  const UNREAD_ENTRY = `/w/${WORKSPACE_ID}/board?unread=true`
  let unreadCounts: Record<string, number> = {}

  beforeEach(() => {
    unreadCounts = { stream_1: 2 }
    vi.spyOn(workspaceStoreModule, "useWorkspaceUnreadState").mockImplementation(
      () =>
        ({
          workspaceId: WORKSPACE_ID,
          unreadCounts,
          mentionCounts: {},
          messageCounts: {},
          readMessageIds: {},
        }) as never
    )
  })

  it("keeps a card in the view after it is read — the session floor never drops it", async () => {
    const { rerenderWith } = mountBoard([makePost()], { entry: UNREAD_ENTRY })
    expect(await screen.findByText("CC Teams tokens")).toBeTruthy()

    // Reading the card clears its stream's unread…
    unreadCounts = {}
    rerenderWith([makePost()])

    // …and the card stays, because reading it is why the viewer is here.
    expect(screen.getByText("CC Teams tokens")).toBeTruthy()
  })

  it("drops a card only when the viewer clears it, and writes no read state doing so", async () => {
    const { rerenderWith } = mountBoard([makePost()], { entry: UNREAD_ENTRY })
    await screen.findByText("CC Teams tokens")

    act(() => {
      screen.getByRole("button", { name: "Clear from unread" }).click()
    })
    expect(screen.queryByText("CC Teams tokens")).toBeNull()

    // Still unread — clearing is view membership only.
    expect(unreadCounts).toEqual({ stream_1: 2 })
    rerenderWith([makePost()])
    expect(screen.queryByText("CC Teams tokens")).toBeNull()
  })

  it("starts a fresh floor on each visit to the unread view", async () => {
    const first = mountBoard([makePost()], { entry: UNREAD_ENTRY })
    await screen.findByText("CC Teams tokens")
    first.rerender(<Fragment />)

    // A new visit with nothing unread shows nothing — the floor is per-visit,
    // never a module-level latch that outlives the page.
    unreadCounts = {}
    mountBoard([makePost()], { entry: UNREAD_ENTRY })
    expect(screen.queryByText("CC Teams tokens")).toBeNull()
  })

  it("lets a newly-unread conversation join the view behind the pill", async () => {
    const { rerenderWith } = mountBoard([makePost()], { entry: UNREAD_ENTRY })
    await screen.findByText("CC Teams tokens")

    unreadCounts = { stream_1: 2, stream_2: 1 }
    rerenderWith([
      makePost(),
      makePost({ id: "conv_2", streamId: "stream_2", topicSummary: "Index migration" }, { id: "msg_9" }),
    ])

    expect(await screen.findByRole("button", { name: "Show 1 update" })).toBeTruthy()
  })

  it("offers no clear control outside the unread view", async () => {
    mountBoard([makePost()])
    await screen.findByText("CC Teams tokens")
    expect(screen.queryByRole("button", { name: "Clear from unread" })).toBeNull()
  })
})

describe("BoardPage drafts view", () => {
  const DRAFTS_ENTRY = `/w/${WORKSPACE_ID}/board?drafts=true`

  async function seedDraft(id: string, scope: string, text: string) {
    await db.drafts.add({
      id,
      workspaceId: WORKSPACE_ID,
      scope,
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
      attachments: [],
      clientUpdatedAt: 1000,
    } as never)
  }

  beforeEach(async () => {
    __clearBoardDraftsRegistry()
    await db.drafts.clear()
    await db.composerLoaded.clear()
  })

  afterEach(async () => {
    __clearBoardDraftsRegistry()
    await db.drafts.clear()
  })

  function draftPosts(): BoardPost[] {
    return [
      makePost({ id: "conv_reply", topicSummary: "Reply draft card", messageIds: ["m_r"] }, { id: "m_r" }),
      makePost({ id: "conv_branch", topicSummary: "Branch draft card", messageIds: ["m_b"] }, { id: "m_b" }),
      makePost({ id: "conv_sub", topicSummary: "Subtopic draft card", messageIds: ["msg_fork"] }, { id: "msg_fork" }),
      makePost({ id: "conv_none", topicSummary: "No draft card", messageIds: ["m_n"] }, { id: "m_n" }),
    ]
  }

  it("keeps only the cards a board draft key resolves to", async () => {
    await seedDraft("draft_reply", boardReplyDraftKey("conv_reply"), "reply body")
    await seedDraft("draft_branch", boardBranchReplyDraftKey("conv_branch"), "branch body")
    await seedDraft("draft_sub", boardSubtopicDraftKey("stream_1", "msg_fork"), "subtopic body")

    mountBoard(draftPosts(), { entry: DRAFTS_ENTRY })

    expect(await screen.findByText("Reply draft card")).toBeTruthy()
    await waitFor(() => expect(screen.getByText("Branch draft card")).toBeTruthy())
    expect(screen.getByText("Subtopic draft card")).toBeTruthy()
    expect(screen.queryByText("No draft card")).toBeNull()
  })

  it("keeps a card whose checked-out draft is emptied mid-rewrite, marks it removed in place when the row goes", async () => {
    const scope = boardReplyDraftKey("conv_reply")
    await seedDraft("draft_reply", scope, "reply body")
    await db.composerLoaded.put({ workspaceId: WORKSPACE_ID, scope, draftId: "draft_reply" } as never)

    mountBoard(draftPosts(), { entry: DRAFTS_ENTRY })

    expect(await screen.findByText("Reply draft card")).toBeTruthy()

    const emptied = await db.drafts.get("draft_reply")
    await db.drafts.put({
      ...emptied!,
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      clientUpdatedAt: 2000,
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.getByText("Reply draft card")).toBeTruthy()

    await db.drafts.delete("draft_reply")

    // Shed through the removal path: the card keeps its slot (and its mounted
    // composer subtree) under the removed overlay, which names the reason.
    await waitFor(() => expect(screen.getByText("No longer a draft.")).toBeTruthy())
    expect(screen.getByText("Reply draft card")).toBeTruthy()
  })

  it("shows nothing when no board draft matches a card", async () => {
    await seedDraft("draft_other", boardReplyDraftKey("conv_elsewhere"), "unrelated body")

    mountBoard(draftPosts(), { entry: DRAFTS_ENTRY })

    await waitFor(() => expect(screen.queryByText("Reply draft card")).toBeNull())
    expect(screen.queryByText("Branch draft card")).toBeNull()
    expect(screen.queryByText("Subtopic draft card")).toBeNull()
    expect(screen.queryByText("No draft card")).toBeNull()
  })
})
