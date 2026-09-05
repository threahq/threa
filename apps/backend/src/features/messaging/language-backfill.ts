import { composeSql, sql } from "../../db"
import { chunkIds, registerBackfill, type BackfillContext } from "../../lib/backfill"
import { detectTextLanguage } from "../../lib/text-language"
import { MessageRepository } from "./repository"

export const MESSAGE_LANGUAGE_BACKFILL_NAME = "message-language"

export type MessageLanguageChunk = { ids: string[] }

/**
 * Rows written before `messages.language` existed. `messages` has no
 * `workspace_id`, so the workspace filter joins through `streams` (INV-68).
 */
const MISSING_LANGUAGE_PREDICATE = sql`m.language IS NULL`

export async function plan(ctx: BackfillContext, workspaceId: string): Promise<MessageLanguageChunk[]> {
  const result = await ctx.pool.query<{ id: string }>(composeSql`
    SELECT m.id
    FROM messages m
    JOIN streams s ON s.id = m.stream_id
    WHERE s.workspace_id = ${workspaceId}
      AND ${MISSING_LANGUAGE_PREDICATE}
    ORDER BY m.id
  `)
  return chunkIds(result.rows.map((row) => row.id)).map((ids) => ({ ids }))
}

export async function processChunk(
  ctx: BackfillContext,
  workspaceId: string,
  chunk: MessageLanguageChunk
): Promise<{ processed: number }> {
  if (chunk.ids.length === 0) return { processed: 0 }

  const result = await ctx.pool.query<{ id: string; content_markdown: string }>(composeSql`
    SELECT m.id, m.content_markdown
    FROM messages m
    JOIN streams s ON s.id = m.stream_id
    WHERE s.workspace_id = ${workspaceId}
      AND m.id = ANY(${chunk.ids}::text[])
      AND ${MISSING_LANGUAGE_PREDICATE}
  `)
  const processed = await MessageRepository.fillMissingLanguages(
    ctx.pool,
    result.rows.map((row) => ({ id: row.id, language: detectTextLanguage(row.content_markdown) }))
  )
  return { processed }
}

export function registerMessageLanguageBackfill(): void {
  registerBackfill<MessageLanguageChunk>({ name: MESSAGE_LANGUAGE_BACKFILL_NAME, plan, processChunk })
}
