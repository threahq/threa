import type { Pool } from "pg"
import { createPushDeliverWorker, type PushService } from "../../src/features/push"
import {
  JobQueues,
  QueueRepository,
  type PushDeliverJobData,
  type PushSessionExpiredJobData,
  type QueueClaim,
} from "../../src/lib/queue"
import { workerId } from "../../src/lib/id"

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
 * Claim one open job the way the queue manager does: a fresh worker id, the
 * claim count moved on, a claim that lasts `claimMs` (long by default: the
 * manager keeps renewing a live run's claim, however slow its reads). Null
 * while another claim is live or the job finished.
 */
export async function claimPushJob(pool: Pool, jobId: string, claimMs = 60 * 60_000): Promise<QueueClaim | null> {
  const claimedBy = workerId()
  const result = await pool.query<{ claimed_count: number }>(
    `UPDATE queue_messages SET
       claimed_by = $2, claimed_at = NOW(), claimed_until = NOW() + ($3 * INTERVAL '1 millisecond'),
       claimed_count = claimed_count + 1
     WHERE id = $1 AND completed_at IS NULL AND cancelled_at IS NULL AND dlq_at IS NULL
       AND process_after <= NOW()
       AND (claimed_until IS NULL OR claimed_until < NOW())
     RETURNING claimed_count`,
    [jobId, claimedBy, claimMs]
  )
  const row = result.rows[0]
  return row ? { messageId: jobId, claimedBy, claimedCount: row.claimed_count } : null
}

/** Run a `push.deliver` job's handler under `claim`, as the queue manager dispatches it. */
export function runPushDeliverUnder(service: PushService, job: PushJobRow, claim: QueueClaim): Promise<void> {
  const handler = createPushDeliverWorker({ pushService: service })
  return handler({ id: job.id, name: job.queueName, data: job.payload as unknown as PushDeliverJobData, claim })
}

/**
 * Run one push job the way the queue manager does: claim it, run the handler,
 * then complete the message if it returned. A throw records the failure (the
 * claim is released and the job is due again) and is rethrown.
 */
export async function runPushJob(pool: Pool, service: PushService, job: PushJobRow): Promise<void> {
  if (job.queueName !== JobQueues.PUSH_DELIVER) {
    await service.deliverSessionExpired(job.payload as unknown as PushSessionExpiredJobData)
    await pool.query(`UPDATE queue_messages SET completed_at = NOW() WHERE id = $1`, [job.id])
    return
  }
  const claim = await claimPushJob(pool, job.id)
  if (!claim) throw new Error(`push job ${job.id} is claimed or finished`)
  try {
    await runPushDeliverUnder(service, job, claim)
  } catch (err) {
    await QueueRepository.fail(pool, {
      messageId: job.id,
      claimedBy: claim.claimedBy,
      error: String(err),
      processAfter: new Date(),
      now: new Date(),
    })
    throw err
  }
  await QueueRepository.complete(pool, { messageId: job.id, claimedBy: claim.claimedBy, completedAt: new Date() })
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

/** Time-travel a delivery: its scheduled retry and any queue claim lapse, and its open jobs become due. */
export async function makeDeliveryDue(pool: Pool, deliveryId: string): Promise<void> {
  await pool.query(
    `UPDATE push_deliveries SET
       next_attempt_at = CASE WHEN next_attempt_at IS NULL THEN NULL ELSE NOW() - INTERVAL '1 second' END
     WHERE id = $1`,
    [deliveryId]
  )
  await pool.query(
    `UPDATE queue_messages SET
       process_after = NOW() - INTERVAL '1 second',
       claimed_until = CASE WHEN claimed_until IS NULL THEN NULL ELSE NOW() - INTERVAL '1 second' END
     WHERE payload->>'deliveryId' = $1 AND completed_at IS NULL`,
    [deliveryId]
  )
}
