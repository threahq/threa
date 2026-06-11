import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import type { Conversation } from "../conversations"
import type { Message } from "../messaging"
import { MemoService } from "./service"
import { MemoRepository } from "./repository"
import { PendingItemRepository, type PendingMemoItem } from "./pending-item-repository"
import type { MemoContent } from "./memorizer"
import type { ConversationClassification } from "./classifier"
import { OutboxRepository } from "../../lib/outbox"
import { StreamEventRepository, StreamStateRepository } from "../streams"
import type { StreamEvent } from "../streams"
import { ConversationRepository } from "../conversations"
import { MessageRepository } from "../messaging"
import { UserRepository } from "../workspaces"
import * as dbModule from "../../db"

const WORKSPACE_ID = "ws_1"
const STREAM_ID = "stream_1"
const CONVERSATION_ID = "conv_1"

function fakePendingItem(): PendingMemoItem {
  return {
    id: "pend_1",
    workspaceId: WORKSPACE_ID,
    streamId: STREAM_ID,
    itemType: "conversation",
    itemId: CONVERSATION_ID,
    queuedAt: new Date(),
    processedAt: null,
  }
}

function fakeConversation(): Conversation {
  return {
    id: CONVERSATION_ID,
    streamId: STREAM_ID,
    workspaceId: WORKSPACE_ID,
    topicSummary: "Deciding on ID format",
    completenessScore: 1,
    confidence: 1,
    status: "complete",
    parentConversationId: null,
    lastActivityAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    messageIds: ["msg_1", "msg_2"],
    participantIds: ["usr_1"],
    secondaryMessageIds: [],
  } as unknown as Conversation
}

function fakeMessages(): Map<string, Message> {
  const base = {
    workspaceId: WORKSPACE_ID,
    streamId: STREAM_ID,
    authorId: "usr_1",
    authorType: "user",
  }
  return new Map<string, Message>([
    ["msg_1", { ...base, id: "msg_1" } as unknown as Message],
    ["msg_2", { ...base, id: "msg_2" } as unknown as Message],
  ])
}

const memoContent: MemoContent = {
  title: "Use prefixed ULIDs for all entities",
  abstract: "The team decided every entity id is a prefixed ULID.",
  knowledgeType: "decision",
  keyPoints: ["Prefixed ULIDs everywhere"],
  tags: ["ids"],
  sourceMessageIds: ["msg_1", "msg_2"],
}

const classification: ConversationClassification = {
  isKnowledgeWorthy: true,
  shouldReviseExisting: false,
  revisionReason: null,
  confidence: 0.95,
}

function setupService(options: { memoContents: MemoContent[] }) {
  const fakeClient = {} as PoolClient
  spyOn(dbModule, "withClient").mockImplementation((async (_pool: unknown, fn: (c: PoolClient) => unknown) =>
    fn(fakeClient)) as typeof dbModule.withClient)
  spyOn(dbModule, "withTransaction").mockImplementation((async (_pool: unknown, fn: (c: PoolClient) => unknown) =>
    fn(fakeClient)) as typeof dbModule.withTransaction)

  spyOn(PendingItemRepository, "findUnprocessed").mockResolvedValue([fakePendingItem()])
  spyOn(PendingItemRepository, "markProcessed").mockResolvedValue(undefined as never)
  spyOn(MemoRepository, "findByStream").mockResolvedValue([])
  spyOn(MemoRepository, "getAllTags").mockResolvedValue([])
  spyOn(MemoRepository, "findActiveBySourceConversation").mockResolvedValue([])
  spyOn(MemoRepository, "insert").mockResolvedValue(undefined as never)
  spyOn(MemoRepository, "updateEmbedding").mockResolvedValue(undefined as never)
  spyOn(ConversationRepository, "findById").mockResolvedValue(fakeConversation())
  spyOn(MessageRepository, "findByIds").mockResolvedValue(fakeMessages())
  spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_1", timezone: "UTC" }] as never)
  spyOn(StreamStateRepository, "markProcessed").mockResolvedValue(undefined as never)
  const outboxInsert = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

  const insertedStreamEvent: StreamEvent = {
    id: "evt_capture",
    streamId: STREAM_ID,
    sequence: 10n,
    broadcastSequence: 7n,
    eventType: "memos:captured",
    payload: {},
    actorId: null,
    actorType: "system",
    createdAt: new Date(),
  }
  const streamEventInsert = spyOn(StreamEventRepository, "insert").mockResolvedValue(insertedStreamEvent)

  const service = new MemoService({
    pool: {} as never,
    classifier: { classifyConversation: async () => classification } as never,
    memorizer: {
      memorizeConversation: async () => options.memoContents,
      reviseMemo: async () => [],
    } as never,
    embeddingService: {
      embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2]),
    } as never,
    messageFormatter: { formatMessages: async () => "formatted conversation" } as never,
  })

  return { service, streamEventInsert, outboxInsert, insertedStreamEvent }
}

describe("MemoService.processBatch — memos:captured timeline event (INV-62)", () => {
  afterEach(() => mock.restore())

  it("appends a memos:captured stream event with memo provenance in the save transaction", async () => {
    const { service, streamEventInsert, outboxInsert, insertedStreamEvent } = setupService({
      memoContents: [memoContent],
    })

    const result = await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(result.memosCreated).toBe(1)
    expect(streamEventInsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        streamId: STREAM_ID,
        eventType: "memos:captured",
        actorType: "system",
        payload: {
          conversationId: CONVERSATION_ID,
          memos: [
            {
              memoId: expect.stringMatching(/^memo_/),
              title: memoContent.title,
              knowledgeType: memoContent.knowledgeType,
              sourceMessageIds: memoContent.sourceMessageIds,
            },
          ],
        },
      })
    )

    // The full stream event rides the outbox row so clients append it without a fetch
    expect(outboxInsert).toHaveBeenCalledWith(expect.anything(), "stream:memos_captured", {
      workspaceId: WORKSPACE_ID,
      streamId: STREAM_ID,
      event: insertedStreamEvent,
    })
  })

  it("does not append a capture event when the memorizer yields no memos", async () => {
    const { service, streamEventInsert, outboxInsert } = setupService({ memoContents: [] })

    const result = await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(result.memosCreated).toBe(0)
    expect(streamEventInsert).not.toHaveBeenCalled()
    const outboxTypes = outboxInsert.mock.calls.map((call) => call[1])
    expect(outboxTypes).not.toContain("stream:memos_captured")
  })
})
