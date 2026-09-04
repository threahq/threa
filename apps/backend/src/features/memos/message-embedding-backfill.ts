import { AuthorTypes } from "@threa/types"
import { sql } from "../../db"
import { chunkIds, registerBackfill, type BackfillContext } from "../../lib/backfill"
import { logger } from "../../lib/logger"
import { MessageRepository, type Message } from "../messaging"
import type { EmbeddingServiceLike } from "./embedding-service"
import { loadMessageEmbeddingText } from "./message-embedding-text"

export const MESSAGE_EMBEDDING_BACKFILL_NAME = "message-embeddings-context"

/** The embeddings API caps tokens per request, and a chunk can hold up to 500 messages of up to 8k chars each. */
const EMBED_SUB_BATCH_SIZE = 100

export type MessageEmbeddingChunk = { ids: string[] }

/**
 * Same eligibility the live path applies (`EmbeddingHandler` + `createEmbeddingWorker`):
 * non-system, non-deleted, non-sealed, at least 10 chars of content. `messages`
 * has no `workspace_id` column, so the workspace filter joins through `streams` (INV-68).
 */
export async function plan(ctx: BackfillContext, workspaceId: string): Promise<MessageEmbeddingChunk[]> {
  const result = await ctx.pool.query<{ id: string }>(sql`
    SELECT m.id
    FROM messages m
    JOIN streams s ON s.id = m.stream_id
    WHERE s.workspace_id = ${workspaceId}
      AND NOT EXISTS (SELECT 1 FROM e2e_streams e WHERE e.stream_id = s.id)
      AND m.deleted_at IS NULL
      AND m.author_type <> ${AuthorTypes.SYSTEM}
      AND length(btrim(m.content_markdown)) >= 10
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
  const messages = chunk.ids
    .map((id) => byId.get(id))
    .filter((message): message is Message => message !== undefined && !message.deletedAt)

  const withText: Array<{ message: Message; text: string }> = []
  for (const message of messages) {
    try {
      const text = await loadMessageEmbeddingText(ctx.pool, message)
      withText.push({ message, text })
    } catch (error) {
      // The message's stream can vanish between plan and process (e.g. a
      // concurrent delete) — skip it rather than poisoning the whole chunk.
      logger.warn({ messageId: message.id, error }, "message-embedding-backfill: skipping message")
    }
  }

  let processed = 0
  for (let i = 0; i < withText.length; i += EMBED_SUB_BATCH_SIZE) {
    const sub = withText.slice(i, i + EMBED_SUB_BATCH_SIZE)
    const embeddings = await ctx.embeddingService.embedBatch(
      sub.map((entry) => entry.text),
      { workspaceId, functionId: "message-embedding-backfill" }
    )
    await MessageRepository.updateEmbeddings(
      ctx.pool,
      sub.map((entry, index) => ({ id: entry.message.id, embedding: embeddings[index]! }))
    )
    processed += sub.length
  }

  return { processed }
}

export function registerMessageEmbeddingBackfill(deps: { embeddingService: EmbeddingServiceLike }): void {
  registerBackfill<MessageEmbeddingChunk>({
    name: MESSAGE_EMBEDDING_BACKFILL_NAME,
    plan,
    processChunk: (ctx, workspaceId, chunk) =>
      processChunk({ ...ctx, embeddingService: deps.embeddingService }, workspaceId, chunk),
  })
}
