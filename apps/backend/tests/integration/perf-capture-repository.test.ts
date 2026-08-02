import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupIsolatedTestDatabase } from "./setup"
import { PerformanceCaptureRepository } from "../../src/features/perf-diagnostics"
import { perfCaptureId, userId, workspaceId } from "../../src/lib/id"

const samples = [
  { name: "bootstrap.fetch", at: 1, value: 12 },
  { name: "liveQuery.rerun", at: 2, count: 1 },
]

describe("PerformanceCaptureRepository", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let wsA: string
  let wsB: string
  let user: string

  beforeAll(async () => {
    ;({ pool, cleanup } = await setupIsolatedTestDatabase("perf-capture-repo"))
    wsA = workspaceId()
    wsB = workspaceId()
    user = userId()
  })

  afterAll(async () => {
    await cleanup()
  })

  function insert(overrides: Partial<Parameters<typeof PerformanceCaptureRepository.insert>[1]> = {}) {
    return PerformanceCaptureRepository.insert(pool, {
      id: perfCaptureId(),
      workspaceId: wsA,
      userId: user,
      captureId: "cap_1",
      appVersion: "1.2.3",
      deviceClass: "mid",
      startedAt: "2026-08-02T09:00:00.000Z",
      sampleCount: samples.length,
      byteSize: 128,
      samples,
      ...overrides,
    })
  }

  test("inserts a capture and reads it back", async () => {
    const id = perfCaptureId()
    await insert({ id })

    const rows = await PerformanceCaptureRepository.listForUser(pool, wsA, user, 10)
    const stored = rows.find((row) => row.id === id)
    expect({
      id: stored?.id,
      workspaceId: stored?.workspaceId,
      userId: stored?.userId,
      captureId: stored?.captureId,
      appVersion: stored?.appVersion,
      deviceClass: stored?.deviceClass,
      startedAt: stored?.startedAt,
      sampleCount: stored?.sampleCount,
      byteSize: stored?.byteSize,
      samples: stored?.samples,
    }).toEqual({
      id,
      workspaceId: wsA,
      userId: user,
      captureId: "cap_1",
      appVersion: "1.2.3",
      deviceClass: "mid",
      startedAt: new Date("2026-08-02T09:00:00.000Z"),
      sampleCount: 2,
      byteSize: 128,
      samples,
    })
  })

  test("a second workspace's captures are invisible", async () => {
    const id = perfCaptureId()
    await insert({ id, workspaceId: wsB })

    const rows = await PerformanceCaptureRepository.listForUser(pool, wsA, user, 100)
    expect(rows.map((row) => row.id)).not.toContain(id)
    expect((await PerformanceCaptureRepository.listForUser(pool, wsB, user, 100)).map((row) => row.id)).toContain(id)
  })

  test("pruneOlderThan deletes only rows past the cutoff and reports the count", async () => {
    const pruneWorkspace = workspaceId()
    const old = perfCaptureId()
    const fresh = perfCaptureId()
    await insert({ id: old, workspaceId: pruneWorkspace })
    await insert({ id: fresh, workspaceId: pruneWorkspace })
    // Age one row through the DB's own clock, not a hand-built timestamp.
    await pool.query("UPDATE performance_captures SET created_at = NOW() - INTERVAL '30 days' WHERE id = $1", [old])

    const { deletedCount } = await PerformanceCaptureRepository.pruneOlderThan(pool, {
      cutoff: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
      limit: 100,
    })

    const remaining = (await PerformanceCaptureRepository.listForUser(pool, pruneWorkspace, user, 100)).map((r) => r.id)
    expect({ deletedCount, remaining }).toEqual({ deletedCount: 1, remaining: [fresh] })
  })

  test("pruneOlderThan honours the batch limit", async () => {
    const batchWorkspace = workspaceId()
    for (let i = 0; i < 3; i++) await insert({ workspaceId: batchWorkspace })
    await pool.query(
      "UPDATE performance_captures SET created_at = NOW() - INTERVAL '30 days' WHERE workspace_id = $1",
      [batchWorkspace]
    )

    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    const first = await PerformanceCaptureRepository.pruneOlderThan(pool, { cutoff, limit: 2 })
    const afterFirst = await PerformanceCaptureRepository.listForUser(pool, batchWorkspace, user, 100)
    const second = await PerformanceCaptureRepository.pruneOlderThan(pool, { cutoff, limit: 2 })

    expect({
      firstDeleted: first.deletedCount,
      remainingAfterFirst: afterFirst.length,
      secondDeleted: second.deletedCount,
      remainingAfterSecond: (await PerformanceCaptureRepository.listForUser(pool, batchWorkspace, user, 100)).length,
    }).toEqual({ firstDeleted: 2, remainingAfterFirst: 1, secondDeleted: 1, remainingAfterSecond: 0 })
  })
})
