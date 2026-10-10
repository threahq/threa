import { composeSql, withTransaction } from "../../db"
import { chunkIds, registerBackfill, type BackfillContext } from "../../lib/backfill"
import { MessageRepository } from "../messaging"
import { retireMemosCitingDeletedMessage } from "./accumulator-outbox-handler"

const MEMO_DELETED_SOURCES_BACKFILL_NAME = "memo-deleted-sources"

type MemoDeletedSourcesChunk = { ids: string[] }

/**
 * Deleted messages that active memos still cite, from before deletes retired
 * them. Copy streams are skipped, as on the live path: their host retires the
 * memos and the partner's pull withdraws the copies.
 */
export async function plan(ctx: BackfillContext, workspaceId: string): Promise<MemoDeletedSourcesChunk[]> {
  const result = await ctx.pool.query<{ id: string }>(composeSql`
    SELECT DISTINCT msg.id
    FROM memos m
    JOIN messages msg ON msg.id = ANY(m.source_message_ids) AND msg.workspace_id = m.workspace_id
    JOIN streams s ON s.id = msg.stream_id AND s.workspace_id = m.workspace_id
    WHERE m.workspace_id = ${workspaceId} AND m.status = 'active' AND msg.deleted_at IS NOT NULL
      AND s.origin_workspace_id IS NULL
    ORDER BY msg.id
  `)
  return chunkIds(result.rows.map((row) => row.id)).map((ids) => ({ ids }))
}

/**
 * Applies the delete path's retirement to each message. Conversations are
 * requeued only when a memo was retired, so a redelivered chunk finds nothing
 * left to retire and does no work.
 */
export async function processChunk(
  ctx: BackfillContext,
  workspaceId: string,
  chunk: MemoDeletedSourcesChunk
): Promise<{ processed: number }> {
  const messages = await MessageRepository.findByIds(ctx.pool, workspaceId, chunk.ids)
  let processed = 0
  for (const message of messages.values()) {
    await withTransaction(ctx.pool, async (client) => {
      processed += await retireMemosCitingDeletedMessage(client, workspaceId, message.streamId, message.id)
    })
  }
  return { processed }
}

export function registerMemoDeletedSourcesBackfill(): void {
  registerBackfill<MemoDeletedSourcesChunk>({ name: MEMO_DELETED_SOURCES_BACKFILL_NAME, plan, processChunk })
}
