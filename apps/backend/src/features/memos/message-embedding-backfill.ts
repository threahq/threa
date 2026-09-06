import { AuthorTypes } from "@threahq/types"
import { composeSql, sql } from "../../db"
import { chunkIds, registerBackfill, type BackfillContext } from "../../lib/backfill"
import { logger } from "../../lib/logger"
import { MessageRepository, type Message } from "../messaging"
import type { EmbeddingServiceLike } from "./embedding-service"
import { hashEmbeddingText, loadMessageEmbeddingText } from "./message-embedding-text"

/** The embeddings API caps tokens per request, and a chunk can hold up to 500 messages of up to 8k chars each. */
const EMBED_SUB_BATCH_SIZE = 100

export type MessageEmbeddingChunk = { ids: string[] }

/**
 * Same eligibility the live path applies (`EmbeddingHandler` + `createEmbeddingWorker`):
 * non-system, non-deleted, non-sealed, at least 10 chars of content. Shared via
 * `composeSql` fragment nesting between `plan` and `processChunk`'s process-time
 * recheck (INV-20) so the two can't drift.
 */
const ELIGIBLE_PREDICATE = sql`
  NOT EXISTS (SELECT 1 FROM e2e_streams e WHERE e.stream_id = s.id)
  AND m.deleted_at IS NULL
  AND m.author_type <> ${AuthorTypes.SYSTEM}
  AND length(btrim(m.content_markdown)) >= 10
`

/**
 * `messages` has no `workspace_id` column, so the workspace filter joins through
 * `streams` (INV-68).
 */
export async function plan(ctx: BackfillContext, workspaceId: string): Promise<MessageEmbeddingChunk[]> {
  const result = await ctx.pool.query<{ id: string }>(composeSql`
    SELECT m.id
    FROM messages m
    JOIN streams s ON s.id = m.stream_id
    WHERE s.workspace_id = ${workspaceId}
      AND ${ELIGIBLE_PREDICATE}
    ORDER BY m.id
  `)
  return chunkIds(result.rows.map((row) => row.id)).map((ids) => ({ ids }))
}

export interface MessageEmbeddingBackfillContext extends BackfillContext {
  embeddingService: EmbeddingServiceLike
}

export async function processChunk(
  ctx: MessageEmbeddingBackfillContext,
  workspaceId: string,
  chunk: MessageEmbeddingChunk
): Promise<{ processed: number }> {
  if (chunk.ids.length === 0) return { processed: 0 }

  const byId = await MessageRepository.findByIds(ctx.pool, chunk.ids)

  // Recheck ELIGIBLE_PREDICATE at process time, workspace-scoped (INV-8): a
  // message that lost eligibility since `plan` (deleted, its stream sealed)
  // is dropped instead of being embedded on a stale assumption.
  const eligible = await ctx.pool.query<{ id: string }>(composeSql`
    SELECT m.id
    FROM messages m
    JOIN streams s ON s.id = m.stream_id
    WHERE s.workspace_id = ${workspaceId}
      AND m.id = ANY(${chunk.ids}::text[])
      AND ${ELIGIBLE_PREDICATE}
  `)
  const eligibleIds = new Set(eligible.rows.map((row) => row.id))
  const messages = chunk.ids
    .map((id) => byId.get(id))
    .filter((message): message is Message => message !== undefined && eligibleIds.has(message.id))

  const storedHashes = await MessageRepository.findEmbeddingSourceHashes(ctx.pool, chunk.ids)
  const withText: Array<{ message: Message; text: string; sourceHash: string; expectedSourceHash: string | null }> = []
  for (const message of messages) {
    const text = await loadMessageEmbeddingText(ctx.pool, workspaceId, message)
    if (text === null) {
      logger.warn(
        { messageId: message.id, streamId: message.streamId },
        "message-embedding-backfill: stream not found, skipping"
      )
      continue
    }
    const sourceHash = hashEmbeddingText(text)
    const expectedSourceHash = storedHashes.get(message.id) ?? null
    if (expectedSourceHash === sourceHash) continue
    withText.push({ message, text, sourceHash, expectedSourceHash })
  }

  let processed = 0
  for (let i = 0; i < withText.length; i += EMBED_SUB_BATCH_SIZE) {
    const sub = withText.slice(i, i + EMBED_SUB_BATCH_SIZE)
    const embeddings = await ctx.embeddingService.embedBatch(
      sub.map((entry) => entry.text),
      { workspaceId, functionId: "message-embedding-backfill" }
    )
    processed += await MessageRepository.updateEmbeddings(
      ctx.pool,
      sub.map((entry, index) => ({
        id: entry.message.id,
        embedding: embeddings[index]!,
        sourceHash: entry.sourceHash,
        expectedSourceHash: entry.expectedSourceHash,
      }))
    )
  }

  return { processed }
}

export function registerMessageEmbeddingBackfill(deps: { embeddingService: EmbeddingServiceLike }): void {
  registerBackfill<MessageEmbeddingChunk>({
    name: "message-embeddings-context",
    plan,
    processChunk: (ctx, workspaceId, chunk) =>
      processChunk({ ...ctx, embeddingService: deps.embeddingService }, workspaceId, chunk),
  })
}
