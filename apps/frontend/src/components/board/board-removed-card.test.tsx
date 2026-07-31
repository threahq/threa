import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardPostMessage } from "@threa/types"
import { BoardRemovedCard } from "./board-removed-card"
import type { BoardViewPost, RemovedSuccessor } from "@/hooks/use-stable-board-view"
import { ServicesProvider, PanelProvider, TraceProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import { __clearBoardRailRegistry } from "@/hooks/use-board-card-messages"
import { __clearConversationGraphRegistry } from "@/hooks/use-conversation-graph"
import { __resetCollapseCacheForTests } from "@/lib/markdown/collapse-cache"
// eslint-disable-next-line no-restricted-imports -- test clears IDB directly; the card reads the real rail path
import { db } from "@/db"
import * as conversationReadModule from "@/components/message/conversation-read-context"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as messageReactionsModule from "@/hooks/use-message-reactions"
import * as userProfileModule from "@/components/user-profile"
import * as syncEngineModule from "@/sync/sync-engine"
import * as contextsModule from "@/contexts"
import * as queueDraftModule from "@/hooks/use-queue-draft-message"

const WS = "ws_1"
const STREAM = "stream_1"

function opening(): BoardPostMessage {
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
  }
}

function ghostPost(): BoardViewPost {
  return {
    id: "conv_ghost",
    workspaceId: WS,
    _lastActivityMs: 0,
    _cachedAt: 0,
    streamIds: [STREAM],
    conversation: {
      id: "conv_ghost",
      streamId: STREAM,
      messageIds: ["m_open"],
      lastActivityAt: "2026-06-22T12:00:00.000Z",
    },
    openingMessage: opening(),
    recentMessages: [],
    totalReplies: 0,
  } as unknown as BoardViewPost
}

function renderCard(successor: RemovedSuccessor | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ServicesProvider services={{ conversations: {} as never }}>
          <MemoryRouter initialEntries={[`/w/${WS}/board`]}>
            <TraceProvider>
              <PanelProvider>
                <BoardRemovedCard
                  workspaceId={WS}
                  post={ghostPost()}
                  contextLabel="#general"
                  streamType="channel"
                  successor={successor}
                />
              </PanelProvider>
            </TraceProvider>
          </MemoryRouter>
        </ServicesProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

beforeEach(async () => {
  __clearBoardRailRegistry()
  __clearConversationGraphRegistry()
  __resetCollapseCacheForTests()
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
  vi.spyOn(queueDraftModule, "useQueueDraftMessage").mockReturnValue({
    queueDraftMessage: vi.fn(),
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
    value: { state: () => "ungated" as const, markReadUpToHere: vi.fn(), markUnread: vi.fn() },
    hasUnread: () => false,
    markReadSilently: () => Promise.resolve(),
    setExplicitUnreadListener: () => {},
    getReadTruth: () => ({ lastReadSequence: null, readMessageIds: [] }),
  })
})

afterEach(() => vi.restoreAllMocks())

describe("BoardRemovedCard", () => {
  it("keeps the retained card's content and links into the successor", () => {
    renderCard({ conversationId: "conv_successor", topicSummary: "Deploy plan" })

    // The retained body still renders — the row holds its footprint.
    expect(screen.getByText("Opening body.")).toBeTruthy()
    expect(screen.getByText(/Merged into/)).toBeTruthy()
    expect(screen.getByRole("link", { name: "Deploy plan" }).getAttribute("href")).toContain("panel=")
  })

  it("offers no interactive affordance but the successor link", () => {
    renderCard({ conversationId: "conv_successor", topicSummary: "Deploy plan" })

    // The card underneath is aria-hidden + pointer-events-none, so the overlay's
    // link is the ONLY reachable control: no card actions, no reply composer.
    expect(screen.getAllByRole("link")).toHaveLength(1)
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("says the card is gone when nothing holds the opening message", () => {
    renderCard(null)

    expect(screen.getByText("No longer on your board.")).toBeTruthy()
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.queryByRole("textbox")).toBeNull()
  })
})
