import type { Pool } from "pg"
import type { PushService } from "../../src/features/push"
import { JobQueues, type PushDeliverJobData, type PushSessionExpiredJobData } from "../../src/lib/queue"

export interface PushJobRow {
  id: string
  queueName: string
  payload: Record<string, unknown>
  processAfter: Date
  completedAt: Date | null
  deadLettered: boolean
}

/** Every push job for the workspace, oldest first. */
export async function listPushJobs(pool: Pool, workspaceId: string): Promise<PushJobRow[]> {
  const result = await pool.query<{
    id: string
    queue_name: string
    payload: Record<string, unknown>
    process_after: Date
    completed_at: Date | null
    dead_lettered: boolean
  }>(
    `SELECT id, queue_name, payload, process_after, completed_at, dlq_at IS NOT NULL AS dead_lettered FROM queue_messages
     WHERE workspace_id = $1 AND queue_name = ANY($2::text[])
     ORDER BY inserted_at, id`,
    [workspaceId, [JobQueues.PUSH_DELIVER, JobQueues.PUSH_SESSION_EXPIRED]]
  )
  return result.rows.map((row) => ({
    id: row.id,
    queueName: row.queue_name,
    payload: row.payload,
    processAfter: row.process_after,
    completedAt: row.completed_at,
    deadLettered: row.dead_lettered,
  }))
}

/**
 * Run one push job the way the queue manager does: the handler, then complete
 * the message only if it returned. A throw leaves the message open and is
 * rethrown so the test can assert on it.
 */
export async function runPushJob(pool: Pool, service: PushService, job: PushJobRow): Promise<void> {
  if (job.queueName === JobQueues.PUSH_DELIVER) {
    await service.attemptDelivery(job.payload as unknown as PushDeliverJobData)
  } else {
    await service.deliverSessionExpired(job.payload as unknown as PushSessionExpiredJobData)
  }
  await pool.query(`UPDATE queue_messages SET completed_at = NOW() WHERE id = $1`, [job.id])
}

/** Drain every due, open push job for the workspace (including jobs the drained ones enqueue that are already due). */
export async function drainDuePushJobs(pool: Pool, service: PushService, workspaceId: string): Promise<void> {
  for (let round = 0; round < 20; round++) {
    const due = (await listPushJobs(pool, workspaceId)).filter(
      (job) => job.completedAt === null && !job.deadLettered && job.processAfter.getTime() <= Date.now()
    )
    if (due.length === 0) return
    for (const job of due) await runPushJob(pool, service, job)
  }
  throw new Error("push jobs kept re-enqueueing due work")
}

/** Time-travel a delivery: its lease and scheduled retry lapse, and its open jobs become due. */
export async function makeDeliveryDue(pool: Pool, deliveryId: string): Promise<void> {
  await pool.query(
    `UPDATE push_deliveries SET
       lease_expires_at = CASE WHEN lease_expires_at IS NULL THEN NULL ELSE NOW() - INTERVAL '1 second' END,
       next_attempt_at = CASE WHEN next_attempt_at IS NULL THEN NULL ELSE NOW() - INTERVAL '1 second' END
     WHERE id = $1`,
    [deliveryId]
  )
  await pool.query(
    `UPDATE queue_messages SET process_after = NOW() - INTERVAL '1 second'
     WHERE payload->>'deliveryId' = $1 AND completed_at IS NULL`,
    [deliveryId]
  )
}
