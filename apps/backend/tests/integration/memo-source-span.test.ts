import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { StreamTypes, Visibilities } from "@threahq/types"
import { MemoRepository, type MemoCopy } from "../../src/features/memos"
import { plan, processChunk } from "../../src/features/memos/source-span-backfill"
import { MessageRepository } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { conversationId, memoId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupTestDatabase, testMessageContent, withTransaction } from "./setup"

function axis(index: number): number[] {
  const vector = new Array(1536).fill(0)
  vector[index] = 1
  return vector
}

const MARCH_1 = new Date("2026-03-01T09:00:00Z")
const MARCH_9 = new Date("2026-03-09T09:00:00Z")
const MARCH_20 = new Date("2026-03-20T09:00:00Z")
const APRIL_1 = new Date("2026-04-01T09:00:00Z")
const MAY_1 = new Date("2026-05-01T09:00:00Z")

describe("memo source span", () => {
  let pool: Pool
  let testWorkspaceId: string
  let channelId: string
  let ownerId: string
  let messageIds: string[]
  const memos = {
    march: memoId(),
    april: memoId(),
    may: memoId(),
    unresolved: memoId(),
  }

  async function insertMemo(id: string, title: string, anchor: string, sourceMessageIds: string[]) {
    return MemoRepository.insert(pool, {
      id,
      workspaceId: testWorkspaceId,
      memoType: "message",
      sourceMessageId: anchor,
      title,
      abstract: `${title} abstract`,
      keyPoints: [],
      sourceMessageIds,
      participantIds: [ownerId],
      knowledgeType: "decision",
    })
  }

  const spanOf = (memo: { earliestSourceAt: Date | null; latestSourceAt: Date | null } | null) => ({
    earliest: memo?.earliestSourceAt?.toISOString() ?? null,
    latest: memo?.latestSourceAt?.toISOString() ?? null,
  })

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testWorkspaceId = workspaceId()
    channelId = streamId()
    const workosUserId = userId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Source Span",
        slug: `source-span-${testWorkspaceId}`,
        createdBy: workosUserId,
      })
      ownerId = (await addTestMember(client, testWorkspaceId, workosUserId)).id
      await StreamRepository.insert(client, {
        id: channelId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PRIVATE,
        slug: `source-span-${channelId}`,
        createdBy: ownerId,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, channelId, ownerId)

      const sources = await Promise.all(
        [MARCH_1, MARCH_9, MARCH_20, APRIL_1, MAY_1].map((createdAt, index) =>
          MessageRepository.insert(client, {
            workspaceId: testWorkspaceId,
            id: messageId(),
            streamId: channelId,
            sequence: BigInt(index + 1),
            authorId: ownerId,
            authorType: "user",
            createdAt,
            ...testMessageContent(`source ${index}`),
          })
        )
      )
      messageIds = sources.map((source) => source.id)
      await MessageRepository.softDelete(client, testWorkspaceId, messageIds[2]!)
    })

    await insertMemo(memos.march, "March memo", messageIds[0]!, [messageIds[0]!, messageIds[1]!, messageIds[2]!])
    await insertMemo(memos.april, "April memo", messageIds[3]!, [messageIds[3]!])
    await insertMemo(memos.may, "May memo", messageIds[4]!, [messageIds[4]!])
    await insertMemo(memos.unresolved, "Unresolved memo", messageId(), [])
    await Promise.all(
      [memos.march, memos.april, memos.may].map((id) =>
        MemoRepository.updateEmbedding(pool, testWorkspaceId, id, axis(0))
      )
    )
  })

  afterAll(async () => {
    await pool.end()
  })

  const browse = async (filters: { before?: Date; after?: Date } = {}) => {
    const rows = await MemoRepository.fullTextSearch(pool, {
      workspaceId: testWorkspaceId,
      query: "",
      filters: { streamIds: [channelId], ...filters },
    })
    return rows.map((row) => row.memo.title)
  }

  test("insert stores the span of the cited messages, deleted ones included, and null when none resolve", async () => {
    const [march, april, unresolved] = await Promise.all([
      MemoRepository.findById(pool, testWorkspaceId, memos.march),
      MemoRepository.findById(pool, testWorkspaceId, memos.april),
      MemoRepository.findById(pool, testWorkspaceId, memos.unresolved),
    ])

    expect({ march: spanOf(march), april: spanOf(april), unresolved: spanOf(unresolved) }).toEqual({
      march: { earliest: MARCH_1.toISOString(), latest: MARCH_20.toISOString() },
      april: { earliest: APRIL_1.toISOString(), latest: APRIL_1.toISOString() },
      unresolved: { earliest: null, latest: null },
    })
  })

  test("before and after select memos whose source span overlaps the window", async () => {
    const [beforeMarch5, afterMarch25, insideMarch, afterMay] = await Promise.all([
      browse({ before: new Date("2026-03-05T00:00:00Z") }),
      browse({ after: new Date("2026-03-25T00:00:00Z") }),
      browse({ after: new Date("2026-03-10T00:00:00Z"), before: new Date("2026-03-15T00:00:00Z") }),
      browse({ after: new Date("2026-06-01T00:00:00Z") }),
    ])

    expect({ beforeMarch5, afterMarch25: afterMarch25.sort(), insideMarch, afterMay }).toEqual({
      beforeMarch5: ["March memo"],
      afterMarch25: ["April memo", "May memo"],
      insideMarch: ["March memo"],
      afterMay: [],
    })
  })

  test("full-text, exact and hybrid queries apply the same source-span window", async () => {
    const filters = (window: { before?: Date; after?: Date }) => ({ streamIds: [channelId], ...window })
    const titles = (rows: { memo: { title: string } }[]) => rows.map((row) => row.memo.title).sort()
    const window = async (span: { before?: Date; after?: Date }) => {
      const params = { workspaceId: testWorkspaceId, query: "memo", filters: filters(span) }
      const [fullText, exact, hybrid] = await Promise.all([
        MemoRepository.fullTextSearch(pool, params),
        MemoRepository.exactSearch(pool, params),
        MemoRepository.hybridSearch(pool, { ...params, embedding: axis(0), semanticDistanceThreshold: null }),
      ])
      return { fullText: titles(fullText), exact: titles(exact), hybrid: titles(hybrid) }
    }

    const [beforeMarch25, afterMarch25] = await Promise.all([
      window({ before: new Date("2026-03-25T00:00:00Z") }),
      window({ after: new Date("2026-03-25T00:00:00Z") }),
    ])

    const marchOnly = ["March memo"]
    const springOnly = ["April memo", "May memo"]
    expect({ beforeMarch25, afterMarch25 }).toEqual({
      beforeMarch25: { fullText: marchOnly, exact: marchOnly, hybrid: marchOnly },
      afterMarch25: { fullText: springOnly, exact: springOnly, hybrid: springOnly },
    })
  })

  test("stream and conversation reads order by source time, not capture time", async () => {
    const room = streamId()
    const conversation = conversationId()
    const posted = [
      new Date("2026-01-01T09:00:00Z"),
      new Date("2026-01-02T09:00:00Z"),
      new Date("2026-01-03T09:00:00Z"),
    ]
    const sources = await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id: room,
        workspaceId: testWorkspaceId,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PRIVATE,
        slug: `source-span-${room}`,
        createdBy: ownerId,
      })
      return Promise.all(
        posted.map((createdAt, index) =>
          MessageRepository.insert(client, {
            workspaceId: testWorkspaceId,
            id: messageId(),
            streamId: room,
            sequence: BigInt(index + 1),
            authorId: ownerId,
            authorType: "user",
            createdAt,
            ...testMessageContent(`ordering ${index}`),
          })
        )
      )
    })
    // Captured newest-source first, so capture order is the reverse of source order.
    for (const [index, source] of [...sources.entries()].reverse()) {
      await insertMemo(memoId(), `Message memo ${index}`, source.id, [source.id])
      await MemoRepository.insert(pool, {
        id: memoId(),
        workspaceId: testWorkspaceId,
        memoType: "conversation",
        sourceConversationId: conversation,
        title: `Conversation memo ${index}`,
        abstract: "Ordered by source time.",
        sourceMessageIds: [source.id],
        participantIds: [ownerId],
        knowledgeType: "decision",
      })
    }

    const [byStream, byConversation] = await Promise.all([
      MemoRepository.findByStream(pool, testWorkspaceId, room, { scopeUserId: null, audiences: [] }),
      MemoRepository.findActiveBySourceConversation(pool, testWorkspaceId, conversation, []),
    ])

    expect({
      byStream: byStream.map((memo) => memo.title),
      byConversation: byConversation.map((memo) => memo.title),
    }).toEqual({
      byStream: ["Message memo 2", "Message memo 1", "Message memo 0"],
      byConversation: ["Conversation memo 0", "Conversation memo 1", "Conversation memo 2"],
    })
  })

  test("browse orders memos by their latest source message, newest first", async () => {
    expect(await browse()).toEqual(["May memo", "April memo", "March memo"])
  })

  test("filterSupersedable keeps memos whose stored span ends no later than the candidate's sources", async () => {
    const allowed = await MemoRepository.filterSupersedable(
      pool,
      testWorkspaceId,
      [memos.march, memos.april, memos.may, memos.unresolved],
      { conversationId: null, sourceMessageIds: [messageIds[3]!] }
    )

    expect(allowed.sort()).toEqual([memos.march, memos.april].sort())
  })

  test("the backfill fills memos with no span from their sources and a rerun changes nothing", async () => {
    const backfilled = memoId()
    const stillUnresolved = memoId()
    await insertMemo(backfilled, "Backfilled memo", messageIds[0]!, [messageIds[0]!, messageIds[1]!])
    await insertMemo(stillUnresolved, "Unresolved again", messageId(), [])
    await pool.query("UPDATE memos SET earliest_source_at = NULL, latest_source_at = NULL WHERE id = $1", [backfilled])

    const chunks = await plan({ pool }, testWorkspaceId)
    const planned = chunks.flatMap((chunk) => chunk.ids)
    const first = await Promise.all(chunks.map((chunk) => processChunk({ pool }, testWorkspaceId, chunk)))
    const rerun = await Promise.all(chunks.map((chunk) => processChunk({ pool }, testWorkspaceId, chunk)))
    const [filled, unresolved] = await Promise.all([
      MemoRepository.findById(pool, testWorkspaceId, backfilled),
      MemoRepository.findById(pool, testWorkspaceId, stillUnresolved),
    ])

    expect({
      plannedBackfilled: planned.includes(backfilled),
      plannedMemoWithSpan: planned.includes(memos.march),
      processed: first.reduce((sum, result) => sum + result.processed, 0),
      reprocessed: rerun.reduce((sum, result) => sum + result.processed, 0),
      filled: spanOf(filled),
      unresolved: spanOf(unresolved),
    }).toEqual({
      plannedBackfilled: true,
      plannedMemoWithSpan: false,
      processed: 1,
      reprocessed: 0,
      filled: { earliest: MARCH_1.toISOString(), latest: MARCH_9.toISOString() },
      unresolved: { earliest: null, latest: null },
    })
  })

  test("filterSupersedable dates a memo the backfill has not reached from its sources", async () => {
    const pending = memoId()
    await insertMemo(pending, "Pending backfill", messageIds[0]!, [messageIds[0]!])
    await pool.query("UPDATE memos SET earliest_source_at = NULL, latest_source_at = NULL WHERE id = $1", [pending])

    const [byNewer, byOlder] = await Promise.all([
      MemoRepository.filterSupersedable(pool, testWorkspaceId, [pending], {
        conversationId: null,
        sourceMessageIds: [messageIds[1]!],
      }),
      MemoRepository.filterSupersedable(pool, testWorkspaceId, [pending], {
        conversationId: null,
        sourceMessageIds: [messageId()],
      }),
    ])

    expect({ byNewer, byOlder }).toEqual({ byNewer: [pending], byOlder: [] })
  })

  test("upsertCopies keeps the host's span, falls back to local source copies, and never clears a stored span", async () => {
    const copy = (
      id: string,
      sourceMessageIds: string[],
      span: Pick<MemoCopy, "earliestSourceAt" | "latestSourceAt" | "cardVersion">
    ): MemoCopy => ({
      id,
      conversationId: conversationId(),
      title: "Shared copy",
      abstract: "Copied across the bridge.",
      keyPoints: [],
      sourceMessageIds,
      participantIds: [],
      knowledgeType: "decision",
      tags: [],
      version: 1,
      embedding: axis(0),
      createdAt: "2026-06-01T00:00:00.000Z",
      ...span,
    })
    const undatedHost = { earliestSourceAt: null, latestSourceAt: null }
    const dated = memoId()
    const local = memoId()
    const undated = memoId()
    const origin = workspaceId()
    const unreplicated = [messageId()]

    await MemoRepository.upsertCopies(pool, testWorkspaceId, origin, channelId, [
      copy(dated, unreplicated, {
        earliestSourceAt: MARCH_1.toISOString(),
        latestSourceAt: MARCH_9.toISOString(),
        cardVersion: 1,
      }),
      copy(local, [messageIds[3]!, messageIds[4]!], { ...undatedHost, cardVersion: 1 }),
      copy(undated, unreplicated, { ...undatedHost, cardVersion: 1 }),
    ])
    await MemoRepository.upsertCopies(pool, testWorkspaceId, origin, channelId, [
      copy(dated, unreplicated, { ...undatedHost, cardVersion: 2 }),
    ])
    const [datedCopy, localCopy, undatedCopy] = await Promise.all([
      MemoRepository.findById(pool, testWorkspaceId, dated),
      MemoRepository.findById(pool, testWorkspaceId, local),
      MemoRepository.findById(pool, testWorkspaceId, undated),
    ])

    expect({ dated: spanOf(datedCopy), local: spanOf(localCopy), undated: spanOf(undatedCopy) }).toEqual({
      dated: { earliest: MARCH_1.toISOString(), latest: MARCH_9.toISOString() },
      local: { earliest: APRIL_1.toISOString(), latest: MAY_1.toISOString() },
      undated: { earliest: null, latest: null },
    })
  })
})
