import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardPost, BoardPostMessage, ConversationWithStaleness } from "@threa/types"
import { ConversationPanel } from "./conversation-panel"
import { ServicesProvider, SidebarProvider, PanelProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import * as boardStoreModule from "@/stores/board-store"
import * as streamStoreModule from "@/stores/stream-store"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as messageReactionsModule from "@/hooks/use-message-reactions"
import * as syncEngineModule from "@/sync/sync-engine"
import * as userProfileModule from "@/components/user-profile"
import * as contextsModule from "@/contexts"
import type { BoardViewPost } from "@/hooks/use-stable-board-view"

const WORKSPACE_ID = "ws_1"
const CONVERSATION_ID = "conv_1"

function makeMessage(overrides: Partial<BoardPostMessage> = {}): BoardPostMessage {
  return {
    id: "msg_1",
    streamId: "stream_1",
    authorId: "usr_me",
    authorType: "user",
    contentMarkdown: "Opening message body.",
    reactions: {},
    attachments: [],
    linkPreviews: [],
    createdAt: "2026-06-22T12:00:00.000Z",
    ...overrides,
  }
}

function makeConversation(): ConversationWithStaleness {
  const now = "2026-06-22T12:00:00.000Z"
  return {
    id: CONVERSATION_ID,
    streamId: "stream_1",
    workspaceId: WORKSPACE_ID,
    messageIds: ["msg_1", "msg_2"],
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
  }
}

function makePost(): BoardPost {
  const conversation = makeConversation()
  return {
    conversation,
    openingMessage: makeMessage({ id: "msg_1" }),
    recentMessages: [makeMessage({ id: "msg_2", contentMarkdown: "Reply two body." })],
    totalReplies: 1,
    streamIds: ["stream_1"],
  }
}

function asCached(post: BoardPost): BoardViewPost {
  return { ...post, id: post.conversation.id, workspaceId: WORKSPACE_ID, _lastActivityMs: 0, _cachedAt: 0 }
}

function mountPanel(opts: {
  cached?: BoardViewPost | null
  getBoardPost?: () => Promise<BoardPost>
  getBoardMessages?: () => Promise<BoardPostMessage[]>
}) {
  const getBoardPost = vi.fn(opts.getBoardPost ?? (async () => makePost()))
  const getBoardMessages = vi.fn(
    opts.getBoardMessages ?? (async () => [makeMessage({ id: "msg_2", contentMarkdown: "Reply two body." })])
  )
  vi.spyOn(boardStoreModule, "useBoardPost").mockReturnValue(opts.cached as never)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ServicesProvider services={{ conversations: { getBoardPost, getBoardMessages } as never }}>
          <SidebarProvider>
            <MemoryRouter initialEntries={[`/w/${WORKSPACE_ID}/board?panel=conv:${CONVERSATION_ID}`]}>
              <PanelProvider>
                <ConversationPanel workspaceId={WORKSPACE_ID} onClose={vi.fn()} />
              </PanelProvider>
            </MemoryRouter>
          </SidebarProvider>
        </ServicesProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
  return { getBoardPost, getBoardMessages }
}

beforeEach(() => {
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceMetadata").mockReturnValue(undefined as never)
  // The panel resolves its host stream type from the synced IDB row.
  vi.spyOn(streamStoreModule, "useStreamFromStore").mockReturnValue({ id: "stream_1", type: "channel" } as never)
  vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue("usr_me")
  vi.spyOn(messageReactionsModule, "useMessageReactions").mockReturnValue({
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    toggleReaction: vi.fn(),
    toggleByEmoji: vi.fn(),
  } as unknown as ReturnType<typeof messageReactionsModule.useMessageReactions>)
  // The panel declares its conversation's streams to the SyncEngine (own slot).
  vi.spyOn(syncEngineModule, "useSyncEngine").mockReturnValue({
    setBoardStreamIds: vi.fn(),
    setPanelStreamIds: vi.fn(),
  } as unknown as ReturnType<typeof syncEngineModule.useSyncEngine>)
  vi.spyOn(userProfileModule, "useUserProfile").mockReturnValue({ openUserProfile: vi.fn() })
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { timezone: "UTC", locale: "en-US" },
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
})

afterEach(() => vi.restoreAllMocks())

describe("ConversationPanel", () => {
  it("renders the conversation from the reactive store row without a by-id fetch", async () => {
    const { getBoardPost } = mountPanel({ cached: asCached(makePost()) })
    expect(await screen.findByText("Opening message body.")).toBeTruthy()
    expect(await screen.findByText("Reply two body.")).toBeTruthy()
    // A card already on the board never round-trips for its projection.
    expect(getBoardPost).not.toHaveBeenCalled()
  })

  it("offers a scoped reply affordance", async () => {
    mountPanel({ cached: asCached(makePost()) })
    await screen.findByText("Opening message body.")
    expect(screen.getByRole("button", { name: "Write a reply…" })).toBeTruthy()
  })

  it("fetches the post by id when the store has no row (deep-link / in-stream list)", async () => {
    const { getBoardPost } = mountPanel({ cached: null })
    expect(await screen.findByText("Opening message body.")).toBeTruthy()
    await waitFor(() => expect(getBoardPost).toHaveBeenCalledWith(WORKSPACE_ID, CONVERSATION_ID))
  })

  it("shows a not-found state when the conversation is gone/unreadable", async () => {
    mountPanel({
      cached: null,
      getBoardPost: async () => {
        throw new Error("404")
      },
    })
    expect(await screen.findByText("Conversation not found")).toBeTruthy()
  })
})
