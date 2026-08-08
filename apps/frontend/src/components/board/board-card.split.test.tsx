import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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
import * as conversationReadModule from "@/components/message/conversation-read-context"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as messageReactionsModule from "@/hooks/use-message-reactions"
import * as userProfileModule from "@/components/user-profile"
import * as syncEngineModule from "@/sync/sync-engine"
import * as contextsModule from "@/contexts"
import * as queueDraftModule from "@/hooks/use-queue-draft-message"

const WS = "ws_1"

function cachedStream(id: string, type: string, extra: Partial<CachedStream> = {}): CachedStream {
  return {
    id,
    workspaceId: WS,
    type: type as CachedStream["type"],
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
    createdAt: "2026-06-22T12:00:00.000Z",
    updatedAt: "2026-06-22T12:00:00.000Z",
    archivedAt: null,
    _cachedAt: 0,
    ...extra,
  }
}

function makePost(opts: {
  id: string
  streamId: string
  messageIds: string[]
  opening: { id: string; streamId: string; content: string }
  streamIds: string[]
  totalReplies: number
}): CachedBoardPost {
  return {
    id: opts.id,
    workspaceId: WS,
    _lastActivityMs: 0,
    _cachedAt: 0,
    streamIds: opts.streamIds,
    rootStreamId: "stream_1",
    rootStreamType: "channel",
    hasCapturedMemo: false,
    conversation: {
      id: opts.id,
      streamId: opts.streamId,
      workspaceId: WS,
      messageIds: opts.messageIds,
      participantIds: [],
      secondaryMessageIds: [],
      topicSummary: "Soft migration",
      completenessScore: 0,
      confidence: 1,
      status: "active",
      parentConversationId: null,
      lastActivityAt: "2026-06-22T12:00:00.000Z",
      createdAt: "2026-06-22T12:00:00.000Z",
      updatedAt: "2026-06-22T12:00:00.000Z",
      temporalStaleness: 0,
      effectiveCompleteness: 0,
    },
    openingMessage: {
      id: opts.opening.id,
      streamId: opts.opening.streamId,
      authorId: "usr_other",
      authorType: "user",
      contentMarkdown: opts.opening.content,
      reactions: {},
      attachments: [],
      linkPreviews: [],
      createdAt: "2026-06-22T12:00:00.000Z",
      editedAt: null,
    },
    recentMessages: [],
    totalReplies: opts.totalReplies,
  } as unknown as CachedBoardPost
}

function messageEvent(id: string, streamId: string, seconds: number, content: string): CachedEvent {
  return {
    id: `evt_${id}`,
    workspaceId: WS,
    streamId,
    sequence: String(seconds),
    _sequenceNum: seconds,
    eventType: "message_created",
    payload: { messageId: id, contentMarkdown: content, reactions: {} },
    actorId: "usr_other",
    actorType: "user",
    createdAt: `2026-06-22T12:00:${String(seconds).padStart(2, "0")}.000Z`,
    _cachedAt: seconds,
  }
}

const splitThread = vi.fn().mockResolvedValue({
  conversation: { id: "conv_new" },
  sourceConversation: { id: "conv_soft" },
})

function mount(post: CachedBoardPost) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ServicesProvider services={{ conversations: { splitThread } as never }}>
          <MemoryRouter initialEntries={[`/w/${WS}/board`]}>
            <TraceProvider>
              <PanelProvider>
                <MediaGalleryProvider>
                  <BoardCard
                    workspaceId={WS}
                    post={post as BoardViewPost}
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

const readValue = { state: () => "ungated" as const, markReadUpToHere: vi.fn(), markUnread: vi.fn() }

// A soft migration: two messages in the channel, then one in the thread — the
// convert-to-thread "continued in …" seam, which carries the split affordance.
function seedSoftMigration() {
  return Promise.all([
    db.streams.bulkPut([
      cachedStream("stream_1", StreamTypes.CHANNEL),
      cachedStream("thread_soft", StreamTypes.THREAD, {
        parentStreamId: "stream_1",
        rootStreamId: "stream_1",
        parentMessageId: "sr2",
      }),
    ]),
    db.events.bulkPut([
      messageEvent("sr1", "stream_1", 10, "First in channel."),
      messageEvent("sr2", "stream_1", 11, "Second in channel."),
      messageEvent("st1", "thread_soft", 12, "Moved into the thread."),
    ]),
    db.conversations.bulkPut([
      makePost({
        id: "conv_soft",
        streamId: "stream_1",
        messageIds: ["sr1", "sr2", "st1"],
        opening: { id: "sr1", streamId: "stream_1", content: "First in channel." },
        streamIds: ["stream_1", "thread_soft"],
        totalReplies: 2,
      }),
    ]),
  ])
}

beforeEach(async () => {
  splitThread.mockClear()
  __clearBoardRailRegistry()
  __clearConversationGraphRegistry()
  await db.events.clear()
  await db.streams.clear()
  await db.conversations.clear()
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceMetadata").mockReturnValue(undefined as never)
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
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { timezone: "UTC", locale: "en-US" },
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  vi.spyOn(conversationReadModule, "useConversationReadController").mockReturnValue({
    value: readValue,
    hasUnread: () => false,
    markReadSilently: () => Promise.resolve(),
    setExplicitUnreadListener: () => {},
    getReadTruth: () => ({ lastReadSequence: null, readMessageIds: [] }),
  })
})

afterEach(() => vi.restoreAllMocks())

describe("BoardCard split-thread", () => {
  it("offers the split affordance on a soft-thread seam and calls the API on confirm", async () => {
    const user = userEvent.setup()
    await seedSoftMigration()

    mount(
      makePost({
        id: "conv_soft",
        streamId: "stream_1",
        messageIds: ["sr1", "sr2", "st1"],
        opening: { id: "sr1", streamId: "stream_1", content: "First in channel." },
        streamIds: ["stream_1", "thread_soft"],
        totalReplies: 2,
      })
    )

    // The soft seam shows the heal action.
    await screen.findByText("Moved into the thread.")
    const splitButton = await screen.findByRole("button", { name: "Split into its own topic" })

    // Confirm-then-act: nothing fires until the dialog's Split is pressed.
    await user.click(splitButton)
    await screen.findByText("Split this thread into its own topic?")
    expect(splitThread).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Split" }))
    expect(splitThread).toHaveBeenCalledWith(WS, "conv_soft", "thread_soft")
  })

  it("does not call the API when the confirm dialog is cancelled", async () => {
    const user = userEvent.setup()
    await seedSoftMigration()

    mount(
      makePost({
        id: "conv_soft",
        streamId: "stream_1",
        messageIds: ["sr1", "sr2", "st1"],
        opening: { id: "sr1", streamId: "stream_1", content: "First in channel." },
        streamIds: ["stream_1", "thread_soft"],
        totalReplies: 2,
      })
    )

    await user.click(await screen.findByRole("button", { name: "Split into its own topic" }))
    await user.click(await screen.findByRole("button", { name: "Cancel" }))
    expect(splitThread).not.toHaveBeenCalled()
  })
})
