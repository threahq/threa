import type { Pool } from "pg"
import { ulid } from "ulid"
import { sql, withTransaction } from "../../db"
import { logger } from "../logger"
import type { BackfillPlanJobData, JobHandler } from "../queue"
import { JobQueues, QueueRepository } from "../queue"
import { getBackfill } from "./registry"

export interface BackfillPlanWorkerDeps {
  pool: Pool
}

/**
 * Runs a named backfill's `plan`, records/refreshes its `backfill_runs` row,
 * and fans out one `backfill.chunk` job per chunk descriptor.
 *
 * Re-plan is idempotent: the run row upserts on (backfill_name, workspace_id)
 * and chunk job ids are deterministic (`qbf_<runId>_<i>`), so re-enqueue hits
 * the queue PK and dedupes rather than double-dispatching.
 */
export function createBackfillPlanWorker(deps: BackfillPlanWorkerDeps): JobHandler<BackfillPlanJobData> {
  const { pool } = deps

  return async (job) => {
    const { workspaceId, backfillName, params } = job.data
    const def = getBackfill(backfillName)
    if (!def) {
      throw new Error(`Unknown backfill: ${backfillName}`)
    }

    const chunks = await def.plan({ pool }, workspaceId, params)

    await withTransaction(pool, async (client) => {
      const empty = chunks.length === 0
      const status = empty ? "completed" : "processing"
      const completedAt = empty ? new Date() : null
      const runResult = await client.query<{ id: string }>(
        sql`
          INSERT INTO backfill_runs (id, backfill_name, workspace_id, status, total_chunks, params, completed_at)
          VALUES (
            ${`bfrun_${ulid()}`},
            ${backfillName},
            ${workspaceId},
            ${status},
            ${chunks.length},
            ${params === undefined ? null : JSON.stringify(params)},
            ${completedAt}
          )
          ON CONFLICT (backfill_name, workspace_id) DO UPDATE SET
            status = EXCLUDED.status,
            total_chunks = EXCLUDED.total_chunks,
            completed_at = EXCLUDED.completed_at,
            updated_at = now()
          RETURNING id
        `
      )
      const runId = runResult.rows[0].id

      if (chunks.length === 0) {
        logger.info({ jobId: job.id, backfillName, workspaceId, runId }, "Backfill plan produced no chunks")
        return
      }

      const now = new Date()
      await QueueRepository.batchInsert(
        client,
        chunks.map((chunk, chunkIndex) => ({
          id: `qbf_${runId}_${chunkIndex}`,
          queueName: JobQueues.BACKFILL_CHUNK,
          workspaceId,
          payload: { workspaceId, backfillName, runId, chunkIndex, chunk },
          processAfter: now,
          insertedAt: now,
        }))
      )

      logger.info(
        { jobId: job.id, backfillName, workspaceId, runId, totalChunks: chunks.length },
        "Backfill plan fanned out chunk jobs"
      )
    })
  }
}
