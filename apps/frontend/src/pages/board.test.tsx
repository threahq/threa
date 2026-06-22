import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ConversationWithStaleness } from "@threa/types"
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

function mountBoard(
  conversations: ConversationWithStaleness[],
  opts: { nextCursor?: string | null; fail?: boolean; boardFlag?: "on" | "off" } = {}
) {
  const { nextCursor = null, fail = false, boardFlag = "on" } = opts
  const listByWorkspace = vi.fn(async () => {
    if (fail) throw new Error("boom")
    return { conversations, nextCursor }
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
  // BoardCard resolves the stream label via the workspace caches.
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([] as never)
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

  it("renders a conversation as a card with its title and message count", async () => {
    mountBoard([makeConversation()])
    expect(await screen.findByText("CC Teams tokens")).toBeTruthy()
    expect(screen.getByText("3 messages")).toBeTruthy()
  })

  it("pluralizes a single message as '1 message'", async () => {
    mountBoard([makeConversation({ messageIds: ["msg_only"] })])
    expect(await screen.findByText("1 message")).toBeTruthy()
    expect(screen.queryByText("1 messages")).toBeNull()
  })

  it("shows an error state with a retry, not the empty state, when the fetch fails", async () => {
    mountBoard([], { fail: true })
    expect(await screen.findByText("Couldn't load the board")).toBeTruthy()
    expect(screen.getByText("Try again")).toBeTruthy()
    expect(screen.queryByText("Nothing on the board yet")).toBeNull()
  })

  it("offers Load more when there is another page", async () => {
    mountBoard([makeConversation()], { nextCursor: "2026-06-22T12:00:00.000Z|conv_1" })
    expect(await screen.findByText("CC Teams tokens")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy()
  })

  it("does not render the board when the board-view flag is off", async () => {
    const { listByWorkspace } = mountBoard([makeConversation()], { boardFlag: "off" })
    // Gate redirects away — board content never appears and the feed isn't fetched.
    await Promise.resolve()
    expect(screen.queryByText("CC Teams tokens")).toBeNull()
    expect(screen.queryByText("Board")).toBeNull()
    expect(listByWorkspace).not.toHaveBeenCalled()
  })

  it("links each card to its conversation opened in its stream", async () => {
    mountBoard([makeConversation()])
    const card = (await screen.findByText("CC Teams tokens")).closest("a")
    expect(card?.getAttribute("href")).toBe(`/w/${WORKSPACE_ID}/s/stream_1?convView=open&conv=conv_1`)
  })

  it("titles a scratchpad card with the scratchpad's name, not the generic topic", async () => {
    vi.mocked(workspaceStoreModule.useWorkspaceStreams).mockReturnValue([
      { id: "stream_sp", type: "scratchpad", displayName: "My Notes" },
    ] as never)
    mountBoard([makeConversation({ id: "conv_sp", streamId: "stream_sp", topicSummary: "Scratchpad" })])

    expect(await screen.findByText("My Notes")).toBeTruthy() // title = scratchpad name
    expect(screen.getByText("Scratchpad")).toBeTruthy() // context line = the type
  })

  it("keeps a DM peer (a person) as context, never as the card title", async () => {
    vi.mocked(workspaceStoreModule.useWorkspaceStreams).mockReturnValue([
      { id: "stream_dm", type: "dm", displayName: null },
    ] as never)
    vi.mocked(workspaceStoreModule.useWorkspaceDmPeers).mockReturnValue([
      { streamId: "stream_dm", userId: "usr_pierre" },
    ] as never)
    vi.mocked(workspaceStoreModule.useWorkspaceUsers).mockReturnValue([{ id: "usr_pierre", name: "Pierre" }] as never)
    mountBoard([makeConversation({ id: "conv_dm", streamId: "stream_dm", topicSummary: "Lunch plans" })])

    const title = await screen.findByText("Lunch plans")
    expect(title).toBeTruthy() // title = topic
    // "Pierre" renders as the context line, and is not the title element.
    expect(screen.getByText("Pierre")).toBeTruthy()
    expect(title.textContent).not.toContain("Pierre")
  })
})
