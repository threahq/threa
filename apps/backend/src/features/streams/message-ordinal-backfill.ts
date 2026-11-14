import { composeSql, withTransaction } from "../../db"
import { chunkIds, registerBackfill, type BackfillContext } from "../../lib/backfill"
import { StreamEventRepository } from "./event-repository"

const STREAM_MESSAGE_ORDINAL_BACKFILL_NAME = "stream-message-ordinal"

type StreamMessageOrdinalChunk = { ids: string[] }

export async function plan(ctx: BackfillContext, workspaceId: string): Promise<StreamMessageOrdinalChunk[]> {
  const result = await ctx.pool.query<{ stream_id: string }>(composeSql`
    SELECT stream_id FROM stream_sequences WHERE workspace_id = ${workspaceId} ORDER BY stream_id
  `)
  return chunkIds(result.rows.map((row) => row.stream_id)).map((ids) => ({ ids }))
}

/**
 * Recounts every stream, not only uncounted ones, so a rerun also heals a
 * count an old-code replica left stale during rollout. One transaction per
 * stream holds a single sequence row and waits on nothing else while holding
 * it, so it can't deadlock with a move, which takes two in its own order.
 */
export async function processChunk(
  ctx: BackfillContext,
  workspaceId: string,
  chunk: StreamMessageOrdinalChunk
): Promise<{ processed: number }> {
  let processed = 0
  for (const streamId of chunk.ids) {
    const changed = await withTransaction(ctx.pool, (client) =>
      StreamEventRepository.recountMessageOrdinal(client, workspaceId, streamId)
    )
    if (changed) processed++
  }
  return { processed }
}

export function registerStreamMessageOrdinalBackfill(): void {
  registerBackfill<StreamMessageOrdinalChunk>({ name: STREAM_MESSAGE_ORDINAL_BACKFILL_NAME, plan, processChunk })
}
