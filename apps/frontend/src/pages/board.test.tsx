import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardPost, BoardPostMessage, ConversationWithStaleness } from "@threa/types"
import { BoardPage } from "./board"
import * as boardStoreModule from "@/stores/board-store"
import { ServicesProvider, SidebarProvider, PanelProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import { workspaceKeys } from "@/hooks/use-workspaces"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as messageReactionsModule from "@/hooks/use-message-reactions"
import * as syncEngineModule from "@/sync/sync-engine"
import * as userProfileModule from "@/components/user-profile"
import * as contextsModule from "@/contexts"

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
  }
}

function mountBoard(
  posts: BoardPost[],
  opts: { nextCursor?: string | null; fail?: boolean; boardFlag?: "on" | "off"; failMessages?: boolean } = {}
) {
  const { nextCursor = null, fail = false, boardFlag = "on", failMessages = false } = opts
  const listByWorkspace = vi.fn(async () => {
    if (fail) throw new Error("boom")
    return { posts, nextCursor }
  })
  const getBoardMessages = vi.fn(async () => {
    if (failMessages) throw new Error("boom")
    return []
  })
  // The board reads its feed reactively from the conversations IDB store; mock
  // that store hook to return the test's posts (the IDB read/sort/merge path is
  // covered directly in board-store.test). The query still seeds IDB and drives
  // pagination/loading/error, so `listByWorkspace` is exercised as before.
  vi.spyOn(boardStoreModule, "useBoardPosts").mockReturnValue(posts as never)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // The board is gated behind the board-view flag, read from the bootstrap cache.
  queryClient.setQueryData(workspaceKeys.bootstrap(WORKSPACE_ID), { featureFlags: { "board-view": boardFlag } })
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ServicesProvider services={{ conversations: { listByWorkspace, getBoardMessages } as never }}>
          <SidebarProvider>
            <MemoryRouter initialEntries={[`/w/${WORKSPACE_ID}/board`]}>
              <PanelProvider>
                <Routes>
                  <Route path="/w/:workspaceId/board" element={<BoardPage />} />
                </Routes>
              </PanelProvider>
            </MemoryRouter>
          </SidebarProvider>
        </ServicesProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
  return { listByWorkspace }
}

beforeEach(() => {
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
  } as unknown as ReturnType<typeof syncEngineModule.useSyncEngine>)
  // Author names open the profile via UserProfileProvider, not mounted here.
  vi.spyOn(userProfileModule, "useUserProfile").mockReturnValue({ openUserProfile: vi.fn() })
  // RelativeTime reads timezone/locale from the preferences context.
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { timezone: "UTC", locale: "en-US" },
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
})

afterEach(() => vi.restoreAllMocks())

describe("BoardPage", () => {
  it("renders the empty state when there are no conversations", async () => {
    mountBoard([])
    expect(await screen.findByText("Nothing on the board yet")).toBeTruthy()
  })

  it("renders the opening-message body", async () => {
    mountBoard([makePost({}, { contentMarkdown: "Rotate the tokens before Friday." })])
    expect(await screen.findByText("Rotate the tokens before Friday.")).toBeTruthy()
  })

  it("offers an inline reply affordance on each post", async () => {
    mountBoard([makePost({}, { contentMarkdown: "Rotate the tokens before Friday." })])
    await screen.findByText("Rotate the tokens before Friday.")
    // Collapsed to a single resting line until activated — the heavy composer
    // mounts only on click. Mirrors the composer's own placeholder copy.
    expect(screen.getByRole("button", { name: "Write a reply…" })).toBeTruthy()
  })

  it("collapses the middle as an 'N more messages' expander, pluralizing the count", async () => {
    // 5 messages: opening + 3 recent shown + 1 hidden in the middle.
    const recent = [
      makeOpeningMessage({ id: "m3" }),
      makeOpeningMessage({ id: "m4" }),
      makeOpeningMessage({ id: "m5" }),
    ]
    mountBoard([makePost({ messageIds: ["m1", "m2", "m3", "m4", "m5"] }, { id: "m1" }, recent)])
    expect(await screen.findByText("1 more message")).toBeTruthy()
    expect(screen.queryByText("1 more messages")).toBeNull()
  })

  it("offers a retry when expanding the middle fails", async () => {
    const recent = [
      makeOpeningMessage({ id: "m3" }),
      makeOpeningMessage({ id: "m4" }),
      makeOpeningMessage({ id: "m5" }),
    ]
    mountBoard([makePost({ messageIds: ["m1", "m2", "m3", "m4", "m5"] }, { id: "m1" }, recent)], { failMessages: true })
    fireEvent.click(await screen.findByText("1 more message"))
    expect(await screen.findByText("Couldn't load older messages. Retry.")).toBeTruthy()
  })

  it("shows no expander when the whole conversation already fits", async () => {
    const recent = [makeOpeningMessage({ id: "m2" }), makeOpeningMessage({ id: "m3" })]
    mountBoard([makePost({ messageIds: ["m1", "m2", "m3"] }, { id: "m1" }, recent)])
    await screen.findAllByText("Opening message body.")
    expect(screen.queryByText(/more messages?$/)).toBeNull()
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

    const todaySection = (await screen.findByText("Today")).closest("section")
    const weekSection = screen.getByText("Earlier this week").closest("section")
    expect(todaySection).not.toBeNull()
    expect(weekSection).not.toBeNull()
    // Each post sits under its own recency header.
    expect(within(todaySection as HTMLElement).getByText("Fresh body")).toBeTruthy()
    expect(within(weekSection as HTMLElement).getByText("Older body")).toBeTruthy()
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

  it("does not render the board when the board-view flag is off", async () => {
    const { listByWorkspace } = mountBoard([makePost()], { boardFlag: "off" })
    // Gate redirects away — board content never appears and the feed isn't fetched.
    // Flush effects so a (hypothetical) deferred mount would have its chance to fire.
    await act(async () => {})
    expect(screen.queryByText("Opening message body.")).toBeNull()
    expect(screen.queryByText("Board")).toBeNull()
    expect(listByWorkspace).not.toHaveBeenCalled()
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

    expect(await screen.findByText("My Notes")).toBeTruthy() // header locator = scratchpad name
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

    // The DM peer's name is the header locator (where the post lives).
    expect(await screen.findByText("Pierre")).toBeTruthy()
  })
})
