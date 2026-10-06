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

function axis(index: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => (i === index ? 1 : 0))
}

const TOPIC_AXIS = 0

interface Channel {
  ws: string
  channel: string
  author: string
  other: string
}

describe("memo capture: the memorizer is shown older stream memos near the conversation", () => {
  let pool: Pool
  let nextSequence = 1n
  let nextAxis = 100

  async function seedChannel(): Promise<Channel> {
    const ws = workspaceId()
    const channel = streamId()
    return withTransaction(pool, async (client) => {
      const workosUserId = userId()
      await WorkspaceRepository.insert(client, {
        id: ws,
        name: "Memo Nearest Context",
        slug: `memo-nearest-context-${ws}`,
        createdBy: workosUserId,
      })
      const author = (await addTestMember(client, ws, workosUserId)).id
      const other = (await addTestMember(client, ws, userId())).id
      await StreamRepository.insert(client, {
        id: channel,
        workspaceId: ws,
        type: "channel",
        visibility: "public",
        createdBy: author,
      })
      return { ws, channel, author, other }
    })
  }

  async function seedMessage(c: Channel): Promise<string> {
    const id = messageId()
    await MessageRepository.insert(pool, {
      id,
      workspaceId: c.ws,
      streamId: c.channel,
      sequence: nextSequence++,
      authorId: c.author,
      authorType: "user",
      ...testMessageContent("the plan costs money"),
    })
    return id
  }

  async function seedMemo(c: Channel, title: string, embedding: number[], owner?: string): Promise<string> {
    const id = memoId()
    const source = await seedMessage(c)
    await MemoRepository.insert(pool, {
      id,
      workspaceId: c.ws,
      memoType: "message",
      sourceMessageId: source,
      title,
      abstract: title,
      sourceMessageIds: [source],
      participantIds: [],
      knowledgeType: "decision",
      tags: [],
      ...(owner ? { scope: "user", scopeUserId: owner } : {}),
    })
    await MemoRepository.updateEmbedding(pool, c.ws, id, embedding)
    return id
  }

  /** The topic memo, buried under twenty newer unrelated ones. */
  async function seedBuriedPrice(c: Channel): Promise<string> {
    const price = await seedMemo(c, "Price is $9", axis(TOPIC_AXIS))
    for (let i = 1; i <= 20; i++) await seedMemo(c, `Unrelated ${i}`, axis(i))
    return price
  }

  async function queueConversation(c: Channel): Promise<void> {
    const id = conversationId()
    const messages = [await seedMessage(c), await seedMessage(c)]
    await withTransaction(pool, async (client) => {
      await ConversationRepository.insert(client, {
        id,
        streamId: c.channel,
        workspaceId: c.ws,
        status: ConversationStatuses.RESOLVED,
      })
      for (const message of messages) {
        await ConversationRepository.addPrimaryMessage(client, c.ws, id, message, c.author)
      }
      await PendingItemRepository.queue(client, [
        { id: pendingItemId(), workspaceId: c.ws, streamId: c.channel, itemType: "conversation", itemId: id },
      ])
    })
  }

  /** Captures "Price is $12", superseding `target` whenever it was shown. */
  async function capture(
    c: Channel,
    target: string,
    duringInference: () => Promise<void> = async () => {}
  ): Promise<string[]> {
    let shown: string[] = []
    await new MemoService({
      analyticsReporter: new DisabledAnalyticsReporter(),
      pool,
      classifier: { classifyConversation: async () => worthy },
      memorizer: {
        memorizeConversation: async (
          _formatted: string,
          context: { memoryContext: { id: string; title: string }[]; content: { id: string }[] }
        ) => {
          shown = context.memoryContext.map((m) => m.title)
          await duringInference()
          return [
            {
              title: "Price is $12",
              abstract: "The plan costs $12 a month.",
              keyPoints: [],
              sourceMessageIds: context.content.map((m) => m.id),
              knowledgeType: "decision",
              tags: [],
              supersedesMemoIds: context.memoryContext.some((m) => m.id === target) ? [target] : [],
            },
          ]
        },
      } as never,
      embeddingService: {
        embedBatch: async (texts: string[], opts: { functionId: string }) =>
          texts.map(() => (opts.functionId === "memo-context-embedding" ? axis(TOPIC_AXIS) : axis(nextAxis++))),
      } as never,
      messageFormatter: { formatMessages: async () => "formatted transcript" } as never,
    }).processBatch(c.ws, c.channel)
    return shown
  }

  async function priceStatuses(c: Channel): Promise<Record<string, string>> {
    const result = await pool.query<{ title: string; status: string }>(
      "SELECT title, status FROM memos WHERE workspace_id = $1 AND title NOT LIKE 'Unrelated%'",
      [c.ws]
    )
    return Object.fromEntries(result.rows.map((row) => [row.title, row.status]))
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("a conversation revising a memo older than the newest twenty retires it, without seeing another member's private memo", async () => {
    const c = await seedChannel()
    const price = await seedBuriedPrice(c)
    await seedMemo(c, "Their price note", axis(TOPIC_AXIS), c.other)
    await queueConversation(c)

    const shown = await capture(c, price)

    expect({
      shownPrice: shown.includes("Price is $9"),
      shownPrivate: shown.includes("Their price note"),
      statuses: await priceStatuses(c),
    }).toEqual({
      shownPrice: true,
      shownPrivate: false,
      statuses: { "Price is $9": "superseded", "Their price note": "active", "Price is $12": "active" },
    })
  })

  test("a nearest memo edited while the model ran survives, and the conversation re-runs against the edit", async () => {
    const c = await seedChannel()
    const price = await seedBuriedPrice(c)
    await queueConversation(c)

    await capture(c, price, async () => {
      await MemoRepository.update(pool, c.ws, price, { title: "Price is $9, edited" })
    })
    const afterEdit = await priceStatuses(c)
    await capture(c, price)

    expect({ afterEdit, afterRerun: await priceStatuses(c) }).toEqual({
      afterEdit: { "Price is $9, edited": "active" },
      afterRerun: { "Price is $9, edited": "superseded", "Price is $12": "active" },
    })
  })
})
