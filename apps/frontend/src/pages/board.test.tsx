import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardPost, BoardPostMessage, ConversationWithStaleness } from "@threa/types"
import { BoardPage } from "./board"
import { ServicesProvider, SidebarProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import { workspaceKeys } from "@/hooks/use-workspaces"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as messageReactionsModule from "@/hooks/use-message-reactions"
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
    // usr_me isn't in the mocked user cache, so the author renders as a short id
    // — distinct from any DM-peer name asserted on elsewhere.
    authorId: "usr_me",
    authorType: "user",
    contentMarkdown: "Opening message body.",
    reactions: {},
    createdAt: "2026-06-22T12:00:00.000Z",
    ...overrides,
  }
}

function makePost(
  convOverrides: Partial<ConversationWithStaleness> = {},
  msgOverrides: Partial<BoardPostMessage> | null = {},
  recentMessages: BoardPostMessage[] = []
): BoardPost {
  return {
    conversation: makeConversation(convOverrides),
    openingMessage: msgOverrides === null ? null : makeOpeningMessage(msgOverrides),
    recentMessages,
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
  const getMessages = vi.fn(async () => {
    if (failMessages) throw new Error("boom")
    return []
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // The board is gated behind the board-view flag, read from the bootstrap cache.
  queryClient.setQueryData(workspaceKeys.bootstrap(WORKSPACE_ID), { featureFlags: { "board-view": boardFlag } })
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ServicesProvider services={{ conversations: { listByWorkspace, getMessages } as never }}>
          <SidebarProvider>
            <MemoryRouter initialEntries={[`/w/${WORKSPACE_ID}/board`]}>
              <Routes>
                <Route path="/w/:workspaceId/board" element={<BoardPage />} />
              </Routes>
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

  it("renders a post with its topic and opening-message body", async () => {
    mountBoard([makePost({}, { contentMarkdown: "Rotate the tokens before Friday." })])
    expect(await screen.findByText("CC Teams tokens")).toBeTruthy()
    expect(screen.getByText("Rotate the tokens before Friday.")).toBeTruthy()
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
    expect(await screen.findByText("Couldn't load messages. Retry.")).toBeTruthy()
  })

  it("shows no expander when the whole conversation already fits", async () => {
    const recent = [makeOpeningMessage({ id: "m2" }), makeOpeningMessage({ id: "m3" })]
    mountBoard([makePost({ messageIds: ["m1", "m2", "m3"] }, { id: "m1" }, recent)])
    await screen.findByText("CC Teams tokens")
    expect(screen.queryByText(/more messages?$/)).toBeNull()
  })

  it("renders reactions on the opening message", async () => {
    mountBoard([makePost({}, { reactions: { ":tada:": ["usr_a", "usr_b"] } })])
    await screen.findByText("CC Teams tokens")
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
      makePost({ id: "conv_today", topicSummary: "Fresh topic", lastActivityAt: today }),
      makePost({ id: "conv_old", streamId: "stream_2", topicSummary: "Older topic", lastActivityAt: fiveDaysAgo }),
    ])

    const todaySection = (await screen.findByText("Today")).closest("section")
    const weekSection = screen.getByText("Earlier this week").closest("section")
    expect(todaySection).not.toBeNull()
    expect(weekSection).not.toBeNull()
    // Each post sits under its own recency header.
    expect(within(todaySection as HTMLElement).getByText("Fresh topic")).toBeTruthy()
    expect(within(weekSection as HTMLElement).getByText("Older topic")).toBeTruthy()
  })

  it("shows an error state with a retry, not the empty state, when the fetch fails", async () => {
    mountBoard([], { fail: true })
    expect(await screen.findByText("Couldn't load the board")).toBeTruthy()
    expect(screen.getByText("Try again")).toBeTruthy()
    expect(screen.queryByText("Nothing on the board yet")).toBeNull()
  })

  it("offers Load more when there is another page", async () => {
    mountBoard([makePost()], { nextCursor: "2026-06-22T12:00:00.000Z|conv_1" })
    expect(await screen.findByText("CC Teams tokens")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy()
  })

  it("does not render the board when the board-view flag is off", async () => {
    const { listByWorkspace } = mountBoard([makePost()], { boardFlag: "off" })
    // Gate redirects away — board content never appears and the feed isn't fetched.
    // Flush effects so a (hypothetical) deferred mount would have its chance to fire.
    await act(async () => {})
    expect(screen.queryByText("CC Teams tokens")).toBeNull()
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

  it("uses the scratchpad's name as the topic, not the generic summary", async () => {
    vi.mocked(workspaceStoreModule.useWorkspaceStreams).mockReturnValue([
      { id: "stream_sp", type: "scratchpad", displayName: "My Notes" },
    ] as never)
    mountBoard([makePost({ id: "conv_sp", streamId: "stream_sp", topicSummary: "Scratchpad" })])

    expect(await screen.findByText("My Notes")).toBeTruthy() // topic = scratchpad name
    expect(screen.getByText("Scratchpad")).toBeTruthy() // context line = the type
  })

  it("keeps a DM peer (a person) as context, never as the post topic", async () => {
    vi.mocked(workspaceStoreModule.useWorkspaceStreams).mockReturnValue([
      { id: "stream_dm", type: "dm", displayName: null },
    ] as never)
    vi.mocked(workspaceStoreModule.useWorkspaceDmPeers).mockReturnValue([
      { streamId: "stream_dm", userId: "usr_pierre" },
    ] as never)
    vi.mocked(workspaceStoreModule.useWorkspaceUsers).mockReturnValue([{ id: "usr_pierre", name: "Pierre" }] as never)
    mountBoard([makePost({ id: "conv_dm", streamId: "stream_dm", topicSummary: "Lunch plans" })])

    const topic = await screen.findByText("Lunch plans")
    expect(topic).toBeTruthy() // topic = topicSummary
    // "Pierre" renders as the context line, and is not the topic element.
    expect(screen.getByText("Pierre")).toBeTruthy()
    expect(topic.textContent).not.toContain("Pierre")
  })
})
