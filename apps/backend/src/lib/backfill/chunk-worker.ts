import type { Pool } from "pg"
import { sql, withTransaction } from "../../db"
import { logger } from "../logger"
import type { BackfillChunkJobData, JobHandler } from "../queue"
import { getBackfill } from "./registry"

export interface BackfillChunkWorkerDeps {
  pool: Pool
}

/**
 * Processes one backfill chunk via the named definition's `processChunk`, then
 * records it against `backfill_chunks` for exactly-once accounting.
 *
 * `processChunk` is idempotent, so re-running it on redelivery is safe. The
 * run counters advance only when the `backfill_chunks` INSERT actually inserts
 * (rowCount === 1) — a redelivered chunk whose row already exists is a no-op
 * for the counters, so totals never double-count.
 */
export function createBackfillChunkWorker(deps: BackfillChunkWorkerDeps): JobHandler<BackfillChunkJobData> {
  const { pool } = deps

  return async (job) => {
    const { workspaceId, backfillName, runId, chunkIndex, chunk } = job.data
    const def = getBackfill(backfillName)
    if (!def) {
      throw new Error(`Unknown backfill: ${backfillName}`)
    }

    const { processed } = await def.processChunk({ pool }, workspaceId, chunk)

    await withTransaction(pool, async (client) => {
      const insertResult = await client.query(
        sql`
          INSERT INTO backfill_chunks (run_id, chunk_index, processed)
          VALUES (${runId}, ${chunkIndex}, ${processed})
          ON CONFLICT DO NOTHING
        `
      )

      if ((insertResult.rowCount ?? 0) !== 1) {
        return
      }

      await client.query(
        sql`
          UPDATE backfill_runs
          SET
            chunks_completed = chunks_completed + 1,
            items_processed = items_processed + ${processed},
            status = CASE WHEN chunks_completed + 1 >= total_chunks THEN 'completed' ELSE status END,
            completed_at = CASE WHEN chunks_completed + 1 >= total_chunks THEN now() ELSE completed_at END,
            updated_at = now()
          WHERE id = ${runId}
        `
      )
    })

    logger.info({ jobId: job.id, backfillName, workspaceId, runId, chunkIndex, processed }, "Backfill chunk processed")
  }
}
