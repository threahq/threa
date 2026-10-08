import { DisabledAnalyticsReporter } from "@threahq/backend-common"
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import type { Pool, PoolClient } from "pg"
import { ConversationStatuses, MemoryModes } from "@threahq/types"
import { ConversationRepository } from "../../src/features/conversations"
import { MemoRepository, MemoService, PendingItemRepository } from "../../src/features/memos"
import type { ConversationClassification } from "../../src/features/memos/classifier"
import { MEMO_CONVERSATION_WINDOW_CHARS, MEMO_MAX_FAILED_ATTEMPTS } from "../../src/features/memos/config"
import { MessageRepository } from "../../src/features/messaging"
import { StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { conversationId, messageId, pendingItemId, streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupTestDatabase, testMessageContent, withTransaction } from "./setup"

const worthy: ConversationClassification = {
  isKnowledgeWorthy: true,
  shouldReviseExisting: false,
  revisionReason: null,
  confidence: 0.9,
  containsActionItems: false,
}

let embedCalls = 0
function nextEmbedding(): number[] {
  const axis = embedCalls++
  return Array.from({ length: 1536 }, (_, i) => (i === axis ? 1 : 0))
}

async function fail(): Promise<never> {
  throw new Error("provider unavailable")
}

describe("memo batch: pending items", () => {
  let pool: Pool
  let testWorkspaceId: string
  let testUserId: string

  function serviceWith(overrides: {
    classify?: (conversation: { messageIds: string[] }) => Promise<ConversationClassification>
    embed?: () => Promise<number[][]>
    /** Collects the message ids each memorizer call was shown. */
    memorized?: string[][]
  }): MemoService {
    const memorize = async (_formatted: string, context: { content: { id: string }[] }) => {
      overrides.memorized?.push(context.content.map((m) => m.id))
      return [
        {
          title: "Start with auth",
          abstract: "The migration starts with the auth service.",
          keyPoints: [],
          sourceMessageIds: context.content.map((m) => m.id),
          knowledgeType: "decision",
          tags: [],
        },
      ]
    }
    return new MemoService({
      analyticsReporter: new DisabledAnalyticsReporter(),
      pool,
      classifier: { classifyConversation: overrides.classify ?? (async () => worthy) },
      memorizer: { memorizeConversation: memorize, reviseMemo: memorize } as never,
      embeddingService: { embedBatch: overrides.embed ?? (async () => [nextEmbedding()]) } as never,
      messageFormatter: { formatMessages: async () => "formatted transcript" } as never,
    })
  }

  /** A settled two-message conversation in its own stream, queued for capture. */
  async function seedQueuedConversation() {
    const ids = { streamId: streamId(), conversationId: conversationId() }
    await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id: ids.streamId,
        workspaceId: testWorkspaceId,
        type: "channel",
        visibility: "private",
        companionMode: "off",
        createdBy: testUserId,
      })
      await ConversationRepository.insert(client, {
        id: ids.conversationId,
        streamId: ids.streamId,
        workspaceId: testWorkspaceId,
        status: ConversationStatuses.RESOLVED,
      })
      for (const sequence of [1n, 2n]) {
        await addMessage(client, ids, sequence)
      }
      await requeue(client, ids)
    })
    return ids
  }

  async function addMessage(
    client: PoolClient,
    ids: { streamId: string; conversationId: string },
    sequence: bigint,
    message: { text: string; createdAt?: Date } = { text: "we start the migration with the auth service" }
  ): Promise<string> {
    const id = messageId()
    await MessageRepository.insert(client, {
      workspaceId: testWorkspaceId,
      id,
      streamId: ids.streamId,
      sequence,
      authorId: testUserId,
      authorType: "user",
      createdAt: message.createdAt,
      ...testMessageContent(message.text),
    })
    await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, ids.conversationId, id, testUserId)
    return id
  }

  async function requeue(client: PoolClient, ids: { streamId: string; conversationId: string }) {
    await PendingItemRepository.queue(client, [
      {
        id: pendingItemId(),
        workspaceId: testWorkspaceId,
        streamId: ids.streamId,
        itemType: "conversation",
        itemId: ids.conversationId,
      },
    ])
  }

  /** A reply landing and requeueing the conversation while the batch's model call is in flight. */
  async function replyMidFlight(ids: { streamId: string; conversationId: string }): Promise<string> {
    return withTransaction(pool, async (client) => {
      const id = await addMessage(client, ids, 3n)
      await requeue(client, ids)
      return id
    })
  }

  async function switchMemoryOff(ids: { streamId: string }) {
    await StreamRepository.update(pool, testWorkspaceId, ids.streamId, { memoryMode: MemoryModes.OFF })
  }

  async function pendingState(convId: string) {
    const { rows } = await pool.query(`SELECT * FROM memo_pending_items WHERE item_id = $1`, [convId])
    return {
      processed: rows[0].processed_at !== null,
      fingerprint: rows[0].classified_fingerprint,
      failedAttempts: rows[0].failed_attempts,
    }
  }

  async function memoCount(convId: string): Promise<number> {
    return (await MemoRepository.findActiveBySourceConversation(pool, testWorkspaceId, convId, [])).length
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testWorkspaceId = workspaceId()
    const workosUserId = userId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Memo Batch Pending Items",
        slug: `memo-batch-pending-items-${testWorkspaceId}`,
        createdBy: workosUserId,
      })
      testUserId = (await addTestMember(client, testWorkspaceId, workosUserId)).id
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("a conversation longer than one pass is read in passes that resume where the last one stopped", async () => {
    const seeded = await seedQueuedConversation()
    const longText = (part: number) => `part ${part} `.repeat(Math.ceil((MEMO_CONVERSATION_WINDOW_CHARS * 0.45) / 7))
    const earlier = await withTransaction(pool, async (client) => {
      const ids: string[] = []
      for (const part of [0, 1, 2]) {
        ids.push(
          await addMessage(client, seeded, BigInt(10 + part), {
            text: longText(part),
            createdAt: new Date(Date.UTC(2026, 6, 1, 10, part)),
          })
        )
      }
      return ids
    })
    const recent = (await ConversationRepository.findById(
      pool,
      testWorkspaceId,
      seeded.conversationId
    ))!.messageIds.filter((id) => !earlier.includes(id))
    const memorized: string[][] = []
    const revising = () => serviceWith({ memorized, classify: async () => ({ ...worthy, shouldReviseExisting: true }) })
    const readThrough = async () =>
      (await PendingItemRepository.findUnprocessed(pool, testWorkspaceId, seeded.streamId)).find(
        (p) => p.itemId === seeded.conversationId
      )?.readThrough

    await serviceWith({ memorized }).processBatch(testWorkspaceId, seeded.streamId)
    const afterFirst = { state: await pendingState(seeded.conversationId), readThrough: await readThrough() }
    await revising().processBatch(testWorkspaceId, seeded.streamId)
    const afterSecond = await pendingState(seeded.conversationId)
    const followUp = await withTransaction(pool, async (client) => {
      const id = await addMessage(client, seeded, 20n, { text: longText(3) })
      await requeue(client, seeded)
      return id
    })
    await revising().processBatch(testWorkspaceId, seeded.streamId)

    expect({ afterFirst, afterSecond, memorized: memorized.map((ids) => [...ids].sort()) }).toEqual({
      afterFirst: {
        state: { processed: false, fingerprint: null, failedAttempts: 0 },
        readThrough: new Date(Date.UTC(2026, 6, 1, 10, 1)),
      },
      afterSecond: { processed: true, fingerprint: expect.any(String), failedAttempts: 0 },
      memorized: [
        [earlier[0], earlier[1]].sort(),
        [earlier[1], earlier[2], ...recent].sort(),
        [earlier[2], ...recent, followUp].sort(),
      ],
    })
  })

  test("a classifier failure leaves the item pending with no fingerprint", async () => {
    const seeded = await seedQueuedConversation()

    await serviceWith({ classify: fail }).processBatch(testWorkspaceId, seeded.streamId)

    expect(await pendingState(seeded.conversationId)).toEqual({
      processed: false,
      fingerprint: null,
      failedAttempts: 1,
    })
  })

  test("an embedding failure after classification leaves the item pending with no fingerprint", async () => {
    const seeded = await seedQueuedConversation()

    await serviceWith({ embed: fail }).processBatch(testWorkspaceId, seeded.streamId)

    expect(await pendingState(seeded.conversationId)).toEqual({
      processed: false,
      fingerprint: null,
      failedAttempts: 1,
    })
    expect(await memoCount(seeded.conversationId)).toBe(0)
  })

  test("the next batch retries a failed item and captures it", async () => {
    const seeded = await seedQueuedConversation()

    await serviceWith({ classify: fail }).processBatch(testWorkspaceId, seeded.streamId)
    await serviceWith({}).processBatch(testWorkspaceId, seeded.streamId)

    expect(await pendingState(seeded.conversationId)).toEqual({
      processed: true,
      fingerprint: expect.any(String),
      failedAttempts: 1,
    })
    expect(await memoCount(seeded.conversationId)).toBe(1)
  })

  test(`gives up after ${MEMO_MAX_FAILED_ATTEMPTS} failed attempts`, async () => {
    const seeded = await seedQueuedConversation()
    const failing = serviceWith({ classify: fail })

    for (let attempt = 0; attempt < MEMO_MAX_FAILED_ATTEMPTS; attempt++) {
      await failing.processBatch(testWorkspaceId, seeded.streamId)
    }

    expect(await pendingState(seeded.conversationId)).toEqual({
      processed: true,
      fingerprint: null,
      failedAttempts: MEMO_MAX_FAILED_ATTEMPTS,
    })
  })

  test("a requeue after giving up starts a fresh attempt budget", async () => {
    const seeded = await seedQueuedConversation()
    const failing = serviceWith({ classify: fail })
    for (let attempt = 0; attempt < MEMO_MAX_FAILED_ATTEMPTS; attempt++) {
      await failing.processBatch(testWorkspaceId, seeded.streamId)
    }

    await withTransaction(pool, (client) => requeue(client, seeded))
    await failing.processBatch(testWorkspaceId, seeded.streamId)

    expect(await pendingState(seeded.conversationId)).toEqual({
      processed: false,
      fingerprint: null,
      failedAttempts: 1,
    })
  })

  test("a reply that requeues the conversation mid-batch keeps it pending for the next batch", async () => {
    const seeded = await seedQueuedConversation()
    let reply = ""
    const classified: string[][] = []
    const classify = async (conversation: { messageIds: string[] }) => {
      classified.push(conversation.messageIds)
      reply ||= await replyMidFlight(seeded)
      return worthy
    }

    await serviceWith({ classify }).processBatch(testWorkspaceId, seeded.streamId)
    expect(await pendingState(seeded.conversationId)).toMatchObject({ processed: false })

    await serviceWith({ classify }).processBatch(testWorkspaceId, seeded.streamId)
    expect(await pendingState(seeded.conversationId)).toMatchObject({ processed: true })
    expect(classified.map((ids) => ids.includes(reply))).toEqual([false, true])
  })

  test("a failure in a batch the conversation was requeued during does not count against it", async () => {
    const seeded = await seedQueuedConversation()

    await serviceWith({
      classify: async () => {
        await replyMidFlight(seeded)
        throw new Error("provider unavailable")
      },
    }).processBatch(testWorkspaceId, seeded.streamId)

    expect(await pendingState(seeded.conversationId)).toEqual({
      processed: false,
      fingerprint: null,
      failedAttempts: 0,
    })
  })

  test("a batch started while another runs on the same stream makes no model call", async () => {
    const seeded = await seedQueuedConversation()
    let classifyCalls = 0
    let firstEntered!: () => void
    const entered = new Promise<void>((resolve) => (firstEntered = resolve))
    let releaseFirst!: () => void
    const held = new Promise<void>((resolve) => (releaseFirst = resolve))
    const service = serviceWith({
      classify: async () => {
        if (++classifyCalls === 1) {
          firstEntered()
          await held
        }
        throw new Error("provider unavailable")
      },
    })

    const first = service.processBatch(testWorkspaceId, seeded.streamId)
    await entered
    await service.processBatch(testWorkspaceId, seeded.streamId)
    releaseFirst()
    await first

    expect({ classifyCalls, ...(await pendingState(seeded.conversationId)) }).toEqual({
      classifyCalls: 1,
      processed: false,
      fingerprint: null,
      failedAttempts: 1,
    })
  })

  test("a batch whose claim lapsed and was taken over saves nothing", async () => {
    const seeded = await seedQueuedConversation()
    let classifyCalls = 0
    const slow = serviceWith({
      classify: async () => {
        if (++classifyCalls === 1) {
          await pool.query(`UPDATE memo_stream_state SET batch_claim_expires_at = NOW() WHERE stream_id = $1`, [
            seeded.streamId,
          ])
          await serviceWith({}).processBatch(testWorkspaceId, seeded.streamId)
        }
        return worthy
      },
    })

    const result = await slow.processBatch(testWorkspaceId, seeded.streamId)

    expect({ result, memos: await memoCount(seeded.conversationId) }).toEqual({
      result: { processed: 0, memosCreated: 0 },
      memos: 1,
    })
  })

  test("a batch renews its claim between conversations, so a lapsed lease is not taken over", async () => {
    const first = await seedQueuedConversation()
    const second = { streamId: first.streamId, conversationId: conversationId() }
    await withTransaction(pool, async (client) => {
      await ConversationRepository.insert(client, {
        id: second.conversationId,
        streamId: second.streamId,
        workspaceId: testWorkspaceId,
        status: ConversationStatuses.RESOLVED,
      })
      for (const sequence of [3n, 4n]) {
        await addMessage(client, second, sequence)
      }
      await requeue(client, second)
    })
    let classifyCalls = 0
    let takeover: unknown
    const slow = serviceWith({
      classify: async () => {
        classifyCalls++
        if (classifyCalls === 1) {
          await pool.query(`UPDATE memo_stream_state SET batch_claim_expires_at = NOW() WHERE stream_id = $1`, [
            first.streamId,
          ])
        } else {
          takeover = await serviceWith({}).processBatch(testWorkspaceId, first.streamId)
        }
        return worthy
      },
    })

    const result = await slow.processBatch(testWorkspaceId, first.streamId)

    expect({
      result,
      takeover,
      memos: [await memoCount(first.conversationId), await memoCount(second.conversationId)],
    }).toEqual({
      result: { processed: 2, memosCreated: 2 },
      takeover: { processed: 0, memosCreated: 0 },
      memos: [1, 1],
    })
  })

  test("a stream switched off after its conversations were queued drops them without a model call", async () => {
    const seeded = await seedQueuedConversation()
    await switchMemoryOff(seeded)
    let classifyCalls = 0

    await serviceWith({
      classify: async () => {
        classifyCalls++
        return worthy
      },
    }).processBatch(testWorkspaceId, seeded.streamId)

    expect({ classifyCalls, ...(await pendingState(seeded.conversationId)) }).toEqual({
      classifyCalls: 0,
      processed: true,
      fingerprint: null,
      failedAttempts: 0,
    })
  })

  test("switching memory off while the model calls run saves no memos", async () => {
    const seeded = await seedQueuedConversation()

    await serviceWith({
      classify: async () => {
        await switchMemoryOff(seeded)
        return worthy
      },
    }).processBatch(testWorkspaceId, seeded.streamId)

    expect(await memoCount(seeded.conversationId)).toBe(0)
    expect(await pendingState(seeded.conversationId)).toMatchObject({ processed: true })
  })

  test("switching memory off while a reflective capture's model calls run saves no memos", async () => {
    const seeded = await seedQueuedConversation()
    const anchorMessageId = await withTransaction(pool, (client) => addMessage(client, seeded, 3n))
    const sessionId = `session_${messageId()}`

    const result = await serviceWith({
      classify: async () => {
        await switchMemoryOff(seeded)
        return worthy
      },
    }).captureSessionReflection({
      workspaceId: testWorkspaceId,
      streamId: seeded.streamId,
      sessionId,
      digest: "Trigger: where do we start? Replied: with the auth service.",
      anchorMessageId,
      participantIds: [testUserId],
      citedStreamIds: [],
      citedMessageIds: [],
      requiresBrowse: false,
    })

    const { rows } = await pool.query(`SELECT id FROM memos WHERE source_session_id = $1`, [sessionId])
    expect({ captured: result.captured, memos: rows.length }).toEqual({ captured: 0, memos: 0 })
  })

  test("switching memory off cannot commit while a save that passed the memory gate is writing", async () => {
    const seeded = await seedQueuedConversation()
    const findNearDuplicate = MemoRepository.findNearDuplicate
    let switchError: { code?: string } | undefined
    const spy = spyOn(MemoRepository, "findNearDuplicate").mockImplementation(async (...args) => {
      const client = await pool.connect()
      try {
        await client.query("SET lock_timeout = '200ms'")
        await StreamRepository.update(client, testWorkspaceId, seeded.streamId, { memoryMode: MemoryModes.OFF })
      } catch (error) {
        switchError = error as { code?: string }
      } finally {
        await client.query("RESET lock_timeout")
        client.release()
      }
      return findNearDuplicate(...args)
    })

    try {
      await serviceWith({}).processBatch(testWorkspaceId, seeded.streamId)
    } finally {
      spy.mockRestore()
    }

    expect({ switchError: switchError?.code, memos: await memoCount(seeded.conversationId) }).toEqual({
      switchError: "55P03",
      memos: 1,
    })
  })
})
