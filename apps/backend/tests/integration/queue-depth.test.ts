import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { QueueRepository } from "../../src/lib/queue"
import { workspaceId } from "../../src/lib/id"
import { ulid } from "ulid"

const SUITE = ulid()
const BUSY = `depth-busy-${SUITE}`
const DRAINED = `depth-drained-${SUITE}`
const DLQ_ONLY = `depth-dlq-only-${SUITE}`

describe("QueueRepository.depthByQueue", () => {
  let pool: Pool
  let testWorkspaceId: string
  let oldestPendingAt: Date

  async function seed(params: {
    queue: string
    processAfter: Date | null
    claimedUntil?: Date | null
    completed?: boolean
    cancelled?: boolean
    dlq?: boolean
  }) {
    await pool.query(
      `INSERT INTO queue_messages (
         id, queue_name, workspace_id, payload, process_after, inserted_at,
         claimed_until, completed_at, cancelled_at, dlq_at
       ) VALUES ($1, $2, $3, '{}'::jsonb, $4, NOW(), $5, $6, $7, $8)`,
      [
        `qm_${ulid()}`,
        params.queue,
        testWorkspaceId,
        params.processAfter,
        params.claimedUntil ?? null,
        params.completed ? new Date() : null,
        params.cancelled ? new Date() : null,
        params.dlq ? new Date() : null,
      ]
    )
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testWorkspaceId = workspaceId()

    const now = Date.now()
    oldestPendingAt = new Date(now - 600_000)

    // BUSY: three claimable rows (due now, due long ago, claim expired) plus
    // every shape that must NOT count as pending.
    await seed({ queue: BUSY, processAfter: new Date(now - 60_000) })
    await seed({ queue: BUSY, processAfter: oldestPendingAt })
    await seed({ queue: BUSY, processAfter: new Date(now - 30_000), claimedUntil: new Date(now - 5_000) })
    await seed({ queue: BUSY, processAfter: new Date(now + 3_600_000) })
    await seed({ queue: BUSY, processAfter: new Date(now - 60_000), claimedUntil: new Date(now + 600_000) })
    // Terminal rows are due in the past on purpose: drop any terminal guard and
    // they become claimable, so each guard is load-bearing in the assertion.
    await seed({ queue: BUSY, processAfter: new Date(now - 120_000), completed: true })
    await seed({ queue: BUSY, processAfter: new Date(now - 120_000), cancelled: true })
    await seed({ queue: BUSY, processAfter: new Date(now - 120_000), dlq: true })
    await seed({ queue: BUSY, processAfter: new Date(now - 120_000), dlq: true })

    // DRAINED: only completed rows, so the queue drops out of the result entirely.
    await seed({ queue: DRAINED, processAfter: new Date(now - 120_000), completed: true })

    // DLQ_ONLY: no active rows, but the DLQ aggregate must still report it.
    await seed({ queue: DLQ_ONLY, processAfter: new Date(now - 120_000), dlq: true })
    await seed({ queue: DLQ_ONLY, processAfter: new Date(now - 120_000), dlq: true })
    await seed({ queue: DLQ_ONLY, processAfter: new Date(now - 120_000), dlq: true })
  })

  afterAll(async () => {
    await pool.query(`DELETE FROM queue_messages WHERE queue_name = ANY($1)`, [[BUSY, DRAINED, DLQ_ONLY]])
    await pool.end()
  })

  test("depthByQueue counts only claimable pending rows", async () => {
    const rows = await QueueRepository.depthByQueue(pool)
    const busy = rows.find((row) => row.queueName === BUSY)

    expect(busy).toEqual({
      queueName: BUSY,
      pending: 3,
      oldestPendingAt,
      dlq: 2,
    })
  })

  test("depthByQueue omits a queue whose rows are all terminal", async () => {
    // Zeroing a queue that vanishes from the sample belongs to QueueDepthSampler
    // (covered by its unit test), not to this query.
    const rows = await QueueRepository.depthByQueue(pool)
    expect(rows.find((row) => row.queueName === DRAINED)).toBeUndefined()
  })

  test("depthByQueue reports a DLQ-only queue with zero pending", async () => {
    const rows = await QueueRepository.depthByQueue(pool)
    const dlqOnly = rows.find((row) => row.queueName === DLQ_ONLY)

    expect(dlqOnly).toEqual({
      queueName: DLQ_ONLY,
      pending: 0,
      oldestPendingAt: null,
      dlq: 3,
    })
  })

  test("depthByQueue returns no row for a queue with no messages at all", async () => {
    const rows = await QueueRepository.depthByQueue(pool)
    expect(rows.find((row) => row.queueName === `depth-absent-${SUITE}`)).toBeUndefined()
  })
})
