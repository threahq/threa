import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import { PerformanceCaptureRepository } from "./repository"
import { PerfCaptureRetentionWorker } from "./retention-worker"

const pool = {} as Pool

describe("PerfCaptureRetentionWorker.pruneOnce", () => {
  afterEach(() => {
    mock.restore()
  })

  it("pages bounded batches until a short batch drains the window", async () => {
    const prune = spyOn(PerformanceCaptureRepository, "pruneOlderThan")
      .mockResolvedValueOnce({ deletedCount: 2 })
      .mockResolvedValueOnce({ deletedCount: 1 })

    const worker = new PerfCaptureRetentionWorker({ pool }, { batchSize: 2 })
    await worker.pruneOnce()

    expect(prune).toHaveBeenCalledTimes(2)
    expect(prune.mock.calls[0][1].limit).toBe(2)
  })

  it("cuts off at now minus the retention horizon", async () => {
    const prune = spyOn(PerformanceCaptureRepository, "pruneOlderThan").mockResolvedValue({ deletedCount: 0 })

    const before = Date.now()
    await new PerfCaptureRetentionWorker({ pool }, { retentionMs: 60_000 }).pruneOnce()
    const after = Date.now()

    const cutoff = prune.mock.calls[0][1].cutoff.getTime()
    expect(cutoff).toBeGreaterThanOrEqual(before - 60_000)
    expect(cutoff).toBeLessThanOrEqual(after - 60_000)
  })

  it("stops at maxBatchesPerRun even while batches keep filling", async () => {
    const prune = spyOn(PerformanceCaptureRepository, "pruneOlderThan").mockResolvedValue({ deletedCount: 5 })

    await new PerfCaptureRetentionWorker({ pool }, { batchSize: 5, maxBatchesPerRun: 3 }).pruneOnce()

    expect(prune).toHaveBeenCalledTimes(3)
  })

  it("does a single pass when nothing is due", async () => {
    const prune = spyOn(PerformanceCaptureRepository, "pruneOlderThan").mockResolvedValue({ deletedCount: 0 })

    await new PerfCaptureRetentionWorker({ pool }, { batchSize: 5 }).pruneOnce()

    expect(prune).toHaveBeenCalledTimes(1)
  })

  it("survives a failing prune and prunes again on the next tick", async () => {
    const prune = spyOn(PerformanceCaptureRepository, "pruneOlderThan")
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue({ deletedCount: 0 })

    const worker = new PerfCaptureRetentionWorker({ pool }, { batchSize: 5 })
    await expect(worker.pruneOnce()).resolves.toBeUndefined()
    await worker.pruneOnce()

    expect(prune).toHaveBeenCalledTimes(2)
  })
})
