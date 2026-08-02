import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupIsolatedTestDatabase } from "./setup"
import { PerfCaptureRetentionWorker, PerformanceCaptureRepository } from "../../src/features/perf-diagnostics"
import { perfCaptureId, userId, workspaceId } from "../../src/lib/id"

describe("PerfCaptureRetentionWorker sweep", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  const ws = workspaceId()
  const user = userId()

  beforeAll(async () => {
    ;({ pool, cleanup } = await setupIsolatedTestDatabase("perf-capture-retention"))
  })

  afterAll(async () => {
    await cleanup()
  })

  test("a full sweep drains a multi-batch backlog and a second run deletes nothing", async () => {
    for (let i = 0; i < 7; i++) {
      await PerformanceCaptureRepository.insert(pool, {
        id: perfCaptureId(),
        workspaceId: ws,
        userId: user,
        captureId: `cap_${i}`,
        appVersion: "1.2.3",
        deviceClass: "low",
        startedAt: "2026-07-01T09:00:00.000Z",
        sampleCount: 1,
        byteSize: 64,
        samples: [{ name: "observer.longTask", at: i, value: 90 }],
      })
    }
    // Age all but one past the 14-day horizon, through the DB's own clock.
    await pool.query(`
      UPDATE performance_captures
      SET created_at = NOW() - INTERVAL '30 days'
      WHERE id <> (SELECT id FROM performance_captures ORDER BY capture_id LIMIT 1)
    `)

    const worker = new PerfCaptureRetentionWorker({ pool }, { batchSize: 2 })
    await worker.pruneOnce()
    const remaining = await PerformanceCaptureRepository.listForUser(pool, ws, user, 100)

    await worker.pruneOnce()
    const afterSecondRun = await PerformanceCaptureRepository.listForUser(pool, ws, user, 100)

    expect({
      remaining: remaining.map((row) => row.captureId),
      afterSecondRun: afterSecondRun.map((row) => row.captureId),
    }).toEqual({ remaining: ["cap_0"], afterSecondRun: ["cap_0"] })
  })
})
