import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import type { Pool, PoolClient } from "pg"
import {
  ConversationStatuses,
  MemoStatuses,
  MemoryModes,
  StreamTypes,
  Visibilities,
  type MemoryMode,
} from "@threahq/types"
import { ConversationRepository } from "../../src/features/conversations"
import {
  MemoAccumulatorHandler,
  MemoExplorerService,
  MemoRepository,
  MemoService,
  PendingItemRepository,
  StubEmbeddingService,
  StubReranker,
} from "../../src/features/memos"
import type { ConversationClassification } from "../../src/features/memos/classifier"
import { MessageRepository, type Message } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import type { OutboxEvent } from "../../src/lib/outbox"
import { conversationId, memoId, messageId, pendingItemId, streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupTestDatabase, testMessageContent, withTransaction } from "./setup"

const worthy: ConversationClassification = {
  isKnowledgeWorthy: true,
  shouldReviseExisting: false,
  revisionReason: null,
  confidence: 0.9,
  containsActionItems: false,
}

class TestableMemoAccumulatorHandler extends MemoAccumulatorHandler {
  run(event: OutboxEvent): Promise<void> {
    return this["processEvent"](event)
  }
}

describe("memo sources: deleted and edited messages", () => {
  let pool: Pool
  let testWorkspaceId: string
  let testUserId: string
  let handler: TestableMemoAccumulatorHandler

  interface Seeded {
    streamId: string
    conversationId: string
    messageIds: string[]
  }

  /** A resolved two-message conversation in its own public channel, with nothing queued. */
  async function seedConversation(memoryMode: MemoryMode = MemoryModes.AUTO): Promise<Seeded> {
    const seeded: Seeded = { streamId: streamId(), conversationId: conversationId(), messageIds: [] }
    await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id: seeded.streamId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PUBLIC,
        slug: `c-${seeded.streamId.slice(-8)}`,
        createdBy: testUserId,
        memoryMode,
      })
      await StreamMemberRepository.insert(client, seeded.streamId, testUserId)
      await ConversationRepository.insert(client, {
        id: seeded.conversationId,
        streamId: seeded.streamId,
        workspaceId: testWorkspaceId,
        status: ConversationStatuses.RESOLVED,
      })
      for (const [index, text] of ["the rollout starts on Monday", "and the flag defaults to off"].entries()) {
        const id = messageId()
        await MessageRepository.insert(client, {
          id,
          streamId: seeded.streamId,
          sequence: BigInt(index + 1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent(text),
        })
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, seeded.conversationId, id, testUserId)
        seeded.messageIds.push(id)
      }
    })
    return seeded
  }

  async function seedMemo(seeded: Seeded, sourceMessageIds: string[]): Promise<string> {
    const id = memoId()
    await MemoRepository.insert(pool, {
      id,
      workspaceId: testWorkspaceId,
      memoType: "conversation",
      sourceConversationId: seeded.conversationId,
      title: "Rollout plan",
      abstract: "The rollout starts on Monday with the flag off.",
      keyPoints: [],
      sourceMessageIds,
      participantIds: [testUserId],
      knowledgeType: "decision",
      tags: [],
      status: MemoStatuses.ACTIVE,
    })
    return id
  }

  async function queue(client: PoolClient, seeded: Seeded) {
    await PendingItemRepository.queue(client, [
      {
        id: pendingItemId(),
        workspaceId: testWorkspaceId,
        streamId: seeded.streamId,
        itemType: "conversation",
        itemId: seeded.conversationId,
      },
    ])
  }

  /** A thread under the conversation's first message, holding one reply. */
  async function seedThreadReply(seeded: Seeded): Promise<{ threadId: string; replyId: string }> {
    const threadId = streamId()
    const replyId = messageId()
    await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id: threadId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.THREAD,
        visibility: Visibilities.PUBLIC,
        parentStreamId: seeded.streamId,
        rootStreamId: seeded.streamId,
        parentAnchorId: seeded.messageIds[0],
        createdBy: testUserId,
        memoryMode: MemoryModes.AUTO,
      })
      await MessageRepository.insert(client, {
        id: replyId,
        streamId: threadId,
        sequence: 1n,
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("the flag flips on Wednesday"),
      })
    })
    return { threadId, replyId }
  }

  async function deleteMessage(seeded: { streamId: string }, id: string): Promise<void> {
    const deleted = await MessageRepository.softDelete(pool, id)
    await handler.run({
      id: 1n,
      eventType: "message:deleted",
      createdAt: new Date(),
      payload: {
        workspaceId: testWorkspaceId,
        streamId: seeded.streamId,
        messageId: id,
        deletedAt: deleted!.deletedAt!.toISOString(),
      },
    } as unknown as OutboxEvent)
  }

  /** Resolves once `deletion` has finished, or is waiting on the stream's memo save lock. */
  async function finishedOrBlocked(deletion: Promise<void>, rootStreamId: string): Promise<void> {
    let finished = false
    void deletion.finally(() => {
      finished = true
    })
    while (!finished) {
      const { rows } = await pool.query(
        `SELECT 1 FROM pg_locks
         WHERE locktype = 'advisory' AND NOT granted
           AND objid::bigint = hashtext($1)::bigint & 4294967295`,
        [`memo-batch:${rootStreamId}`]
      )
      if (rows.length > 0) return
      await Bun.sleep(10)
    }
  }

  async function editMessage(seeded: Seeded, id: string): Promise<void> {
    await handler.run({
      id: 1n,
      eventType: "message:edited",
      createdAt: new Date(),
      payload: {
        workspaceId: testWorkspaceId,
        streamId: seeded.streamId,
        event: { eventType: "message_edited", streamId: seeded.streamId, payload: { messageId: id } },
      },
    } as unknown as OutboxEvent)
  }

  /** A batch whose memorizer captures one memo citing every message it was shown. */
  function capturingService(classify: () => Promise<ConversationClassification> = async () => worthy): MemoService {
    return new MemoService({
      pool,
      classifier: { classifyConversation: classify },
      memorizer: {
        memorizeConversation: async (_formatted: string, context: { content: { id: string }[] }) => [
          {
            title: "Rollout plan",
            abstract: "The rollout starts on Monday with the flag off.",
            keyPoints: [],
            sourceMessageIds: context.content.map((m) => m.id),
            knowledgeType: "decision",
            tags: [],
          },
        ],
      } as never,
      embeddingService: {
        embedBatch: async () => [Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))],
      } as never,
      messageFormatter: { formatMessages: async () => "formatted transcript" } as never,
    })
  }

  async function activeMemosCiting(id: string): Promise<number> {
    return (await MemoRepository.findActiveCitingMessage(pool, testWorkspaceId, id)).length
  }

  async function memoStatus(id: string): Promise<string | undefined> {
    return (await MemoRepository.findById(pool, id))?.status
  }

  async function isQueued(seeded: Seeded): Promise<boolean> {
    const { rows } = await pool.query(
      `SELECT processed_at FROM memo_pending_items WHERE workspace_id = $1 AND item_id = $2 AND stream_id = $3`,
      [testWorkspaceId, seeded.conversationId, seeded.streamId]
    )
    return rows.length === 1 && rows[0].processed_at === null
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    handler = new TestableMemoAccumulatorHandler(pool)
    testWorkspaceId = workspaceId()
    const workosUserId = userId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Memo Deleted Sources",
        slug: `memo-deleted-sources-${testWorkspaceId}`,
        createdBy: workosUserId,
      })
      testUserId = (await addTestMember(client, testWorkspaceId, workosUserId)).id
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("a batch shows the model only the messages that are not deleted", async () => {
    const seeded = await seedConversation()
    const [deletedId, liveId] = seeded.messageIds
    await MessageRepository.softDelete(pool, deletedId)
    await withTransaction(pool, (client) => queue(client, seeded))
    const formatted: string[][] = []
    const memorized: string[][] = []

    await new MemoService({
      pool,
      classifier: { classifyConversation: async () => worthy },
      memorizer: {
        memorizeConversation: async (_formatted: string, context: { content: { id: string }[] }) => {
          memorized.push(context.content.map((m) => m.id))
          return []
        },
      } as never,
      embeddingService: { embedBatch: async () => [] } as never,
      messageFormatter: {
        formatMessages: async (_db: unknown, _ws: string, messages: Message[]) => {
          formatted.push(messages.map((m) => m.id))
          return "formatted transcript"
        },
      } as never,
    }).processBatch(testWorkspaceId, seeded.streamId)

    expect({ formatted, memorized }).toEqual({ formatted: [[liveId]], memorized: [[liveId]] })
  })

  test("memo detail leaves out deleted source messages", async () => {
    const seeded = await seedConversation()
    const [deletedId, liveId] = seeded.messageIds
    const memo = await seedMemo(seeded, seeded.messageIds)
    await MessageRepository.softDelete(pool, deletedId)

    const detail = await new MemoExplorerService({
      pool,
      embeddingService: new StubEmbeddingService(),
      reranker: new StubReranker(),
    }).getById(testWorkspaceId, memo, { accessibleStreamIds: [seeded.streamId], userId: testUserId })

    expect(detail?.sourceMessages.map((m) => m.id)).toEqual([liveId])
  })

  test("deleting every source of a memo archives it", async () => {
    const seeded = await seedConversation()
    const [onlySourceId] = seeded.messageIds
    const memo = await seedMemo(seeded, [onlySourceId])

    await deleteMessage(seeded, onlySourceId)

    expect(await memoStatus(memo)).toBe(MemoStatuses.ARCHIVED)
  })

  test("deleting one of several sources supersedes the memo and requeues its conversation", async () => {
    const seeded = await seedConversation()
    const memo = await seedMemo(seeded, seeded.messageIds)

    await deleteMessage(seeded, seeded.messageIds[0])

    expect({ status: await memoStatus(memo), queued: await isQueued(seeded) }).toEqual({
      status: MemoStatuses.SUPERSEDED,
      queued: true,
    })
  })

  test("deleting one of several sources of a saved memo supersedes it", async () => {
    const seeded = await seedConversation()
    const memo = memoId()
    await MemoRepository.insert(pool, {
      id: memo,
      workspaceId: testWorkspaceId,
      memoType: "message",
      sourceMessageId: seeded.messageIds[0],
      title: "Rollout plan",
      abstract: "The rollout starts on Monday with the flag off.",
      keyPoints: [],
      sourceMessageIds: seeded.messageIds,
      participantIds: [testUserId],
      knowledgeType: "decision",
      tags: [],
      status: MemoStatuses.ACTIVE,
    })

    await deleteMessage(seeded, seeded.messageIds[1])

    expect(await memoStatus(memo)).toBe(MemoStatuses.SUPERSEDED)
  })

  test("deleting a message no memo cites leaves memos alone and requeues its conversation", async () => {
    const seeded = await seedConversation()
    const memo = await seedMemo(seeded, [seeded.messageIds[1]])

    await deleteMessage(seeded, seeded.messageIds[0])

    expect({ status: await memoStatus(memo), queued: await isQueued(seeded) }).toEqual({
      status: MemoStatuses.ACTIVE,
      queued: true,
    })
  })

  test("with memory off, deleting a source still retires the memo but queues nothing", async () => {
    const seeded = await seedConversation(MemoryModes.OFF)
    const memo = await seedMemo(seeded, seeded.messageIds)

    await deleteMessage(seeded, seeded.messageIds[0])

    expect({ status: await memoStatus(memo), queued: await isQueued(seeded) }).toEqual({
      status: MemoStatuses.SUPERSEDED,
      queued: false,
    })
  })

  test("a message deleted while the model calls run is not cited by the saved memos", async () => {
    const seeded = await seedConversation()
    await withTransaction(pool, (client) => queue(client, seeded))
    const [deletedId] = seeded.messageIds

    await capturingService(async () => {
      await deleteMessage(seeded, deletedId)
      return worthy
    }).processBatch(testWorkspaceId, seeded.streamId)

    expect({ citing: await activeMemosCiting(deletedId), queued: await isQueued(seeded) }).toEqual({
      citing: 0,
      queued: true,
    })
  })

  test("a message deleted while a batch saves retires the memo that batch saved", async () => {
    const seeded = await seedConversation()
    await withTransaction(pool, (client) => queue(client, seeded))
    const [deletedId] = seeded.messageIds
    const findNearDuplicate = MemoRepository.findNearDuplicate
    let deletion: Promise<void> | undefined
    const spy = spyOn(MemoRepository, "findNearDuplicate").mockImplementation(async (...args) => {
      deletion ??= deleteMessage(seeded, deletedId)
      await finishedOrBlocked(deletion, seeded.streamId)
      return findNearDuplicate(...args)
    })

    try {
      await capturingService().processBatch(testWorkspaceId, seeded.streamId)
      await deletion
    } finally {
      spy.mockRestore()
    }

    expect({ citing: await activeMemosCiting(deletedId), queued: await isQueued(seeded) }).toEqual({
      citing: 0,
      queued: true,
    })
  })

  test("a thread message deleted while save_memo saves in that thread retires the memo", async () => {
    const seeded = await seedConversation()
    const { threadId, replyId } = await seedThreadReply(seeded)
    const findNearDuplicate = MemoRepository.findNearDuplicate
    let deletion: Promise<void> | undefined
    const spy = spyOn(MemoRepository, "findNearDuplicate").mockImplementation(async (...args) => {
      deletion ??= deleteMessage({ streamId: threadId }, replyId)
      await finishedOrBlocked(deletion, seeded.streamId)
      return findNearDuplicate(...args)
    })

    try {
      await capturingService().saveMemo({
        workspaceId: testWorkspaceId,
        streamId: threadId,
        sessionId: null,
        sourceStreamIds: [threadId, seeded.streamId],
        title: "Flag flip",
        abstract: "The flag flips on Wednesday.",
        keyPoints: [],
        tags: [],
        knowledgeType: "decision",
        sourceMessageIds: [replyId],
      })
      await deletion
    } finally {
      spy.mockRestore()
    }

    expect(await activeMemosCiting(replyId)).toBe(0)
  })

  describe("reflective capture", () => {
    async function capture(
      seeded: Seeded,
      cited: { streamId: string; messageId: string },
      onClassify: () => Promise<void>
    ): Promise<string[][]> {
      const session = `session_${seeded.conversationId}`
      await capturingService(async () => {
        await onClassify()
        return worthy
      }).captureSessionReflection({
        workspaceId: testWorkspaceId,
        streamId: seeded.streamId,
        sessionId: session,
        digest: "Trigger: when does the flag flip?",
        anchorMessageId: seeded.messageIds[0],
        participantIds: [testUserId],
        citedStreamIds: [cited.streamId],
        citedMessageIds: [cited.messageId],
      })
      const { rows } = await pool.query(`SELECT source_message_ids FROM memos WHERE source_session_id = $1`, [session])
      return rows.map((row) => row.source_message_ids)
    }

    test("research deleted while the model calls run captures nothing", async () => {
      const seeded = await seedConversation()
      const { threadId, replyId } = await seedThreadReply(seeded)

      const sources = await capture(seeded, { streamId: threadId, messageId: replyId }, () =>
        deleteMessage({ streamId: threadId }, replyId)
      )

      expect(sources).toEqual([])
    })

    test("an anchor deleted while the model calls run captures nothing", async () => {
      const seeded = await seedConversation()
      const { threadId, replyId } = await seedThreadReply(seeded)

      const sources = await capture(seeded, { streamId: threadId, messageId: replyId }, () =>
        deleteMessage(seeded, seeded.messageIds[0])
      )

      expect(sources).toEqual([])
    })
  })

  test("editing a message requeues its conversation", async () => {
    const seeded = await seedConversation()

    await editMessage(seeded, seeded.messageIds[0])

    expect(await isQueued(seeded)).toBe(true)
  })
})
