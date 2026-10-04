import { DisabledAnalyticsReporter } from "@threahq/backend-common"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { ConversationStatuses } from "@threahq/types"
import { ConversationRepository } from "../../src/features/conversations"
import { MemoRepository, MemoService, PendingItemRepository } from "../../src/features/memos"
import type { ConversationClassification } from "../../src/features/memos/classifier"
import { MessageRepository } from "../../src/features/messaging"
import { StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { conversationId, memoId, messageId, pendingItemId, streamId, userId, workspaceId } from "../../src/lib/id"
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

describe("memo capture: a cited memo is retired only by knowledge at least as new", () => {
  let pool: Pool
  let nextSequence = 1n

  /**
   * A service whose memorizer reverses `target` in every conversation it sees,
   * running `duringInference` before it answers.
   */
  function reversing(target: string, duringInference: () => Promise<void> = async () => {}): MemoService {
    return new MemoService({
      analyticsReporter: new DisabledAnalyticsReporter(),
      pool,
      classifier: { classifyConversation: async () => worthy },
      memorizer: {
        memorizeConversation: async (_formatted: string, context: { content: { id: string }[] }) => {
          await duringInference()
          return [
            {
              title: "Price is $12",
              abstract: "The plan costs $12 a month.",
              keyPoints: [],
              sourceMessageIds: context.content.map((m) => m.id),
              knowledgeType: "decision",
              tags: [],
              supersedesMemoIds: [target],
            },
          ]
        },
      } as never,
      embeddingService: { embedBatch: async (texts: string[]) => texts.map(() => nextEmbedding()) } as never,
      messageFormatter: { formatMessages: async () => "formatted transcript" } as never,
    })
  }

  async function seedChannel(): Promise<{ ws: string; author: string; channel: string }> {
    const ws = workspaceId()
    const channel = streamId()
    return withTransaction(pool, async (client) => {
      const workosUserId = userId()
      await WorkspaceRepository.insert(client, {
        id: ws,
        name: "Memo Explicit Supersede",
        slug: `memo-explicit-supersede-${ws}`,
        createdBy: workosUserId,
      })
      const author = (await addTestMember(client, ws, workosUserId)).id
      await StreamRepository.insert(client, {
        id: channel,
        workspaceId: ws,
        type: "channel",
        visibility: "public",
        createdBy: author,
      })
      return { ws, author, channel }
    })
  }

  async function seedMessage(author: string, channel: string): Promise<string> {
    const id = messageId()
    await MessageRepository.insert(pool, {
      id,
      streamId: channel,
      sequence: nextSequence++,
      authorId: author,
      authorType: "user",
      ...testMessageContent("the plan costs money"),
    })
    return id
  }

  /** An active memo whose only source is a message posted now. */
  async function seedMemo(ws: string, author: string, channel: string): Promise<string> {
    const id = memoId()
    const source = await seedMessage(author, channel)
    await MemoRepository.insert(pool, {
      id,
      workspaceId: ws,
      memoType: "message",
      sourceMessageId: source,
      title: "Price is $9",
      abstract: "The plan costs $9 a month.",
      sourceMessageIds: [source],
      participantIds: [],
      knowledgeType: "decision",
      tags: [],
    })
    return id
  }

  /** A settled conversation whose messages are posted now, queued for capture. */
  async function queueConversation(ws: string, author: string, channel: string): Promise<void> {
    const id = conversationId()
    const messages = [await seedMessage(author, channel), await seedMessage(author, channel)]
    await withTransaction(pool, async (client) => {
      await ConversationRepository.insert(client, {
        id,
        streamId: channel,
        workspaceId: ws,
        status: ConversationStatuses.RESOLVED,
      })
      for (const message of messages) {
        await ConversationRepository.addPrimaryMessage(client, ws, id, message, author)
      }
      await PendingItemRepository.queue(client, [
        { id: pendingItemId(), workspaceId: ws, streamId: channel, itemType: "conversation", itemId: id },
      ])
    })
  }

  async function memoStatuses(ws: string): Promise<Record<string, string>> {
    const result = await pool.query<{ title: string; status: string }>(
      "SELECT title, status FROM memos WHERE workspace_id = $1",
      [ws]
    )
    return Object.fromEntries(result.rows.map((row) => [row.title, row.status]))
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("an older conversation captured late keeps the newer memo it contradicts", async () => {
    const { ws, author, channel } = await seedChannel()
    await queueConversation(ws, author, channel)
    const newer = await seedMemo(ws, author, channel)

    await reversing(newer).processBatch(ws, channel)

    expect(await memoStatuses(ws)).toEqual({ "Price is $9": "active", "Price is $12": "active" })
  })

  test("a newer conversation retires the older memo it reverses", async () => {
    const { ws, author, channel } = await seedChannel()
    const older = await seedMemo(ws, author, channel)
    await queueConversation(ws, author, channel)

    await reversing(older).processBatch(ws, channel)

    expect(await memoStatuses(ws)).toEqual({ "Price is $9": "superseded", "Price is $12": "active" })
  })
  test("a memo edited while the model ran survives, and the conversation re-runs against the edit", async () => {
    const { ws, author, channel } = await seedChannel()
    const older = await seedMemo(ws, author, channel)
    await queueConversation(ws, author, channel)

    await reversing(older, async () => {
      await MemoRepository.update(pool, ws, older, { title: "Price is $9, edited" })
    }).processBatch(ws, channel)

    expect(await memoStatuses(ws)).toEqual({ "Price is $9, edited": "active" })

    await reversing(older).processBatch(ws, channel)

    expect(await memoStatuses(ws)).toEqual({ "Price is $9, edited": "superseded", "Price is $12": "active" })
  })
})
