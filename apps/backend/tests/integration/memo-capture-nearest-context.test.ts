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

describe("memo capture: the memorizer is shown older stream memos near the conversation", () => {
  let pool: Pool
  let nextSequence = 1n

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("a conversation revising a memo older than the newest twenty retires it, without seeing another member's private memo", async () => {
    const ws = workspaceId()
    const channel = streamId()
    const { author, other } = await withTransaction(pool, async (client) => {
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
      return { author, other }
    })

    async function seedMessage(): Promise<string> {
      const id = messageId()
      await MessageRepository.insert(pool, {
        id,
        workspaceId: ws,
        streamId: channel,
        sequence: nextSequence++,
        authorId: author,
        authorType: "user",
        ...testMessageContent("the plan costs money"),
      })
      return id
    }

    async function seedMemo(title: string, embedding: number[], owner?: string): Promise<string> {
      const id = memoId()
      const source = await seedMessage()
      await MemoRepository.insert(pool, {
        id,
        workspaceId: ws,
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
      await MemoRepository.updateEmbedding(pool, ws, id, embedding)
      return id
    }

    const price = await seedMemo("Price is $9", axis(TOPIC_AXIS))
    await seedMemo("Their price note", axis(TOPIC_AXIS), other)
    for (let i = 1; i <= 20; i++) await seedMemo(`Unrelated ${i}`, axis(i))

    const conversation = conversationId()
    const messages = [await seedMessage(), await seedMessage()]
    await withTransaction(pool, async (client) => {
      await ConversationRepository.insert(client, {
        id: conversation,
        streamId: channel,
        workspaceId: ws,
        status: ConversationStatuses.RESOLVED,
      })
      for (const message of messages) {
        await ConversationRepository.addPrimaryMessage(client, ws, conversation, message, author)
      }
      await PendingItemRepository.queue(client, [
        { id: pendingItemId(), workspaceId: ws, streamId: channel, itemType: "conversation", itemId: conversation },
      ])
    })

    let shown: string[] = []
    let nextAxis = 100
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
          return [
            {
              title: "Price is $12",
              abstract: "The plan costs $12 a month.",
              keyPoints: [],
              sourceMessageIds: context.content.map((m) => m.id),
              knowledgeType: "decision",
              tags: [],
              supersedesMemoIds: context.memoryContext.some((m) => m.id === price) ? [price] : [],
            },
          ]
        },
      } as never,
      embeddingService: {
        embedBatch: async (texts: string[], opts: { functionId: string }) =>
          texts.map(() => (opts.functionId === "memo-context-embedding" ? axis(TOPIC_AXIS) : axis(nextAxis++))),
      } as never,
      messageFormatter: { formatMessages: async () => "formatted transcript" } as never,
    }).processBatch(ws, channel)

    const statuses = await pool.query<{ title: string; status: string }>(
      "SELECT title, status FROM memos WHERE workspace_id = $1 AND title LIKE '%rice%'",
      [ws]
    )
    expect({
      shownPrice: shown.includes("Price is $9"),
      shownPrivate: shown.includes("Their price note"),
      statuses: Object.fromEntries(statuses.rows.map((row) => [row.title, row.status])),
    }).toEqual({
      shownPrice: true,
      shownPrivate: false,
      statuses: { "Price is $9": "superseded", "Their price note": "active", "Price is $12": "active" },
    })
  })
})
