import { composeSql } from "../../db"
import { chunkIds, registerBackfill, type BackfillContext } from "../../lib/backfill"
import { detectSearchConfig } from "../../lib/text-search-config"
import { MessageRepository } from "./repository"

export const MESSAGE_SEARCH_CONFIG_BACKFILL_NAME = "message-search-config"

export type MessageSearchConfigChunk = { ids: string[] }

export async function plan(ctx: BackfillContext, workspaceId: string): Promise<MessageSearchConfigChunk[]> {
  const result = await ctx.pool.query<{ id: string }>(composeSql`
    SELECT m.id
    FROM messages m
    JOIN streams s ON s.id = m.stream_id
    WHERE s.workspace_id = ${workspaceId} AND m.search_config IS NULL
    ORDER BY m.id
  `)
  return chunkIds(result.rows.map((row) => row.id)).map((ids) => ({ ids }))
}

export async function processChunk(
  ctx: BackfillContext,
  workspaceId: string,
  chunk: MessageSearchConfigChunk
): Promise<{ processed: number }> {
  if (chunk.ids.length === 0) return { processed: 0 }

  const result = await ctx.pool.query<{ id: string; content_markdown: string }>(composeSql`
    SELECT m.id, m.content_markdown
    FROM messages m
    JOIN streams s ON s.id = m.stream_id
    WHERE s.workspace_id = ${workspaceId} AND m.id = ANY(${chunk.ids}::text[]) AND m.search_config IS NULL
  `)
  const processed = await MessageRepository.fillMissingSearchConfigs(
    ctx.pool,
    result.rows.map((row) => ({ id: row.id, searchConfig: detectSearchConfig(row.content_markdown) }))
  )
  return { processed }
}

export function registerMessageSearchConfigBackfill(): void {
  registerBackfill<MessageSearchConfigChunk>({ name: MESSAGE_SEARCH_CONFIG_BACKFILL_NAME, plan, processChunk })
}
