import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ConversationWithStaleness } from "@threa/types"
import { BoardPage } from "./board"
import { ServicesProvider, SidebarProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
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

function mountBoard(conversations: ConversationWithStaleness[]) {
  const listByWorkspace = vi.fn(async () => conversations)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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

  it("links each card to its conversation opened in its stream", async () => {
    mountBoard([makeConversation()])
    const card = (await screen.findByText("CC Teams tokens")).closest("a")
    expect(card?.getAttribute("href")).toBe(`/w/${WORKSPACE_ID}/s/stream_1?convView=open&conv=conv_1`)
  })
})
