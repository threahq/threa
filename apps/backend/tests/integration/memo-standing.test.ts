import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { DisabledAnalyticsReporter } from "@threahq/backend-common"
import { ConversationStatuses, StreamTypes, Visibilities, type MemoStanding } from "@threahq/types"
import { ConversationRepository } from "../../src/features/conversations"
import { MemoRepository, MemoService, PendingItemRepository } from "../../src/features/memos"
import type { ConversationClassification } from "../../src/features/memos/classifier"
import { MessageRepository } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { conversationId, memoId, messageId, pendingItemId, streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupTestDatabase, testMessageContent, withTransaction } from "./setup"

function axis(index: number): number[] {
  const vector = new Array(1536).fill(0)
  vector[index] = 1
  return vector
}

const worthy: ConversationClassification = {
  isKnowledgeWorthy: true,
  shouldReviseExisting: true,
  revisionReason: null,
  confidence: 0.9,
  containsActionItems: false,
}

/** A unit vector at cosine distance `distance` from `axis(index)`. */
function near(index: number, distance: number): number[] {
  const weight = 1 - distance
  const vector = new Array(1536).fill(0)
  vector[index] = weight
  vector[index + 1] = Math.sqrt(1 - weight ** 2)
  return vector
}

describe("memo standing", () => {
  let pool: Pool
  let testWorkspaceId: string
  let channelId: string
  let ownerId: string

  async function insertMemo(standing?: MemoStanding) {
    const id = memoId()
    await MemoRepository.insert(pool, {
      id,
      workspaceId: testWorkspaceId,
      memoType: "message",
      sourceMessageId: messageId(),
      title: "Standing memo",
      abstract: "Standing memo abstract",
      sourceMessageIds: [],
      participantIds: [ownerId],
      knowledgeType: "decision",
      ...(standing ? { standing } : {}),
    })
    return MemoRepository.findById(pool, testWorkspaceId, id)
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testWorkspaceId = workspaceId()
    channelId = streamId()
    const workosUserId = userId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Memo Standing",
        slug: `memo-standing-${testWorkspaceId}`,
        createdBy: workosUserId,
      })
      ownerId = (await addTestMember(client, testWorkspaceId, workosUserId)).id
      await StreamRepository.insert(client, {
        id: channelId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PRIVATE,
        slug: `memo-standing-${channelId}`,
        createdBy: ownerId,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, channelId, ownerId)
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("insert without a standing reads back decided", async () => {
    const memo = await insertMemo()

    expect({ standing: memo?.standing }).toEqual({ standing: "decided" })
  })

  test("insert with a proposed standing reads back proposed", async () => {
    const memo = await insertMemo("proposed")

    expect({ standing: memo?.standing }).toEqual({ standing: "proposed" })
  })

  test("upsertCopies stores the host's standing", async () => {
    const id = memoId()
    await MemoRepository.upsertCopies(pool, testWorkspaceId, workspaceId(), channelId, [
      {
        id,
        conversationId: conversationId(),
        title: "Shared copy",
        abstract: "Copied across the bridge.",
        keyPoints: [],
        sourceMessageIds: [],
        participantIds: [],
        knowledgeType: "decision",
        standing: "proposed",
        tags: [],
        version: 1,
        cardVersion: 1,
        embedding: axis(0),
        createdAt: "2026-06-01T00:00:00.000Z",
        earliestSourceAt: null,
        latestSourceAt: null,
      },
    ])
    const copy = await MemoRepository.findById(pool, testWorkspaceId, id)

    expect({ standing: copy?.standing }).toEqual({ standing: "proposed" })
  })
})

describe("memo standing: save rules", () => {
  let pool: Pool
  let nextSequence = 1n
  let nextAxis = 100

  type Captured = { title: string; standing: MemoStanding; supersedes?: string[]; embedding: number[] }

  function capturing(captures: Captured[]): MemoService {
    const memorize = async (_formatted: string, context: { content: { id: string }[] }) =>
      captures.map((capture) => ({
        title: capture.title,
        abstract: capture.title,
        keyPoints: [],
        sourceMessageIds: context.content.map((m) => m.id),
        knowledgeType: "decision",
        tags: [],
        supersedesMemoIds: capture.supersedes ?? [],
        standing: capture.standing,
      }))
    return new MemoService({
      analyticsReporter: new DisabledAnalyticsReporter(),
      pool,
      classifier: { classifyConversation: async () => worthy },
      memorizer: { memorizeConversation: memorize, reviseMemo: memorize } as never,
      embeddingService: {
        embedBatch: async (texts: string[]) =>
          texts.map((text) => captures.find((capture) => capture.title === text)!.embedding),
      } as never,
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
        name: "Memo Standing Rules",
        slug: `memo-standing-rules-${ws}`,
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

  async function seedMessage(ws: string, author: string, channel: string): Promise<string> {
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

  async function seedMemo(
    ws: string,
    author: string,
    channel: string,
    seed: { title: string; standing: MemoStanding; axisIndex?: number; conversationId?: string }
  ): Promise<string> {
    const id = memoId()
    const source = await seedMessage(ws, author, channel)
    await MemoRepository.insert(pool, {
      id,
      workspaceId: ws,
      ...(seed.conversationId
        ? { memoType: "conversation" as const, sourceConversationId: seed.conversationId }
        : { memoType: "message" as const, sourceMessageId: source }),
      title: seed.title,
      abstract: seed.title,
      sourceMessageIds: [source],
      participantIds: [],
      knowledgeType: "decision",
      standing: seed.standing,
      tags: [],
    })
    if (seed.axisIndex !== undefined) await MemoRepository.updateEmbedding(pool, ws, id, axis(seed.axisIndex))
    return id
  }

  async function queueConversation(ws: string, author: string, channel: string): Promise<string> {
    const id = conversationId()
    const messages = [await seedMessage(ws, author, channel), await seedMessage(ws, author, channel)]
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
    return id
  }

  async function memosByTitle(ws: string) {
    const result = await pool.query<{
      id: string
      title: string
      standing: string
      status: string
      parent_memo_id: string | null
      superseded_by_memo_id: string | null
    }>("SELECT id, title, standing, status, parent_memo_id, superseded_by_memo_id FROM memos WHERE workspace_id = $1", [
      ws,
    ])
    return Object.fromEntries(result.rows.map((row) => [row.title, row]))
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("a proposed memo citing a decided memo retires nothing", async () => {
    const { ws, author, channel } = await seedChannel()
    const decided = await seedMemo(ws, author, channel, { title: "Price is $9", standing: "decided" })
    await queueConversation(ws, author, channel)

    await capturing([
      { title: "Price could be $12", standing: "proposed", supersedes: [decided], embedding: axis(nextAxis++) },
    ]).processBatch(ws, channel)

    const memos = await memosByTitle(ws)
    expect({
      decided: memos["Price is $9"].status,
      proposed: {
        status: memos["Price could be $12"].status,
        standing: memos["Price could be $12"].standing,
        parent: memos["Price could be $12"].parent_memo_id,
      },
    }).toEqual({ decided: "active", proposed: { status: "active", standing: "proposed", parent: null } })
  })

  test("a proposed memo near a decided memo of its conversation does not supersede it", async () => {
    const { ws, author, channel } = await seedChannel()
    const conversation = await queueConversation(ws, author, channel)
    const index = nextAxis++
    nextAxis++
    await seedMemo(ws, author, channel, {
      title: "Price is $9",
      standing: "decided",
      axisIndex: index,
      conversationId: conversation,
    })

    await capturing([{ title: "Price could be $12", standing: "proposed", embedding: near(index, 0.2) }]).processBatch(
      ws,
      channel
    )

    const memos = await memosByTitle(ws)
    expect({ decided: memos["Price is $9"].status, proposed: memos["Price could be $12"].status }).toEqual({
      decided: "active",
      proposed: "active",
    })
  })

  test("a decided memo citing a proposed memo retires it", async () => {
    const { ws, author, channel } = await seedChannel()
    const proposed = await seedMemo(ws, author, channel, { title: "Price could be $9", standing: "proposed" })
    await queueConversation(ws, author, channel)

    await capturing([
      { title: "Price is $12", standing: "decided", supersedes: [proposed], embedding: axis(nextAxis++) },
    ]).processBatch(ws, channel)

    const memos = await memosByTitle(ws)
    expect(memos["Price could be $9"]).toMatchObject({
      status: "superseded",
      superseded_by_memo_id: memos["Price is $12"].id,
    })
  })

  test("a decided memo near-duplicating an uncited proposed memo is inserted", async () => {
    const { ws, author, channel } = await seedChannel()
    const index = nextAxis++
    nextAxis++
    await seedMemo(ws, author, channel, { title: "Price could be $12", standing: "proposed", axisIndex: index })
    await queueConversation(ws, author, channel)

    await capturing([{ title: "Price is $12", standing: "decided", embedding: near(index, 0.05) }]).processBatch(
      ws,
      channel
    )

    const memos = await memosByTitle(ws)
    expect({ proposed: memos["Price could be $12"].status, decided: memos["Price is $12"]?.status }).toEqual({
      proposed: "active",
      decided: "active",
    })
  })

  test("a decided memo inside the supersede distance of an uncited proposed memo from the same conversation retires nothing", async () => {
    const { ws, author, channel } = await seedChannel()
    const conversation = await queueConversation(ws, author, channel)
    const index = nextAxis++
    nextAxis++
    await seedMemo(ws, author, channel, {
      title: "Price could be $12",
      standing: "proposed",
      axisIndex: index,
      conversationId: conversation,
    })

    await capturing([{ title: "Price is $12", standing: "decided", embedding: near(index, 0.2) }]).processBatch(
      ws,
      channel
    )

    const memos = await memosByTitle(ws)
    expect({
      proposed: {
        status: memos["Price could be $12"].status,
        supersededBy: memos["Price could be $12"].superseded_by_memo_id,
      },
      decided: memos["Price is $12"]?.status,
    }).toEqual({ proposed: { status: "active", supersededBy: null }, decided: "active" })
  })

  test("a proposed memo that is an embedding near-duplicate of a decided memo from another conversation is inserted", async () => {
    const { ws, author, channel } = await seedChannel()
    const index = nextAxis++
    nextAxis++
    await seedMemo(ws, author, channel, { title: "Price is $12", standing: "decided", axisIndex: index })
    await queueConversation(ws, author, channel)

    await capturing([
      { title: "Price could be $12 yearly", standing: "proposed", embedding: near(index, 0.05) },
    ]).processBatch(ws, channel)

    const memos = await memosByTitle(ws)
    expect({
      decided: memos["Price is $12"].status,
      proposed: memos["Price could be $12 yearly"]?.status,
    }).toEqual({ decided: "active", proposed: "active" })
  })

  test("a proposed memo near-duplicating a proposed memo of another conversation is dropped", async () => {
    const { ws, author, channel } = await seedChannel()
    const index = nextAxis++
    nextAxis++
    await seedMemo(ws, author, channel, { title: "Price could be $12", standing: "proposed", axisIndex: index })
    await queueConversation(ws, author, channel)

    await capturing([
      { title: "Price might become $12", standing: "proposed", embedding: near(index, 0.05) },
    ]).processBatch(ws, channel)

    expect(Object.keys(await memosByTitle(ws))).toEqual(["Price could be $12"])
  })

  test("a proposed memo restating a proposed memo of its conversation supersedes it", async () => {
    const { ws, author, channel } = await seedChannel()
    const conversation = await queueConversation(ws, author, channel)
    const index = nextAxis++
    nextAxis++
    await seedMemo(ws, author, channel, {
      title: "Price could be $12",
      standing: "proposed",
      axisIndex: index,
      conversationId: conversation,
    })

    await capturing([
      { title: "Price could be $12 yearly", standing: "proposed", embedding: near(index, 0.2) },
    ]).processBatch(ws, channel)

    const memos = await memosByTitle(ws)
    expect({
      older: memos["Price could be $12"].status,
      newer: memos["Price could be $12 yearly"].status,
    }).toEqual({ older: "superseded", newer: "active" })
  })
})
