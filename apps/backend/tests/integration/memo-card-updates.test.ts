/**
 * `memo:updated` — the only thing allowed to change a rendered memo card.
 *
 * The card no longer fetches, so this event is how a retitle reaches a reader
 * who already has the message on screen. It is stream-scoped and gated per
 * citing room by the same predicate the write path uses, which is what stops it
 * becoming a workspace-wide broadcast of a memo's title. (`memo:created` IS
 * that broadcast today, carrying the whole memo including its abstract — noted,
 * pre-existing, and deliberately not inherited here.)
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { MemoExplorerService, MemoRepository } from "../../src/features/memos"
import type { EmbeddingServiceLike } from "../../src/features/memos"
import { userId, workspaceId, streamId, messageId, memoId } from "../../src/lib/id"
import type { JSONContent } from "@threa/types"

function bodyCiting(text: string, id: string): { contentJson: JSONContent; contentMarkdown: string } {
  return {
    contentJson: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text },
            { type: "memoEmbed", attrs: { memoId: id, title: "Cited" } },
          ],
        },
      ],
    },
    contentMarkdown: `${text} [Cited](memo:${id})`,
  }
}

describe("memo:updated", () => {
  let pool: Pool
  let eventService: EventService
  let explorer: MemoExplorerService
  let testWorkspaceId: string
  let testUserId: string
  let sourceChannel: string
  let otherPrivateChannel: string
  let publicChannel: string
  let memo: string
  let sequence = 1n

  async function outboxFor(memoIdToFind: string): Promise<Array<{ stream_id: string; title: string }>> {
    const result = await pool.query<{ payload: { streamId: string; summary: { title: string } } }>(
      `SELECT payload FROM outbox WHERE event_type = 'memo:updated' ORDER BY id ASC`
    )
    return result.rows
      .filter((row) => (row.payload as unknown as { memoId: string }).memoId === memoIdToFind)
      .map((row) => ({ stream_id: row.payload.streamId, title: row.payload.summary.title }))
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    eventService = new EventService(pool)
    explorer = new MemoExplorerService({
      pool,
      embeddingService: { embed: async () => [0.1] } as unknown as EmbeddingServiceLike,
      reranker: undefined,
    })
    testWorkspaceId = workspaceId()
    testUserId = userId()
    sourceChannel = streamId()
    otherPrivateChannel = streamId()
    publicChannel = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Memo Card Updates",
        slug: `memo-updates-${testWorkspaceId}`,
        createdBy: testUserId,
      })
      testUserId = (await addTestMember(client, testWorkspaceId, testUserId)).id
      for (const [id, visibility] of [
        [sourceChannel, "public"],
        [otherPrivateChannel, "private"],
        [publicChannel, "public"],
      ] as const) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: testWorkspaceId,
          type: "channel",
          visibility,
          slug: `s-${id.slice(-8)}`,
          createdBy: testUserId,
        })
      }
    })

    // A memo sourced in a PUBLIC channel, so every room may see its summary.
    memo = memoId()
    const sourceMsg = messageId()
    await withTransaction(pool, async (client) => {
      const { MessageRepository } = await import("../../src/features/messaging")
      await MessageRepository.insert(client, {
        id: sourceMsg,
        streamId: sourceChannel,
        sequence: sequence++,
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("source"),
      })
      await MemoRepository.insert(client, {
        id: memo,
        workspaceId: testWorkspaceId,
        memoType: "message",
        sourceMessageId: sourceMsg,
        title: "Launch in May",
        abstract: "abstract",
        keyPoints: [],
        sourceMessageIds: [sourceMsg],
        participantIds: [testUserId],
        knowledgeType: "decision",
        tags: ["launch"],
        status: "active",
      })
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("reaches every stream that cites the memo, once each, with the new card content", async () => {
    await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: publicChannel,
      authorId: testUserId,
      authorType: "user",
      ...bodyCiting("see", memo),
    })
    await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: otherPrivateChannel,
      authorId: testUserId,
      authorType: "user",
      ...bodyCiting("also see", memo),
    })

    await explorer.update(
      testWorkspaceId,
      memo,
      { accessibleStreamIds: [sourceChannel, publicChannel, otherPrivateChannel], userId: testUserId },
      { title: "Launch in June" }
    )

    const events = await outboxFor(memo)
    expect(events.map((e) => e.title)).toEqual(["Launch in June", "Launch in June"])
    expect(events.map((e) => e.stream_id).sort()).toEqual([otherPrivateChannel, publicChannel].sort())
  })

  test("skips a citing stream whose room may not see the memo", async () => {
    // A second memo, this one sourced in a PRIVATE channel, cited from a public
    // one. The citation exists; the public room may not be told what it says.
    const privateMemo = memoId()
    const sourceMsg = messageId()
    await withTransaction(pool, async (client) => {
      const { MessageRepository } = await import("../../src/features/messaging")
      await MessageRepository.insert(client, {
        id: sourceMsg,
        streamId: otherPrivateChannel,
        sequence: sequence++,
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("source"),
      })
      await MemoRepository.insert(client, {
        id: privateMemo,
        workspaceId: testWorkspaceId,
        memoType: "message",
        sourceMessageId: sourceMsg,
        title: "Acquisition target",
        abstract: "abstract",
        keyPoints: [],
        sourceMessageIds: [sourceMsg],
        participantIds: [testUserId],
        knowledgeType: "decision",
        tags: [],
        status: "active",
      })
    })

    await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: publicChannel,
      authorId: testUserId,
      authorType: "user",
      ...bodyCiting("pasted", privateMemo),
    })
    await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: otherPrivateChannel,
      authorId: testUserId,
      authorType: "user",
      ...bodyCiting("in its own room", privateMemo),
    })

    await explorer.update(
      testWorkspaceId,
      privateMemo,
      { accessibleStreamIds: [otherPrivateChannel, publicChannel], userId: testUserId },
      { title: "Acquisition target: Initech" }
    )

    const events = await outboxFor(privateMemo)
    expect(events.map((e) => e.stream_id)).toEqual([otherPrivateChannel])
  })

  test("emits nothing when no stream cites the memo", async () => {
    const uncited = memoId()
    const sourceMsg = messageId()
    await withTransaction(pool, async (client) => {
      const { MessageRepository } = await import("../../src/features/messaging")
      await MessageRepository.insert(client, {
        id: sourceMsg,
        streamId: publicChannel,
        sequence: sequence++,
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("source"),
      })
      await MemoRepository.insert(client, {
        id: uncited,
        workspaceId: testWorkspaceId,
        memoType: "message",
        sourceMessageId: sourceMsg,
        title: "Nobody links this",
        abstract: "abstract",
        keyPoints: [],
        sourceMessageIds: [sourceMsg],
        participantIds: [testUserId],
        knowledgeType: "decision",
        tags: [],
        status: "active",
      })
    })

    await explorer.update(
      testWorkspaceId,
      uncited,
      { accessibleStreamIds: [publicChannel], userId: testUserId },
      { title: "Still nobody" }
    )

    expect(await outboxFor(uncited)).toEqual([])
  })

  test("carries only the card's fields — never the memo's substance", async () => {
    const events = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox WHERE event_type = 'memo:updated' LIMIT 1`
    )
    const summary = events.rows[0]?.payload.summary as Record<string, unknown>
    expect(Object.keys(summary).sort()).toEqual(["knowledgeType", "memoId", "memoType", "tags", "title", "updatedAt"])
  })

  // The destination side of a move bulkPuts server payloads over the client's
  // cache — a memo:updated patch the client applied would be repainted
  // backwards by the stored snapshot. The move re-resolves at move time.
  test("a move ships current summaries, not the stored snapshot", async () => {
    const moved = memoId()
    const srcMsg = messageId()
    await withTransaction(pool, async (client) => {
      const { MessageRepository } = await import("../../src/features/messaging")
      await MessageRepository.insert(client, {
        id: srcMsg,
        streamId: publicChannel,
        sequence: sequence++,
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("source"),
      })
      await MemoRepository.insert(client, {
        id: moved,
        workspaceId: testWorkspaceId,
        memoType: "message",
        sourceMessageId: srcMsg,
        title: "Before the move",
        abstract: "abstract",
        keyPoints: [],
        sourceMessageIds: [srcMsg],
        participantIds: [testUserId],
        knowledgeType: "decision",
        tags: [],
        status: "active",
      })
    })

    const { StreamMemberRepository } = await import("../../src/features/streams")
    await StreamMemberRepository.insert(pool, publicChannel, testUserId)

    const target = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: publicChannel,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("thread anchor"),
    })
    const citing = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: publicChannel,
      authorId: testUserId,
      authorType: "user",
      ...bodyCiting("citing, about to move", moved),
    })
    await pool.query(`UPDATE memos SET title = 'Retitled before the move' WHERE id = $1`, [moved])

    const validation = await eventService.validateMoveMessagesToThread({
      workspaceId: testWorkspaceId,
      sourceStreamId: publicChannel,
      targetMessageId: target.id,
      messageIds: [citing.id],
      actorId: testUserId,
    })
    await eventService.moveMessagesToThread({
      workspaceId: testWorkspaceId,
      sourceStreamId: publicChannel,
      targetMessageId: target.id,
      messageIds: [citing.id],
      actorId: testUserId,
      leaseKey: validation.leaseKey,
    })

    const movedOutbox = await pool.query<{ payload: { events: Array<{ eventType: string; payload: unknown }> } }>(
      `SELECT payload FROM outbox WHERE event_type = 'messages:moved' ORDER BY id DESC LIMIT 1`
    )
    const movedCreated = movedOutbox.rows[0].payload.events.find(
      (e) => e.eventType === "message_created" && (e.payload as { messageId?: string }).messageId === citing.id
    )
    const embeds = (movedCreated?.payload as { memoEmbeds?: Array<{ title: string }> }).memoEmbeds
    expect(embeds?.map((s) => s.title)).toEqual(["Retitled before the move"])
  })

  // findCitingStreamIds scans content_markdown with LIKE '%(memo:<id>)%' — a
  // string tie to the wire format. This canary routes a memoEmbed node through
  // the REAL serializer and the real create path, so if the serialized shape
  // ever drifts from the pattern, this reddens instead of memo:updated silently
  // reaching no one. The other tests hand-write their markdown and cannot see
  // that drift.
  test("the citation scan matches what the real serializer stores", async () => {
    const { serializeToMarkdown } = await import("@threa/prosemirror")
    const canary = memoId()
    const sourceMsg = messageId()
    await withTransaction(pool, async (client) => {
      const { MessageRepository } = await import("../../src/features/messaging")
      await MessageRepository.insert(client, {
        id: sourceMsg,
        streamId: publicChannel,
        sequence: sequence++,
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("source"),
      })
      await MemoRepository.insert(client, {
        id: canary,
        workspaceId: testWorkspaceId,
        memoType: "message",
        sourceMessageId: sourceMsg,
        title: "Serializer canary",
        abstract: "abstract",
        keyPoints: [],
        sourceMessageIds: [sourceMsg],
        participantIds: [testUserId],
        knowledgeType: "decision",
        tags: [],
        status: "active",
      })
    })

    const contentJson: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "canary " },
            { type: "memoEmbed", attrs: { memoId: canary, title: "Serializer canary" } },
          ],
        },
      ],
    }
    await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: publicChannel,
      authorId: testUserId,
      authorType: "user",
      contentJson,
      contentMarkdown: serializeToMarkdown(contentJson),
    })

    expect(await MemoRepository.findCitingStreamIds(pool, testWorkspaceId, canary)).toEqual([publicChannel])
  })
})
