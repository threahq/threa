import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StreamTypes } from "@threa/types"
import { BoardCard } from "./board-card"
import type { BoardViewPost } from "@/hooks/use-stable-board-view"
import { ServicesProvider, PanelProvider, TraceProvider, createDraftPanelId } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import { __clearBoardRailRegistry, publishOptimisticRailEvent } from "@/hooks/use-board-card-messages"
import { __clearConversationGraphRegistry } from "@/hooks/use-conversation-graph"
import { spyOnExport } from "@/test/spy"
// eslint-disable-next-line no-restricted-imports -- test seeds IDB directly to drive the real graph + structural index
import { db, type CachedEvent, type CachedStream, type CachedBoardPost } from "@/db"
import * as conversationReadModule from "@/components/message/conversation-read-context"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as messageReactionsModule from "@/hooks/use-message-reactions"
import * as userProfileModule from "@/components/user-profile"
import * as syncEngineModule from "@/sync/sync-engine"
import * as contextsModule from "@/contexts"
import * as queueDraftModule from "@/hooks/use-queue-draft-message"
import * as inlineComposerModule from "@/components/board/board-inline-composer"

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
  topicSummary: string
  streamIds: string[]
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
      topicSummary: opts.topicSummary,
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
      id: "m_open",
      streamId: "stream_1",
      authorId: "usr_other",
      authorType: "user",
      contentMarkdown: "Hardware refresh opening.",
      reactions: {},
      attachments: [],
      linkPreviews: [],
      createdAt: "2026-06-22T12:00:00.000Z",
      editedAt: null,
    },
    recentMessages: [],
    totalReplies: 0,
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
  } as CachedEvent
}

function mount(post: CachedBoardPost) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ServicesProvider services={{ conversations: {} as never }}>
          <MemoryRouter initialEntries={[`/w/${WS}/board`]}>
            <TraceProvider>
              <PanelProvider>
                <BoardCard workspaceId={WS} post={post as BoardViewPost} contextLabel="#general" streamType="channel" />
              </PanelProvider>
            </TraceProvider>
          </MemoryRouter>
        </ServicesProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

const readValue = { state: () => "ungated" as const, markReadUpToHere: vi.fn(), markUnread: vi.fn() }

const SENT_DOC = { type: "doc", content: [] }

let queueDraftMessage: ReturnType<typeof vi.fn>

beforeEach(async () => {
  __clearBoardRailRegistry()
  __clearConversationGraphRegistry()
  await db.events.clear()
  await db.streams.clear()
  await db.conversations.clear()
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceMetadata").mockReturnValue(undefined as never)
  vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue("usr_me")
  // The queue seam: the inline composers' sends land here; each test asserts the
  // exact directive the gesture queued.
  queueDraftMessage = vi.fn().mockResolvedValue({ clientId: "client_1" })
  vi.spyOn(queueDraftModule, "useQueueDraftMessage").mockReturnValue({
    queueDraftMessage,
    currentUserId: "usr_me",
  } as unknown as ReturnType<typeof queueDraftModule.useQueueDraftMessage>)
  // Swap the heavy editor form for a stub that surfaces its placeholder and a
  // send button forwarding to `onSubmit` — the routing under test lives in the
  // gesture hook, not the editor mechanics.
  spyOnExport(inlineComposerModule, "InlineComposerForm").mockReturnValue(((props: {
    placeholder: string
    contextChip?: string
    onSubmit: (input: { contentJson: unknown }) => Promise<void>
  }) => (
    <div>
      {props.contextChip && <span>{props.contextChip}</span>}
      <span>{props.placeholder}</span>
      <button type="button" onClick={() => void props.onSubmit({ contentJson: SENT_DOC })}>
        Send inline
      </button>
    </div>
  )) as never)
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

async function seedParentWithBranch() {
  await db.streams.bulkPut([
    cachedStream("stream_1", StreamTypes.CHANNEL),
    cachedStream("thread_child", StreamTypes.THREAD, {
      parentStreamId: "stream_1",
      rootStreamId: "stream_1",
      parentMessageId: "m_open",
    }),
  ])
  await db.events.bulkPut([messageEvent("c1", "thread_child", 10, "Child branch message.")])
  const parent = makePost({
    id: "conv_parent",
    streamId: "stream_1",
    messageIds: ["m_open"],
    topicSummary: "Hardware refresh",
    streamIds: ["stream_1"],
  })
  const child = makePost({
    id: "conv_child",
    streamId: "thread_child",
    messageIds: ["c1"],
    topicSummary: "GPU budget",
    streamIds: ["thread_child"],
  })
  await db.conversations.bulkPut([parent, child])
  return { parent, child }
}

describe("BoardCard — inline sub-topic + branch reply", () => {
  it("expands an inline composer on New sub-topic and queues the send with streamCreation + newSubtopic", async () => {
    await db.streams.bulkPut([cachedStream("stream_1", StreamTypes.CHANNEL)])
    const post = makePost({
      id: "conv_parent",
      streamId: "stream_1",
      messageIds: ["m_open"],
      topicSummary: "Hardware refresh",
      streamIds: ["stream_1"],
    })
    await db.conversations.bulkPut([post])

    const user = userEvent.setup()
    mount(post)
    await screen.findByText("Hardware refresh opening.")

    await user.click(screen.getByRole("button", { name: "Message actions" }))
    await user.click(screen.getByText("New sub-topic"))

    // No navigation, no panel: the composer expands in place under the row.
    expect(await screen.findByText("Start a sub-topic…")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Send inline" }))
    expect(queueDraftMessage).toHaveBeenCalledWith(
      { contentJson: SENT_DOC },
      {
        workspaceId: WS,
        streamId: createDraftPanelId("stream_1", "m_open"),
        streamCreation: { type: StreamTypes.THREAD, parentStreamId: "stream_1", parentAnchorId: "m_open" },
        draftId: createDraftPanelId("stream_1", "m_open"),
        conversation: { intent: "newSubtopic" },
      }
    )
  })

  it("paints a new sub-topic's message while its write is still in flight", async () => {
    await db.streams.bulkPut([cachedStream("stream_1", StreamTypes.CHANNEL)])
    const post = makePost({
      id: "conv_parent",
      streamId: "stream_1",
      messageIds: ["m_open"],
      topicSummary: "Hardware refresh",
      streamIds: ["stream_1"],
    })
    await db.conversations.bulkPut([post])

    // Stand in for the real hook: publish the optimistic row onto the rail, then
    // hang on the write. Nothing reaches IDB, so only the eager path can render.
    let releaseWrite!: () => void
    const writeLanded = new Promise<void>((resolve) => (releaseWrite = resolve))
    queueDraftMessage.mockImplementation(async (_input: unknown, params: { streamId: string }) => {
      publishOptimisticRailEvent({
        ...messageEvent("temp_sub", params.streamId, 20, "eager sub-topic message"),
        id: "temp_sub",
        actorId: "usr_me",
        _status: "pending",
      } as CachedEvent)
      await writeLanded
      return { clientId: "temp_sub" }
    })

    const user = userEvent.setup()
    mount(post)
    await screen.findByText("Hardware refresh opening.")

    await user.click(screen.getByRole("button", { name: "Message actions" }))
    await user.click(screen.getByText("New sub-topic"))
    await user.click(screen.getByRole("button", { name: "Send inline" }))

    expect(await screen.findByText("eager sub-topic message")).toBeTruthy()
    releaseWrite()
  })

  it("hides New sub-topic on a message that already has a thread (adjustment D)", async () => {
    const { parent } = await seedParentWithBranch()

    const user = userEvent.setup()
    mount(parent)
    // The nested branch proves the thread is in the structural index, so the guard is live.
    await screen.findByText("GPU budget")

    const menus = screen.getAllByRole("button", { name: "Message actions" })
    await user.click(menus[0])
    expect(screen.queryByText("New sub-topic")).toBeNull()
  })

  it("expands an inline composer at the branch tail and queues the reply into the child conversation", async () => {
    const { parent } = await seedParentWithBranch()

    const user = userEvent.setup()
    mount(parent)
    await screen.findByText("Child branch message.")

    await user.click(screen.getByRole("button", { name: "Reply…" }))
    // The chip names the reply target — the inline forms all look alike.
    expect(await screen.findByText("Replying in GPU budget")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Send inline" }))
    expect(queueDraftMessage).toHaveBeenCalledWith(
      { contentJson: SENT_DOC },
      {
        workspaceId: WS,
        streamId: "thread_child",
        conversation: { intent: "existing", conversationId: "conv_child" },
      }
    )
  })

  it("offers Reply on a pending branch and queues it through the idempotent sub-topic path", async () => {
    // The child conversation echo hasn't landed (or was dropped by a flaky
    // socket): the pending branch must still let the author continue — routed
    // as another newSubtopic send, which mints-or-attaches server-side.
    await db.streams.bulkPut([cachedStream("stream_1", StreamTypes.CHANNEL)])
    const post = makePost({
      id: "conv_parent",
      streamId: "stream_1",
      messageIds: ["m_open"],
      topicSummary: "Hardware refresh",
      streamIds: ["stream_1"],
    })
    await db.conversations.bulkPut([post])

    const user = userEvent.setup()
    mount(post)
    await screen.findByText("Hardware refresh opening.")
    await user.click(screen.getByRole("button", { name: "Message actions" }))
    await user.click(screen.getByText("New sub-topic"))
    await user.click(await screen.findByRole("button", { name: "Send inline" }))

    // Simulate the queue's optimistic write so the pending branch renders.
    await db.events.put(messageEvent("pend_1", createDraftPanelId("stream_1", "m_open"), 30, "Pending sub-topic body."))
    await screen.findByText("Pending sub-topic body.")

    await user.click(await screen.findByRole("button", { name: "Reply…" }))
    // The pending branch has no extracted topic yet, so the chip names the target
    // generically rather than echoing the "New sub-topic" placeholder back.
    expect(await screen.findByText("Replying in this sub-topic")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Send inline" }))

    expect(queueDraftMessage).toHaveBeenLastCalledWith(
      { contentJson: SENT_DOC },
      {
        workspaceId: WS,
        streamId: createDraftPanelId("stream_1", "m_open"),
        streamCreation: { type: StreamTypes.THREAD, parentStreamId: "stream_1", parentAnchorId: "m_open" },
        draftId: createDraftPanelId("stream_1", "m_open"),
        conversation: { intent: "newSubtopic" },
      }
    )
  })

  it("renders the just-sent sub-topic message from the draft rail while the echo is pending", async () => {
    await db.streams.bulkPut([cachedStream("stream_1", StreamTypes.CHANNEL)])
    const post = makePost({
      id: "conv_parent",
      streamId: "stream_1",
      messageIds: ["m_open"],
      topicSummary: "Hardware refresh",
      streamIds: ["stream_1"],
    })
    await db.conversations.bulkPut([post])

    const user = userEvent.setup()
    mount(post)
    await screen.findByText("Hardware refresh opening.")
    await user.click(screen.getByRole("button", { name: "Message actions" }))
    await user.click(screen.getByText("New sub-topic"))
    await user.click(await screen.findByRole("button", { name: "Send inline" }))

    // The real queue writes the optimistic event onto the draft-panel rail;
    // simulate that write and assert the card renders it nested — the pending
    // message must not vanish before the conversation echo lands.
    await db.events.put(messageEvent("pend_1", createDraftPanelId("stream_1", "m_open"), 30, "Pending sub-topic body."))
    expect(await screen.findByText("Pending sub-topic body.")).toBeTruthy()
  })

  it("keeps one inline composer open per card — opening another closes the first", async () => {
    const { parent } = await seedParentWithBranch()

    const user = userEvent.setup()
    mount(parent)
    await screen.findByText("Child branch message.")

    // Open the branch-tail reply…
    await user.click(screen.getByRole("button", { name: "Reply…" }))
    // The composer stub renders the reply chip once it's mounted in the tail.
    expect(await screen.findByText("Replying in GPU budget")).toBeTruthy()

    // …then open New sub-topic under the branch's message row: the reply
    // composer closes (one inline composer per card).
    const menus = screen.getAllByRole("button", { name: "Message actions" })
    await user.click(menus[menus.length - 1])
    await user.click(screen.getByText("New sub-topic"))
    expect(await screen.findByText("Start a sub-topic…")).toBeTruthy()
    expect(screen.queryByText("Replying in GPU budget")).toBeNull()
  })
})
