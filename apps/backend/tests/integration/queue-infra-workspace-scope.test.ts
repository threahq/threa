import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { ulid } from "ulid"
import { createBackfillChunkWorker, registerBackfill } from "../../src/lib/backfill"
import { queueId, workspaceId } from "../../src/lib/id"
import { QueueRepository } from "../../src/lib/queue"
import { setupTestDatabase } from "./setup"

describe("Queue infrastructure workspace scope (INV-8)", () => {
  let pool: Pool

  const suffix = ulid().toLowerCase()
  const queueName = `test.queue_infra_scope_${suffix}`
  const backfillName = `test_queue_infra_scope_${suffix}`
  const processedPerChunk = 7

  const wsA = workspaceId()
  const wsB = workspaceId()

  async function seedMessage(wid: string, dueSecondsAgo: number) {
    const now = new Date()
    const message = await QueueRepository.insert(pool, {
      id: queueId(),
      queueName,
      workspaceId: wid,
      payload: {},
      processAfter: new Date(now.getTime() - dueSecondsAgo * 1000),
      insertedAt: now,
    })
    return message.id
  }

  async function seedRun(wid: string) {
    const id = `bfrun_${ulid()}`
    await pool.query(
      `INSERT INTO backfill_runs (id, backfill_name, workspace_id, status, total_chunks) VALUES ($1, $2, $3, 'processing', 1)`,
      [id, backfillName, wid]
    )
    return id
  }

  async function runState(id: string) {
    const result = await pool.query(
      `SELECT status, chunks_completed, items_processed, completed_at IS NOT NULL AS completed FROM backfill_runs WHERE id = $1`,
      [id]
    )
    return result.rows[0]
  }

  async function runChunk(jobWorkspaceId: string, runId: string) {
    const handler = createBackfillChunkWorker({ pool })
    await handler({
      id: "job_scope_test",
      name: "backfill.chunk",
      data: { workspaceId: jobWorkspaceId, backfillName, runId, chunkIndex: 0, chunk: {} },
    })
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    registerBackfill({
      name: backfillName,
      plan: async () => [],
      processChunk: async () => ({ processed: processedPerChunk }),
    })
  })

  afterAll(async () => {
    await pool.query(`DELETE FROM queue_messages WHERE queue_name = $1`, [queueName])
    await pool.query(
      `DELETE FROM backfill_chunks WHERE run_id IN (SELECT id FROM backfill_runs WHERE backfill_name = $1)`,
      [backfillName]
    )
    await pool.query(`DELETE FROM backfill_runs WHERE backfill_name = $1`, [backfillName])
    await pool.end()
  })

  describe("batchClaimMessages", () => {
    test("should claim the calling workspace's message under a limit when another workspace's message is due earlier", async () => {
      const a1 = await seedMessage(wsA, 1)
      const b1 = await seedMessage(wsB, 5)
      const now = new Date()

      const claimed = await QueueRepository.batchClaimMessages(pool, {
        queueName,
        workspaceId: wsA,
        claimedBy: "worker_scope_test",
        claimedAt: now,
        claimedUntil: new Date(now.getTime() + 30_000),
        now,
        limit: 1,
      })

      expect(claimed.map((m) => m.id)).toEqual([a1])
      const states = await pool.query(
        `SELECT id, claimed_by, claimed_count FROM queue_messages WHERE queue_name = $1 ORDER BY claimed_count DESC`,
        [queueName]
      )
      expect(states.rows).toEqual([
        { id: a1, claimed_by: "worker_scope_test", claimed_count: 1 },
        { id: b1, claimed_by: null, claimed_count: 0 },
      ])
    })
  })

  describe("backfill chunk worker", () => {
    test("should advance and complete the run when the job names the run's workspace", async () => {
      const run = await seedRun(wsA)

      await runChunk(wsA, run)

      expect(await runState(run)).toEqual({
        status: "completed",
        chunks_completed: 1,
        items_processed: processedPerChunk,
        completed: true,
      })
    })

    test("should reject and record nothing when the job carries another workspace's id for a run", async () => {
      const owner = workspaceId()
      const other = workspaceId()
      const runA = await seedRun(owner)
      const runB = await seedRun(other)

      await expect(runChunk(other, runA)).rejects.toThrow(`Backfill run ${runA} not found in workspace ${other}`)

      const chunks = await pool.query(`SELECT run_id FROM backfill_chunks WHERE run_id = ANY($1)`, [[runA, runB]])
      expect({ a: await runState(runA), b: await runState(runB), chunks: chunks.rows }).toEqual({
        a: { status: "processing", chunks_completed: 0, items_processed: 0, completed: false },
        b: { status: "processing", chunks_completed: 0, items_processed: 0, completed: false },
        chunks: [],
      })
    })
  })
})
