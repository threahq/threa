import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardPost, BoardPostMessage, ConversationWithStaleness } from "@threa/types"
import { BoardPage } from "./board"
import { ServicesProvider, SidebarProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import { workspaceKeys } from "@/hooks/use-workspaces"
import * as workspaceStoreModule from "@/stores/workspace-store"
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
  msgOverrides: Partial<BoardPostMessage> | null = {}
): BoardPost {
  return {
    conversation: makeConversation(convOverrides),
    openingMessage: msgOverrides === null ? null : makeOpeningMessage(msgOverrides),
  }
}

function mountBoard(
  posts: BoardPost[],
  opts: { nextCursor?: string | null; fail?: boolean; boardFlag?: "on" | "off" } = {}
) {
  const { nextCursor = null, fail = false, boardFlag = "on" } = opts
  const listByWorkspace = vi.fn(async () => {
    if (fail) throw new Error("boom")
    return { posts, nextCursor }
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // The board is gated behind the board-view flag, read from the bootstrap cache.
  queryClient.setQueryData(workspaceKeys.bootstrap(WORKSPACE_ID), { featureFlags: { "board-view": boardFlag } })
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ServicesProvider services={{ conversations: { listByWorkspace } as never }}>
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

  it("renders a post with its topic, body, and message count", async () => {
    mountBoard([makePost({}, { contentMarkdown: "Rotate the tokens before Friday." })])
    expect(await screen.findByText("CC Teams tokens")).toBeTruthy()
    expect(screen.getByText("Rotate the tokens before Friday.")).toBeTruthy()
    expect(screen.getByText("3 messages")).toBeTruthy()
  })

  it("pluralizes a single message as '1 message'", async () => {
    mountBoard([makePost({ messageIds: ["msg_only"] })])
    expect(await screen.findByText("1 message")).toBeTruthy()
    expect(screen.queryByText("1 messages")).toBeNull()
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

  it("links each post to its conversation opened in its stream", async () => {
    mountBoard([makePost()])
    const card = (await screen.findByText("CC Teams tokens")).closest("a")
    expect(card?.getAttribute("href")).toBe(`/w/${WORKSPACE_ID}/s/stream_1?convView=open&conv=conv_1`)
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
