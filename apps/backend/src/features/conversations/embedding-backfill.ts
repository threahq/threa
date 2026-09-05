import { composeSql, sql } from "../../db"
import { chunkIds, registerBackfill, type BackfillContext } from "../../lib/backfill"
import { hashEmbeddingText, type EmbeddingServiceLike } from "../memos"
import { ConversationRepository } from "./repository"
import { loadConversationEmbeddingTexts } from "./embedding-text"

const EMBED_SUB_BATCH_SIZE = 100

export type ConversationEmbeddingChunk = { ids: string[] }

/**
 * SQL twin of `isConversationEmbeddable` plus the sealed-stream exclusion the
 * outbox handler applies. Shared between `plan` and the process-time recheck.
 */
const ELIGIBLE_PREDICATE = sql`
  NOT EXISTS (SELECT 1 FROM e2e_streams e WHERE e.stream_id = c.stream_id)
  AND cardinality(c.message_ids) > 0
  AND (length(btrim(coalesce(c.topic_summary, ''))) > 0 OR length(btrim(coalesce(c.summary, ''))) > 0)
`

export async function plan(ctx: BackfillContext, workspaceId: string): Promise<ConversationEmbeddingChunk[]> {
  const result = await ctx.pool.query<{ id: string }>(composeSql`
    SELECT c.id
    FROM conversations c
    WHERE c.workspace_id = ${workspaceId}
      AND ${ELIGIBLE_PREDICATE}
    ORDER BY c.id
  `)
  return chunkIds(result.rows.map((row) => row.id)).map((ids) => ({ ids }))
}

export interface ConversationEmbeddingBackfillContext extends BackfillContext {
  embeddingService: EmbeddingServiceLike
}

export async function processChunk(
  ctx: ConversationEmbeddingBackfillContext,
  workspaceId: string,
  chunk: ConversationEmbeddingChunk
): Promise<{ processed: number }> {
  if (chunk.ids.length === 0) return { processed: 0 }

  const eligible = await ctx.pool.query<{ id: string }>(composeSql`
    SELECT c.id
    FROM conversations c
    WHERE c.workspace_id = ${workspaceId}
      AND c.id = ANY(${chunk.ids}::text[])
      AND ${ELIGIBLE_PREDICATE}
  `)
  const conversations = await ConversationRepository.findByIds(
    ctx.pool,
    workspaceId,
    eligible.rows.map((row) => row.id)
  )
  const texts = await loadConversationEmbeddingTexts(ctx.pool, conversations)
  const storedHashes = await ConversationRepository.findEmbeddingSourceHashes(
    ctx.pool,
    workspaceId,
    conversations.map((conversation) => conversation.id)
  )

  const pending = conversations.flatMap((conversation) => {
    const text = texts.get(conversation.id) ?? ""
    const sourceHash = hashEmbeddingText(text)
    const expectedSourceHash = storedHashes.get(conversation.id) ?? null
    return expectedSourceHash === sourceHash ? [] : [{ id: conversation.id, text, sourceHash, expectedSourceHash }]
  })

  let processed = 0
  for (let i = 0; i < pending.length; i += EMBED_SUB_BATCH_SIZE) {
    const sub = pending.slice(i, i + EMBED_SUB_BATCH_SIZE)
    const embeddings = await ctx.embeddingService.embedBatch(
      sub.map((entry) => entry.text),
      { workspaceId, functionId: "conversation-embedding-backfill" }
    )
    processed += await ConversationRepository.updateEmbeddings(
      ctx.pool,
      workspaceId,
      sub.map((entry, index) => ({
        id: entry.id,
        embedding: embeddings[index]!,
        sourceHash: entry.sourceHash,
        expectedSourceHash: entry.expectedSourceHash,
      }))
    )
  }

  return { processed }
}

export function registerConversationEmbeddingBackfill(deps: { embeddingService: EmbeddingServiceLike }): void {
  registerBackfill<ConversationEmbeddingChunk>({
    name: "conversation-embeddings",
    plan,
    processChunk: (ctx, workspaceId, chunk) =>
      processChunk({ ...ctx, embeddingService: deps.embeddingService }, workspaceId, chunk),
  })
}
