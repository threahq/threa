import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import type { Pool } from "pg"
import { QueueRepository, QueueRetentionWorker } from "../../src/lib/queue"
import type { QueueRetentionCategory } from "../../src/lib/queue"
import { setupIsolatedTestDatabase } from "./setup"

const DAY_MS = 24 * 60 * 60 * 1000

const TERMINAL_COLUMN: Record<QueueRetentionCategory, string> = {
  completed: "completed_at",
  cancelled: "cancelled_at",
  dlq: "dlq_at",
}

async function insertTerminal(db: Pool, id: string, category: QueueRetentionCategory, timestamp: Date): Promise<void> {
  await QueueRepository.insert(db, {
    id,
    queueName: "test.queue",
    workspaceId: "ws_retention",
    payload: { id },
    processAfter: timestamp,
    insertedAt: timestamp,
  })
  // Match the production terminal shape: the retention column set, process_after
  // nulled. Retention filters on the terminal column, not process_after.
  await db.query(`UPDATE queue_messages SET ${TERMINAL_COLUMN[category]} = $1, process_after = NULL WHERE id = $2`, [
    timestamp,
    id,
  ])
}

async function insertPending(db: Pool, id: string, processAfter: Date): Promise<void> {
  await QueueRepository.insert(db, {
    id,
    queueName: "test.queue",
    workspaceId: "ws_retention",
    payload: { id },
    processAfter,
    insertedAt: processAfter,
  })
}

async function remainingIds(db: Pool): Promise<string[]> {
  const result = await db.query<{ id: string }>("SELECT id FROM queue_messages ORDER BY id")
  return result.rows.map((r) => r.id)
}

// A private database so the retention deletes (which are intentionally global,
// not workspace-scoped) run against a table only this suite writes to — the
// shared test DB is churned by the preloaded server's queue workers.
describe("QueueRetentionWorker", () => {
  let pool: Pool
  let cleanup: () => Promise<void>

  beforeAll(async () => {
    ;({ pool, cleanup } = await setupIsolatedTestDatabase("queue-retention"))
  })

  afterAll(async () => {
    await cleanup()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM queue_messages")
  })

  describe("config validation", () => {
    test("rejects non-positive numeric config", () => {
      expect(() => new QueueRetentionWorker(pool, { batchSize: 0 })).toThrow(/batchSize must be > 0/)
      expect(() => new QueueRetentionWorker(pool, { completedRetentionMs: -1 })).toThrow(
        /completedRetentionMs must be > 0/
      )
    })
  })

  describe("deleteExpiredMessagesBatch", () => {
    test("deletes past-cutoff terminal rows per category, keeps in-window rows and pending", async () => {
      const now = Date.now()

      await insertTerminal(pool, "queue_ret_completed_old", "completed", new Date(now - 10 * DAY_MS))
      await insertTerminal(pool, "queue_ret_completed_new", "completed", new Date(now - 1 * DAY_MS))
      await insertTerminal(pool, "queue_ret_cancelled_old", "cancelled", new Date(now - 40 * DAY_MS))
      await insertTerminal(pool, "queue_ret_cancelled_new", "cancelled", new Date(now - 1 * DAY_MS))
      await insertTerminal(pool, "queue_ret_dlq_old", "dlq", new Date(now - 100 * DAY_MS))
      await insertTerminal(pool, "queue_ret_dlq_new", "dlq", new Date(now - 1 * DAY_MS))
      // Pending, ancient — must survive every category sweep.
      await insertPending(pool, "queue_ret_pending", new Date(now - 365 * DAY_MS))

      const completedDeleted = await QueueRepository.deleteExpiredMessagesBatch(pool, {
        category: "completed",
        cutoff: new Date(now - 7 * DAY_MS),
        limit: 100,
      })
      const cancelledDeleted = await QueueRepository.deleteExpiredMessagesBatch(pool, {
        category: "cancelled",
        cutoff: new Date(now - 30 * DAY_MS),
        limit: 100,
      })
      const dlqDeleted = await QueueRepository.deleteExpiredMessagesBatch(pool, {
        category: "dlq",
        cutoff: new Date(now - 90 * DAY_MS),
        limit: 100,
      })

      expect({ completedDeleted, cancelledDeleted, dlqDeleted }).toEqual({
        completedDeleted: 1,
        cancelledDeleted: 1,
        dlqDeleted: 1,
      })
      expect(await remainingIds(pool)).toEqual([
        "queue_ret_cancelled_new",
        "queue_ret_completed_new",
        "queue_ret_dlq_new",
        "queue_ret_pending",
      ])
    })

    test("a single call deletes at most `limit` rows", async () => {
      const now = Date.now()
      for (let i = 0; i < 25; i++) {
        await insertTerminal(
          pool,
          `queue_ret_lim_${String(i).padStart(2, "0")}`,
          "completed",
          new Date(now - 10 * DAY_MS)
        )
      }

      const deleted = await QueueRepository.deleteExpiredMessagesBatch(pool, {
        category: "completed",
        cutoff: new Date(now - 7 * DAY_MS),
        limit: 10,
      })

      expect(deleted).toBe(10)
      expect((await remainingIds(pool)).length).toBe(15)
    })
  })

  describe("runOnce", () => {
    test("drains an eligible backlog larger than batchSize across batches, leaving pending and in-window rows", async () => {
      const now = Date.now()
      for (let i = 0; i < 25; i++) {
        await insertTerminal(
          pool,
          `queue_ret_run_${String(i).padStart(2, "0")}`,
          "completed",
          new Date(now - 10 * DAY_MS)
        )
      }
      await insertTerminal(pool, "queue_ret_run_recent", "completed", new Date(now - 1 * DAY_MS))
      await insertPending(pool, "queue_ret_run_pending", new Date(now - 365 * DAY_MS))

      const worker = new QueueRetentionWorker(pool, {
        completedRetentionMs: 7 * DAY_MS,
        batchSize: 10,
        maxBatchesPerRun: 20,
      })

      await worker.runOnce()

      expect(await remainingIds(pool)).toEqual(["queue_ret_run_pending", "queue_ret_run_recent"])
    })
  })
})
