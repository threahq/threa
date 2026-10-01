import { composeSql, withTransaction } from "../../db"
import { chunkIds, registerBackfill, type BackfillContext } from "../../lib/backfill"
import { publishStreamMessageCount } from "./message-count"
import { StreamRepository } from "./repository"

const STREAM_MESSAGE_COUNT_BACKFILL_NAME = "stream-message-count"

type StreamMessageCountChunk = { ids: string[] }

export async function plan(ctx: BackfillContext, workspaceId: string): Promise<StreamMessageCountChunk[]> {
  const result = await ctx.pool.query<{ id: string }>(composeSql`
    SELECT id FROM streams WHERE workspace_id = ${workspaceId} ORDER BY id
  `)
  return chunkIds(result.rows.map((row) => row.id)).map((ids) => ({ ids }))
}

/**
 * Recounts every stream rather than only uncounted ones, so a rerun also heals
 * drift. One short transaction per stream keeps each row lock brief and never
 * holds two stream locks at once.
 */
export async function processChunk(
  ctx: BackfillContext,
  workspaceId: string,
  chunk: StreamMessageCountChunk
): Promise<{ processed: number }> {
  let processed = 0
  for (const streamId of chunk.ids) {
    await withTransaction(ctx.pool, async (client) => {
      const change = await StreamRepository.recountMessages(client, workspaceId, streamId)
      if (!change) return
      await publishStreamMessageCount(client, change)
      processed++
    })
  }
  return { processed }
}

export function registerStreamMessageCountBackfill(): void {
  registerBackfill<StreamMessageCountChunk>({ name: STREAM_MESSAGE_COUNT_BACKFILL_NAME, plan, processChunk })
}
