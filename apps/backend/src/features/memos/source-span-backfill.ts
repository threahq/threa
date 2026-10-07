import { composeSql } from "../../db"
import { chunkIds, registerBackfill, type BackfillContext } from "../../lib/backfill"

const MEMO_SOURCE_SPAN_BACKFILL_NAME = "memo-source-span"

type MemoSourceSpanChunk = { ids: string[] }

/** Memos written before the span columns existed. */
export async function plan(ctx: BackfillContext, workspaceId: string): Promise<MemoSourceSpanChunk[]> {
  const result = await ctx.pool.query<{ id: string }>(composeSql`
    SELECT id FROM memos WHERE workspace_id = ${workspaceId} AND latest_source_at IS NULL ORDER BY id
  `)
  return chunkIds(result.rows.map((row) => row.id)).map((ids) => ({ ids }))
}

/**
 * Fills each memo's span from its sources' post times, as `MemoRepository.insert`
 * does. A memo none of whose sources resolve stays null, and a row filled in the
 * meantime is left alone, so a redelivered chunk changes nothing.
 */
export async function processChunk(
  ctx: BackfillContext,
  workspaceId: string,
  chunk: MemoSourceSpanChunk
): Promise<{ processed: number }> {
  if (chunk.ids.length === 0) return { processed: 0 }
  const result = await ctx.pool.query(composeSql`
    UPDATE memos m
    SET earliest_source_at = span.earliest, latest_source_at = span.latest
    FROM (
      SELECT m2.id, min(msg.created_at) AS earliest, max(msg.created_at) AS latest
      FROM memos m2
      JOIN messages msg ON msg.workspace_id = m2.workspace_id
        AND msg.id = ANY(array_append(m2.source_message_ids, m2.source_message_id))
      WHERE m2.workspace_id = ${workspaceId} AND m2.id = ANY(${chunk.ids}::text[]) AND m2.latest_source_at IS NULL
      GROUP BY m2.id
    ) span
    WHERE m.workspace_id = ${workspaceId} AND m.id = span.id AND m.latest_source_at IS NULL
  `)
  return { processed: result.rowCount ?? 0 }
}

export function registerMemoSourceSpanBackfill(): void {
  registerBackfill<MemoSourceSpanChunk>({ name: MEMO_SOURCE_SPAN_BACKFILL_NAME, plan, processChunk })
}
