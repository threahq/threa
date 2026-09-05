/**
 * The conversation embedding pipeline against the real schema: the backfill's
 * eligibility predicate (summary text, primary messages, sealed-stream
 * exclusion), the embedding text it builds, the source-hash skip, and the
 * queue worker writing the same columns (INV-68).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupIsolatedTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { ConversationRepository, createConversationEmbeddingWorker } from "../../src/features/conversations"
import {
  plan,
  processChunk,
  type ConversationEmbeddingBackfillContext,
} from "../../src/features/conversations/embedding-backfill"
import { hashEmbeddingText, type EmbeddingServiceLike, type EmbeddingContext } from "../../src/features/memos"
import { conversationId, userEncryptionKeyId, workspaceId } from "../../src/lib/id"
import { AuthorTypes, StreamTypes, TitleSources, Visibilities } from "@threa/types"

const EMBEDDING_DIM = 1536

function unitVector(index: number): number[] {
  const vector = new Array(EMBEDDING_DIM).fill(0)
  vector[index % EMBEDDING_DIM] = 1
  return vector
}

function makeFakeEmbeddingService(): EmbeddingServiceLike & { batches: string[][]; singles: string[] } {
  const batches: string[][] = []
  const singles: string[] = []
  return {
    batches,
    singles,
    async embed(text: string, _context?: EmbeddingContext): Promise<number[]> {
      singles.push(text)
      return unitVector(7)
    },
    async embedBatch(texts: string[], _context?: EmbeddingContext): Promise<number[][]> {
      batches.push(texts)
      return texts.map((_text, index) => unitVector(index))
    },
  }
}

async function readEmbeddingRow(pool: Pool, id: string) {
  const result = await pool.query<{ embedding: string | null; embedding_source_hash: string | null }>(
    "SELECT embedding::text AS embedding, embedding_source_hash FROM conversations WHERE id = $1",
    [id]
  )
  return result.rows[0]!
}

describe("conversation-embeddings backfill and worker against the real schema", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let ctx: ConversationEmbeddingBackfillContext
  let embeddingService: ReturnType<typeof makeFakeEmbeddingService>

  const wsId = workspaceId()
  let ownerId: string
  let channelId: string
  let summarizedId: string
  let openingText: string
  let summaryOnlyId: string
  let unsummarizedId: string
  let emptyId: string
  let sealedId: string

  beforeAll(async () => {
    ;({ pool, cleanup } = await setupIsolatedTestDatabase("conv_embed_backfill"))
    embeddingService = makeFakeEmbeddingService()
    ctx = { pool, embeddingService }

    const streamService = new StreamService(pool)
    const eventService = new EventService(pool)

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Conversation Embedding WS",
        slug: `conv-embed-${wsId}`,
        createdBy: wsId,
      })
      ownerId = (await addTestMember(client, wsId, `owner-${wsId.slice(-8)}`)).id
    })

    const channel = await streamService.create({
      workspaceId: wsId,
      type: StreamTypes.CHANNEL,
      slug: `conv-embed-${wsId.slice(-8)}`,
      visibility: Visibilities.PUBLIC,
      createdBy: ownerId,
    })
    channelId = channel.id

    const post = async (sid: string, text: string) =>
      eventService.createMessage({
        workspaceId: wsId,
        streamId: sid,
        authorId: ownerId,
        authorType: AuthorTypes.USER,
        ...testMessageContent(text),
      })

    openingText = "should we launch in May or wait for the mobile build?"
    const opening = await post(channelId, openingText)
    const reply = await post(channelId, "wait for mobile")
    const summarized = await ConversationRepository.insert(pool, {
      id: conversationId(),
      streamId: channelId,
      workspaceId: wsId,
      topicSummary: "Choosing the launch date",
      topicSummarySource: TitleSources.GENERATED,
      summary: "Weighed May against waiting for mobile.",
    })
    summarizedId = summarized.id
    await ConversationRepository.addPrimaryMessages(pool, wsId, summarizedId, [opening.id, reply.id], [ownerId])

    const summaryOnlyMessage = await post(channelId, "the deploy failed again")
    const summaryOnly = await ConversationRepository.insert(pool, {
      id: conversationId(),
      streamId: channelId,
      workspaceId: wsId,
      topicSummary: null,
      topicSummarySource: TitleSources.GENERATED,
      summary: "Deploy failures on Friday.",
    })
    summaryOnlyId = summaryOnly.id
    await ConversationRepository.addPrimaryMessages(pool, wsId, summaryOnlyId, [summaryOnlyMessage.id], [ownerId])

    const unsummarizedMessage = await post(channelId, "no summary yet")
    const unsummarized = await ConversationRepository.insert(pool, {
      id: conversationId(),
      streamId: channelId,
      workspaceId: wsId,
      topicSummary: null,
      topicSummarySource: TitleSources.GENERATED,
      summary: null,
    })
    unsummarizedId = unsummarized.id
    await ConversationRepository.addPrimaryMessages(pool, wsId, unsummarizedId, [unsummarizedMessage.id], [ownerId])

    const empty = await ConversationRepository.insert(pool, {
      id: conversationId(),
      streamId: channelId,
      workspaceId: wsId,
      topicSummary: "Nothing left in here",
      topicSummarySource: TitleSources.GENERATED,
      summary: null,
    })
    emptyId = empty.id

    const sealedPad = await streamService.create({
      workspaceId: wsId,
      type: StreamTypes.SCRATCHPAD,
      name: "sealed-pad",
      visibility: Visibilities.PRIVATE,
      createdBy: ownerId,
    })
    const sealedMessage = await post(sealedPad.id, "secret launch notes")
    const sealed = await ConversationRepository.insert(pool, {
      id: conversationId(),
      streamId: sealedPad.id,
      workspaceId: wsId,
      topicSummary: "Secret launch notes",
      topicSummarySource: TitleSources.GENERATED,
      summary: null,
    })
    sealedId = sealed.id
    await ConversationRepository.addPrimaryMessages(pool, wsId, sealedId, [sealedMessage.id], [ownerId])
    await E2eStreamsRepository.markStreamE2e(pool, {
      streamId: sealedPad.id,
      workspaceId: wsId,
      ownerUserId: ownerId,
      ownerUserKeyId: userEncryptionKeyId(),
    })
  }, 30_000)

  afterAll(async () => {
    await cleanup()
  }, 30_000)

  test("plan lists only summarized conversations with primary messages outside sealed streams", async () => {
    const chunks = await plan(ctx, wsId)
    expect(chunks.flatMap((chunk) => chunk.ids).sort()).toEqual([summarizedId, summaryOnlyId].sort())
  })

  test("processChunk embeds topic + summary + opening and records the source hash; a rerun is a no-op", async () => {
    const [chunk] = await plan(ctx, wsId)
    const first = await processChunk(ctx, wsId, chunk!)
    expect(first).toEqual({ processed: 2 })

    const expectedText = `Choosing the launch date\nWeighed May against waiting for mobile.\n${openingText}`
    expect(embeddingService.batches.flat().sort()).toEqual(
      [expectedText, "Deploy failures on Friday.\nthe deploy failed again"].sort()
    )

    const row = await readEmbeddingRow(pool, summarizedId)
    expect(row.embedding).not.toBeNull()
    expect(row.embedding_source_hash).toBe(hashEmbeddingText(expectedText))

    // Ineligible rows stay untouched
    for (const id of [unsummarizedId, emptyId, sealedId]) {
      expect(await readEmbeddingRow(pool, id)).toEqual({ embedding: null, embedding_source_hash: null })
    }

    const batchesBefore = embeddingService.batches.length
    const rerun = await processChunk(ctx, wsId, chunk!)
    expect(rerun).toEqual({ processed: 0 })
    expect(embeddingService.batches.length).toBe(batchesBefore)
  })

  test("processChunk rechecks eligibility for the ids it was handed", async () => {
    const result = await processChunk(ctx, wsId, { ids: [unsummarizedId, emptyId, sealedId] })
    expect(result).toEqual({ processed: 0 })
  })

  test("the worker re-embeds when the summary changes and skips when the text is unchanged", async () => {
    const worker = createConversationEmbeddingWorker({ pool, embeddingService })
    const job = {
      id: "job_1",
      name: "conversation-embedding.generate",
      data: { conversationId: summarizedId, workspaceId: wsId },
    }

    await worker(job)
    expect(embeddingService.singles).toEqual([])

    await ConversationRepository.update(pool, wsId, summarizedId, { summary: "Decided to wait for mobile." })
    await worker(job)
    expect(embeddingService.singles).toEqual([`Choosing the launch date\nDecided to wait for mobile.\n${openingText}`])

    const row = await readEmbeddingRow(pool, summarizedId)
    expect(row.embedding_source_hash).toBe(
      hashEmbeddingText(`Choosing the launch date\nDecided to wait for mobile.\n${openingText}`)
    )
  })

  test("the worker throws for a retry when a newer embedding landed while it was embedding", async () => {
    const observed = `Choosing the launch date\nShipping in May.\n${openingText}`
    const newer = `Choosing the launch date\nShipping in June.\n${openingText}`
    await ConversationRepository.update(pool, wsId, summarizedId, { summary: "Shipping in May." })

    const racing: EmbeddingServiceLike = {
      async embed() {
        // Another worker finishes first with text that changed after this job's read
        const stored = (await readEmbeddingRow(pool, summarizedId)).embedding_source_hash
        await ConversationRepository.update(pool, wsId, summarizedId, { summary: "Shipping in June." })
        await ConversationRepository.updateEmbeddings(pool, wsId, [
          {
            id: summarizedId,
            embedding: unitVector(3),
            sourceHash: hashEmbeddingText(newer),
            expectedSourceHash: stored,
          },
        ])
        return unitVector(9)
      },
      async embedBatch() {
        throw new Error("unused")
      },
    }
    const job = {
      id: "job_race",
      name: "conversation-embedding.generate",
      data: { conversationId: summarizedId, workspaceId: wsId },
    }

    await expect(createConversationEmbeddingWorker({ pool, embeddingService: racing })(job)).rejects.toThrow(
      /source changed during embed/
    )
    expect(await readEmbeddingRow(pool, summarizedId)).toEqual({
      embedding: `[${unitVector(3).join(",")}]`,
      embedding_source_hash: hashEmbeddingText(newer),
    })
    expect(hashEmbeddingText(observed)).not.toBe(hashEmbeddingText(newer))

    // The retry sees the newer text already stored and does nothing
    const before = embeddingService.singles.length
    await createConversationEmbeddingWorker({ pool, embeddingService })(job)
    expect(embeddingService.singles.length).toBe(before)
  })

  test("processChunk skips a row whose embedding moved while the batch was embedding", async () => {
    const newer = "Deploy failures every Friday.\nthe deploy failed again"
    await ConversationRepository.update(pool, wsId, summaryOnlyId, { summary: "Deploy failures on Fridays." })

    const racing: EmbeddingServiceLike = {
      async embed() {
        throw new Error("unused")
      },
      async embedBatch(texts) {
        const stored = (await readEmbeddingRow(pool, summaryOnlyId)).embedding_source_hash
        await ConversationRepository.update(pool, wsId, summaryOnlyId, { summary: "Deploy failures every Friday." })
        await ConversationRepository.updateEmbeddings(pool, wsId, [
          {
            id: summaryOnlyId,
            embedding: unitVector(5),
            sourceHash: hashEmbeddingText(newer),
            expectedSourceHash: stored,
          },
        ])
        return texts.map(() => unitVector(11))
      },
    }

    const result = await processChunk({ pool, embeddingService: racing }, wsId, { ids: [summaryOnlyId] })
    expect(result).toEqual({ processed: 0 })
    expect(await readEmbeddingRow(pool, summaryOnlyId)).toEqual({
      embedding: `[${unitVector(5).join(",")}]`,
      embedding_source_hash: hashEmbeddingText(newer),
    })

    const rerun = await processChunk(ctx, wsId, { ids: [summaryOnlyId] })
    expect(rerun).toEqual({ processed: 0 })
  })

  test("the worker leaves unsummarized and sealed conversations alone", async () => {
    const worker = createConversationEmbeddingWorker({ pool, embeddingService })
    const before = embeddingService.singles.length

    for (const id of [unsummarizedId, sealedId]) {
      await worker({
        id: `job_${id}`,
        name: "conversation-embedding.generate",
        data: { conversationId: id, workspaceId: wsId },
      })
      expect(await readEmbeddingRow(pool, id)).toEqual({ embedding: null, embedding_source_hash: null })
    }
    expect(embeddingService.singles.length).toBe(before)
  })
})
