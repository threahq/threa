import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test"
import { Pool, type PoolClient } from "pg"
import type { Server } from "socket.io"
import { setupTestDatabase } from "./setup"
import { SyncLogRepository, SyncLogReconciliationWorker } from "../../src/features/sync"

describe("SyncLogReconciliationWorker", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
    await SyncLogRepository.ensureSweepState(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  function uniqueId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`
  }

  function makeWorker() {
    const emits: Array<{ rooms: string | string[]; eventType: string; payload: Record<string, unknown> }> = []
    const io = {
      to: (rooms: string | string[]) => ({
        emit: mock((eventType: string, payload: Record<string, unknown>) => {
          emits.push({ rooms, eventType, payload })
        }),
      }),
    } as unknown as Server
    const worker = new SyncLogReconciliationWorker({ pool, io }, { delayMs: 0, intervalMs: 60_000 })
    return { worker, emits }
  }

  async function insertOutboxEvent(db: Pool | PoolClient, eventType: string, payload: unknown): Promise<bigint> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO outbox (event_type, payload) VALUES ($1, $2) RETURNING id`,
      [eventType, JSON.stringify(payload)]
    )
    return BigInt(result.rows[0].id)
  }

  async function getLogRow(outboxEventId: bigint) {
    const result = await pool.query<{ sync_id: string; groups: string[]; payload: unknown }>(
      `SELECT sync_id, groups, payload FROM sync_log WHERE outbox_event_id = $1`,
      [outboxEventId.toString()]
    )
    return result.rows[0] ?? null
  }

  /** Sweeps until the predicate holds — background transactions can clamp the frozen cutoff for a beat. */
  async function sweepUntil(worker: SyncLogReconciliationWorker, predicate: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
      await worker.sweepOnce()
      if (await predicate()) return
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  test("rescues a committed client-routed event the dispatcher never sequenced", async () => {
    const workspaceId = uniqueId("ws")
    const streamId = uniqueId("stream")
    const { worker, emits } = makeWorker()

    // Committed outbox row with no sync_log entry — exactly what a dispatcher
    // gap-skip or crash leaves behind.
    const outboxEventId = await insertOutboxEvent(pool, "message:created", {
      workspaceId,
      streamId,
      event: { id: "evt_1" },
    })

    await sweepUntil(worker, async () => (await getLogRow(outboxEventId)) !== null)

    const row = await getLogRow(outboxEventId)
    expect(row).not.toBeNull()
    expect(row!.groups).toEqual([`stream:${streamId}`])

    // The rescue also emits — late, but delivered — with the sync id attached.
    const emitted = emits.find((e) => e.eventType === "message:created" && e.payload.workspaceId === workspaceId)
    expect(emitted).toBeDefined()
    expect(emitted!.rooms).toEqual([`ws:${workspaceId}:stream:${streamId}`])
    expect(emitted!.payload.syncId).toBe(row!.sync_id)
  })

  test("ignores bot-scoped events — they live outside the log contract", async () => {
    const workspaceId = uniqueId("ws")
    const { worker } = makeWorker()

    const outboxEventId = await insertOutboxEvent(pool, "bot_invocation:available", {
      workspaceId,
      botId: "bot_1",
      invocationId: "inv_1",
    })

    // Sweep until the window has passed the event (swept_until > its insert).
    await sweepUntil(worker, async () => {
      const sweptUntil = await SyncLogRepository.getSweptUntil(pool)
      const row = await pool.query<{ created_at: Date }>(`SELECT created_at FROM outbox WHERE id = $1`, [
        outboxEventId.toString(),
      ])
      return sweptUntil !== null && sweptUntil > row.rows[0].created_at
    })

    expect(await getLogRow(outboxEventId)).toBeNull()
  })

  test("does not sweep a window an older transaction could still write into", async () => {
    const { worker } = makeWorker()
    const txnClient = await pool.connect()
    try {
      await txnClient.query("BEGIN")
      // The open transaction holds an uncommitted outbox row; its created_at
      // (= transaction start) pins the frozen cutoff below it.
      const workspaceId = uniqueId("ws")
      const streamId = uniqueId("stream")
      const inFlightId = await insertOutboxEvent(txnClient, "message:created", {
        workspaceId,
        streamId,
        event: { id: "evt_inflight" },
      })

      // While the transaction runs, the sweep can't advance past its start.
      await worker.sweepOnce()
      const sweptDuringTxn = await SyncLogRepository.getSweptUntil(pool)
      const txnStart = await txnClient.query<{ xact_start: Date }>(
        `SELECT xact_start FROM pg_stat_activity WHERE pid = pg_backend_pid()`
      )
      expect(sweptDuringTxn!.getTime()).toBeLessThanOrEqual(txnStart.rows[0].xact_start.getTime())

      await txnClient.query("COMMIT")

      // After commit the window unfreezes and the row is rescued.
      await sweepUntil(worker, async () => (await getLogRow(inFlightId)) !== null)
      expect(await getLogRow(inFlightId)).not.toBeNull()
    } finally {
      txnClient.release()
    }
  })
})
