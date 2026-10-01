import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { ConversationStatuses } from "@threahq/types"
import { ConversationRepository } from "../../src/features/conversations"
import { MemoRepository, MemoService, PendingItemRepository } from "../../src/features/memos"
import type { ConversationClassification } from "../../src/features/memos/classifier"
import { MEMO_MAX_FAILED_ATTEMPTS } from "../../src/features/memos/config"
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

describe("memo batch: failed items", () => {
  let pool: Pool
  let testWorkspaceId: string
  let testUserId: string

  function serviceWith(overrides: {
    classify?: () => Promise<ConversationClassification>
    embed?: () => Promise<number[][]>
  }): MemoService {
    return new MemoService({
      pool,
      classifier: { classifyConversation: overrides.classify ?? (async () => worthy) },
      memorizer: {
        memorizeConversation: async (_formatted: string, context: { content: { id: string }[] }) => [
          {
            title: "Start with auth",
            abstract: "The migration starts with the auth service.",
            keyPoints: [],
            sourceMessageIds: context.content.map((m) => m.id),
            knowledgeType: "decision",
            tags: [],
          },
        ],
      } as never,
      embeddingService: { embedBatch: overrides.embed ?? (async () => [nextEmbedding()]) } as never,
      messageFormatter: { formatMessages: async () => "formatted transcript" } as never,
    })
  }

  /** A settled two-message conversation in its own stream, queued for capture. */
  async function seedQueuedConversation() {
    const ids = { streamId: streamId(), conversationId: conversationId(), pendingId: pendingItemId() }
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
        const id = messageId()
        await MessageRepository.insert(client, {
          id,
          streamId: ids.streamId,
          sequence,
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("we start the migration with the auth service"),
        })
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, ids.conversationId, id, testUserId)
      }
      await PendingItemRepository.queue(client, [
        {
          id: ids.pendingId,
          workspaceId: testWorkspaceId,
          streamId: ids.streamId,
          itemType: "conversation",
          itemId: ids.conversationId,
        },
      ])
    })
    return ids
  }

  async function pendingState(pendingId: string) {
    const { rows } = await pool.query(`SELECT * FROM memo_pending_items WHERE id = $1`, [pendingId])
    return {
      processed: rows[0].processed_at !== null,
      fingerprint: rows[0].classified_fingerprint,
      failedAttempts: rows[0].failed_attempts,
    }
  }

  async function memoCount(convId: string): Promise<number> {
    return (await MemoRepository.findActiveBySourceConversation(pool, convId)).length
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testWorkspaceId = workspaceId()
    const workosUserId = userId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Memo Batch Failures",
        slug: `memo-batch-failures-${testWorkspaceId}`,
        createdBy: workosUserId,
      })
      testUserId = (await addTestMember(client, testWorkspaceId, workosUserId)).id
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("a classifier failure leaves the item pending with no fingerprint", async () => {
    const seeded = await seedQueuedConversation()

    await serviceWith({ classify: fail }).processBatch(testWorkspaceId, seeded.streamId)

    expect(await pendingState(seeded.pendingId)).toEqual({ processed: false, fingerprint: null, failedAttempts: 1 })
  })

  test("an embedding failure after classification leaves the item pending with no fingerprint", async () => {
    const seeded = await seedQueuedConversation()

    await serviceWith({ embed: fail }).processBatch(testWorkspaceId, seeded.streamId)

    expect(await pendingState(seeded.pendingId)).toEqual({ processed: false, fingerprint: null, failedAttempts: 1 })
    expect(await memoCount(seeded.conversationId)).toBe(0)
  })

  test("the next batch retries a failed item and captures it", async () => {
    const seeded = await seedQueuedConversation()

    await serviceWith({ classify: fail }).processBatch(testWorkspaceId, seeded.streamId)
    await serviceWith({}).processBatch(testWorkspaceId, seeded.streamId)

    expect(await pendingState(seeded.pendingId)).toEqual({
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

    expect(await pendingState(seeded.pendingId)).toEqual({
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

    await withTransaction(pool, (client) =>
      PendingItemRepository.queue(client, [
        {
          id: pendingItemId(),
          workspaceId: testWorkspaceId,
          streamId: seeded.streamId,
          itemType: "conversation",
          itemId: seeded.conversationId,
        },
      ])
    )
    await failing.processBatch(testWorkspaceId, seeded.streamId)

    expect(await pendingState(seeded.pendingId)).toEqual({ processed: false, fingerprint: null, failedAttempts: 1 })
  })
})
