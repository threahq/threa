/**
 * The backfill's SQL, against a real schema.
 *
 * `plan`'s join through `streams` (messages has no `workspace_id` column) and
 * the e2e-sealed exclusion can't be proven from a unit test's fake pool
 * (INV-68) — the same gap that let a workspace-less `messages` predicate reach
 * production and dead-letter every backfill plan job for a month.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService } from "../../src/features/streams"
import { EventService, MessageRepository } from "../../src/features/messaging"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { ConversationRepository } from "../../src/features/conversations"
import {
  plan,
  processChunk,
  type MessageEmbeddingBackfillContext,
} from "../../src/features/memos/message-embedding-backfill"
import { buildMessageEmbeddingText } from "../../src/features/memos/message-embedding-text"
import type { EmbeddingServiceLike, EmbeddingContext } from "../../src/features/memos"
import { conversationId, userEncryptionKeyId, workspaceId } from "../../src/lib/id"
import { AuthorTypes, StreamTypes, TitleSources, Visibilities } from "@threa/types"

const EMBEDDING_DIM = 1536

function unitVector(index: number): number[] {
  const vector = new Array(EMBEDDING_DIM).fill(0)
  vector[index % EMBEDDING_DIM] = 1
  return vector
}

function makeFakeEmbeddingService(): EmbeddingServiceLike & { batches: string[][] } {
  const batches: string[][] = []
  return {
    batches,
    async embed(_text: string, _context?: EmbeddingContext): Promise<number[]> {
      return unitVector(0)
    },
    async embedBatch(texts: string[], _context?: EmbeddingContext): Promise<number[][]> {
      batches.push(texts)
      return texts.map((_text, index) => unitVector(index))
    },
  }
}

describe("message-embeddings-context backfill against the real schema", () => {
  let pool: Pool
  let ctx: MessageEmbeddingBackfillContext
  let fakeEmbeddingService: EmbeddingServiceLike & { batches: string[][] }

  const wsId = workspaceId()
  let ownerId: string
  let channelId: string
  let channelSlug: string
  let questionId: string
  let questionContent: string
  let replyId: string
  let replyContent: string
  let outsideId: string
  let outsideContent: string
  let shortId: string
  let deletedId: string
  let systemId: string
  let sealedMessageId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    fakeEmbeddingService = makeFakeEmbeddingService()
    ctx = { pool, embeddingService: fakeEmbeddingService }

    const streamService = new StreamService(pool)
    const eventService = new EventService(pool)

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Embedding Backfill WS",
        slug: `embed-backfill-ws-${wsId}`,
        createdBy: wsId,
      })
      ownerId = (await addTestMember(client, wsId, `owner-${wsId.slice(-8)}`)).id
    })

    channelSlug = `embed-backfill-channel-${wsId.slice(-8)}`
    const channel = await streamService.create({
      workspaceId: wsId,
      type: StreamTypes.CHANNEL,
      slug: channelSlug,
      visibility: Visibilities.PUBLIC,
      createdBy: ownerId,
    })
    channelId = channel.id

    questionContent = "what should we ship this week?"
    const question = await eventService.createMessage({
      workspaceId: wsId,
      streamId: channelId,
      authorId: ownerId,
      authorType: AuthorTypes.USER,
      ...testMessageContent(questionContent),
    })
    questionId = question.id

    replyContent = "let's ship the message embedding backfill"
    const reply = await eventService.createMessage({
      workspaceId: wsId,
      streamId: channelId,
      authorId: ownerId,
      authorType: AuthorTypes.USER,
      ...testMessageContent(replyContent),
    })
    replyId = reply.id

    // Primary-assigned into a conversation (below) so the "same context text"
    // test can prove the reply embeds with the conversation's topic/summary
    // and this one — never assigned — embeds with header + anchor + body only.
    outsideContent = "an eligible message that no conversation ever claims"
    const outside = await eventService.createMessage({
      workspaceId: wsId,
      streamId: channelId,
      authorId: ownerId,
      authorType: AuthorTypes.USER,
      ...testMessageContent(outsideContent),
    })
    outsideId = outside.id

    const conversation = await ConversationRepository.insert(pool, {
      id: conversationId(),
      streamId: channelId,
      workspaceId: wsId,
      topicSummary: "Shipping the search change",
      topicSummarySource: TitleSources.GENERATED,
      summary: "Whether to ship on Friday",
    })
    await ConversationRepository.addPrimaryMessages(pool, wsId, conversation.id, [questionId, replyId], [ownerId])

    const short = await eventService.createMessage({
      workspaceId: wsId,
      streamId: channelId,
      authorId: ownerId,
      authorType: AuthorTypes.USER,
      ...testMessageContent("ok"),
    })
    shortId = short.id

    const deleted = await eventService.createMessage({
      workspaceId: wsId,
      streamId: channelId,
      authorId: ownerId,
      authorType: AuthorTypes.USER,
      ...testMessageContent("this message will be deleted"),
    })
    deletedId = deleted.id
    await eventService.deleteMessageInternal({
      workspaceId: wsId,
      messageId: deletedId,
      streamId: channelId,
      actorId: ownerId,
    })

    const system = await eventService.createMessage({
      workspaceId: wsId,
      streamId: channelId,
      authorId: AuthorTypes.SYSTEM,
      authorType: AuthorTypes.SYSTEM,
      ...testMessageContent("a system-authored notice long enough to embed"),
    })
    systemId = system.id

    const sealed = await streamService.create({
      workspaceId: wsId,
      type: StreamTypes.SCRATCHPAD,
      name: "sealed-pad",
      visibility: Visibilities.PRIVATE,
      createdBy: ownerId,
    })
    // Indexable content FIRST, then the seal: without it the stream would earn
    // a chunk, so the exclusion is what keeps it out rather than emptiness.
    const sealedMessage = await eventService.createMessage({
      workspaceId: wsId,
      streamId: sealed.id,
      authorId: ownerId,
      authorType: AuthorTypes.USER,
      ...testMessageContent("secret content in the sealed pad"),
    })
    sealedMessageId = sealedMessage.id
    await E2eStreamsRepository.markStreamE2e(pool, {
      streamId: sealed.id,
      workspaceId: wsId,
      ownerUserId: ownerId,
      ownerUserKeyId: userEncryptionKeyId(),
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("plan returns exactly the three eligible message ids in one chunk", async () => {
    const chunks = await plan(ctx, wsId)

    expect(chunks).toEqual([{ ids: [questionId, replyId, outsideId] }])
  })

  test("processChunk embeds the eligible messages with the same context text the live path builds, and skips the rest", async () => {
    const chunks = await plan(ctx, wsId)
    expect(chunks).toHaveLength(1)

    const result = await processChunk(ctx, wsId, chunks[0]!)
    expect(result).toEqual({ processed: 3 })

    const recordedTexts = fakeEmbeddingService.batches.flat()

    const expectedReplyText = buildMessageEmbeddingText({
      streamType: StreamTypes.CHANNEL,
      streamName: channelSlug,
      topic: "Shipping the search change",
      summary: "Whether to ship on Friday",
      anchor: null,
      preceding: [questionContent],
      content: replyContent,
    })
    expect(recordedTexts).toContain(expectedReplyText)

    const expectedOutsideText = buildMessageEmbeddingText({
      streamType: StreamTypes.CHANNEL,
      streamName: channelSlug,
      topic: null,
      summary: null,
      anchor: null,
      preceding: [],
      content: outsideContent,
    })
    expect(recordedTexts).toContain(expectedOutsideText)

    const embedded = await pool.query<{ id: string }>(
      "SELECT id FROM messages WHERE id = ANY($1) AND embedding IS NOT NULL",
      [[questionId, replyId, outsideId]]
    )
    expect(new Set(embedded.rows.map((row) => row.id))).toEqual(new Set([questionId, replyId, outsideId]))

    const notEmbedded = await pool.query<{ id: string }>(
      "SELECT id FROM messages WHERE id = ANY($1) AND embedding IS NOT NULL",
      [[shortId, deletedId, systemId, sealedMessageId]]
    )
    expect(notEmbedded.rows).toEqual([])

    // IS NOT NULL alone can't catch a wrong `::vector` cast (a mismatched
    // literal would still store SOME vector) — compare the round-tripped
    // value against the exact literal the fake service returned for each id.
    const stored = await pool.query<{ id: string; embedding: string }>(
      "SELECT id, embedding::text AS embedding FROM messages WHERE id = ANY($1)",
      [chunks[0]!.ids]
    )
    const storedById = new Map(stored.rows.map((row) => [row.id, row.embedding]))
    chunks[0]!.ids.forEach((id, index) => {
      expect(storedById.get(id)).toBe(`[${unitVector(index).join(",")}]`)
    })
  })

  test("re-running processChunk on the same chunk succeeds and reports the same count", async () => {
    const chunks = await plan(ctx, wsId)
    const result = await processChunk(ctx, wsId, chunks[0]!)

    expect(result).toEqual({ processed: 3 })
  })

  test("skips a message whose stream vanished between plan and process, without poisoning the rest of the chunk", async () => {
    const vanishWsId = workspaceId()
    let vanishOwnerId = ""
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: vanishWsId,
        name: "Vanish WS",
        slug: `vanish-ws-${vanishWsId}`,
        createdBy: vanishWsId,
      })
      vanishOwnerId = (await addTestMember(client, vanishWsId, `owner-${vanishWsId.slice(-8)}`)).id
    })

    const streamService = new StreamService(pool)
    const eventService = new EventService(pool)

    const survivingChannel = await streamService.create({
      workspaceId: vanishWsId,
      type: StreamTypes.CHANNEL,
      slug: `vanish-surviving-${vanishWsId.slice(-8)}`,
      visibility: Visibilities.PUBLIC,
      createdBy: vanishOwnerId,
    })
    const vanishingChannel = await streamService.create({
      workspaceId: vanishWsId,
      type: StreamTypes.CHANNEL,
      slug: `vanish-doomed-${vanishWsId.slice(-8)}`,
      visibility: Visibilities.PUBLIC,
      createdBy: vanishOwnerId,
    })

    const survivingMessage = await eventService.createMessage({
      workspaceId: vanishWsId,
      streamId: survivingChannel.id,
      authorId: vanishOwnerId,
      authorType: AuthorTypes.USER,
      ...testMessageContent("this message's stream survives the whole run"),
    })
    const vanishingMessage = await eventService.createMessage({
      workspaceId: vanishWsId,
      streamId: vanishingChannel.id,
      authorId: vanishOwnerId,
      authorType: AuthorTypes.USER,
      ...testMessageContent("this message's stream is deleted before processChunk runs"),
    })

    const chunks = await plan(ctx, vanishWsId)
    expect(chunks).toEqual([{ ids: [survivingMessage.id, vanishingMessage.id] }])

    // No FKs in this schema (INV-1) — deleting the stream row directly is a
    // clean way to reproduce "stream vanished after plan, before process"
    // without mocking `loadMessageEmbeddingText` (INV-48).
    await pool.query("DELETE FROM streams WHERE id = $1", [vanishingChannel.id])

    const result = await processChunk(ctx, vanishWsId, chunks[0]!)
    expect(result).toEqual({ processed: 1 })

    const embedded = await pool.query<{ id: string }>(
      "SELECT id FROM messages WHERE id = ANY($1) AND embedding IS NOT NULL",
      [[survivingMessage.id, vanishingMessage.id]]
    )
    expect(embedded.rows.map((row) => row.id)).toEqual([survivingMessage.id])
  })

  test("skips a message that lost eligibility between plan and process", async () => {
    const staleWsId = workspaceId()
    let staleOwnerId = ""
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: staleWsId,
        name: "Stale Eligibility WS",
        slug: `stale-eligibility-ws-${staleWsId}`,
        createdBy: staleWsId,
      })
      staleOwnerId = (await addTestMember(client, staleWsId, `owner-${staleWsId.slice(-8)}`)).id
    })

    const streamService = new StreamService(pool)
    const eventService = new EventService(pool)

    const channel = await streamService.create({
      workspaceId: staleWsId,
      type: StreamTypes.CHANNEL,
      slug: `stale-eligibility-${staleWsId.slice(-8)}`,
      visibility: Visibilities.PUBLIC,
      createdBy: staleOwnerId,
    })

    const keep = await eventService.createMessage({
      workspaceId: staleWsId,
      streamId: channel.id,
      authorId: staleOwnerId,
      authorType: AuthorTypes.USER,
      ...testMessageContent("this message stays eligible through processing"),
    })
    const dropContent = "this message is soft-deleted before processChunk runs"
    const drop = await eventService.createMessage({
      workspaceId: staleWsId,
      streamId: channel.id,
      authorId: staleOwnerId,
      authorType: AuthorTypes.USER,
      ...testMessageContent(dropContent),
    })

    const chunks = await plan(ctx, staleWsId)
    expect(chunks).toEqual([{ ids: [keep.id, drop.id] }])

    await pool.query("UPDATE messages SET deleted_at = NOW(), revision = revision + 1 WHERE id = $1", [drop.id])

    const batchesBefore = fakeEmbeddingService.batches.length
    const result = await processChunk(ctx, staleWsId, chunks[0]!)
    expect(result).toEqual({ processed: 1 })

    const recordedTexts = fakeEmbeddingService.batches.slice(batchesBefore).flat()
    expect(recordedTexts.some((text) => text.includes(dropContent))).toBe(false)

    const dropRow = await pool.query<{ embedding: string | null }>("SELECT embedding FROM messages WHERE id = $1", [
      drop.id,
    ])
    expect(dropRow.rows[0]?.embedding).toBeNull()
  })

  test("does not overwrite an embedding when the row's revision moved", async () => {
    const streamService = new StreamService(pool)
    const eventService = new EventService(pool)

    const channel = await streamService.create({
      workspaceId: wsId,
      type: StreamTypes.CHANNEL,
      slug: `embed-revision-cas-${wsId.slice(-8)}`,
      visibility: Visibilities.PUBLIC,
      createdBy: ownerId,
    })
    const message = await eventService.createMessage({
      workspaceId: wsId,
      streamId: channel.id,
      authorId: ownerId,
      authorType: AuthorTypes.USER,
      ...testMessageContent("a message used to prove the CAS on revision"),
    })

    const staleResult = await MessageRepository.updateEmbeddings(pool, [
      { id: message.id, revision: message.revision - 1, embedding: unitVector(0) },
    ])
    expect(staleResult).toBe(0)

    const afterStale = await pool.query<{ embedding: string | null }>("SELECT embedding FROM messages WHERE id = $1", [
      message.id,
    ])
    expect(afterStale.rows[0]?.embedding).toBeNull()

    const currentResult = await MessageRepository.updateEmbeddings(pool, [
      { id: message.id, revision: message.revision, embedding: unitVector(0) },
    ])
    expect(currentResult).toBe(1)

    const afterCurrent = await pool.query<{ embedding: string | null }>(
      "SELECT embedding FROM messages WHERE id = $1",
      [message.id]
    )
    expect(afterCurrent.rows[0]?.embedding).not.toBeNull()
  })
})
