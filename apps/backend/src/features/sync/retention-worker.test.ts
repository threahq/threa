import { afterEach, describe, expect, it, spyOn, mock } from "bun:test"
import type { Pool } from "pg"
import { SyncLogRetentionWorker } from "./retention-worker"
import { SyncLogRepository } from "./repository"

const pool = {} as Pool

describe("SyncLogRetentionWorker.pruneOnce", () => {
  afterEach(() => {
    mock.restore()
  })

  it("pages bounded batches until a short batch drains the eligible window", async () => {
    // First batch fills the limit (more may remain), second drains it.
    const prune = spyOn(SyncLogRepository, "pruneExpiredEntries")
      .mockResolvedValueOnce({ prunedThrough: new Map([["ws_a", 100n]]), deletedCount: 2 })
      .mockResolvedValueOnce({
        prunedThrough: new Map([
          ["ws_a", 150n],
          ["ws_b", 40n],
        ]),
        deletedCount: 1,
      })

    const worker = new SyncLogRetentionWorker({ pool }, { batchSize: 2, minKeep: 10, retentionMs: 1000 })
    await worker.pruneOnce()

    // Paged twice: the first full batch continued, the short second stopped.
    expect(prune).toHaveBeenCalledTimes(2)
    // The cutoff is retentionMs behind now and minKeep/limit flow through.
    expect(prune.mock.calls[0][1]).toMatchObject({ minKeep: 10, limit: 2 })
    expect(prune.mock.calls[0][1].cutoff).toBeInstanceOf(Date)
  })

  it("stops at maxBatchesPerRun even while batches keep filling", async () => {
    const prune = spyOn(SyncLogRepository, "pruneExpiredEntries").mockResolvedValue({
      prunedThrough: new Map([["ws_a", 9n]]),
      deletedCount: 5,
    })

    const worker = new SyncLogRetentionWorker({ pool }, { batchSize: 5, maxBatchesPerRun: 3 })
    await worker.pruneOnce()

    expect(prune).toHaveBeenCalledTimes(3)
  })

  it("does a single pass when nothing is due", async () => {
    const prune = spyOn(SyncLogRepository, "pruneExpiredEntries").mockResolvedValue({
      prunedThrough: new Map(),
      deletedCount: 0,
    })

    const worker = new SyncLogRetentionWorker({ pool }, { batchSize: 5 })
    await worker.pruneOnce()

    // deletedCount 0 < batchSize ends the run after one prune.
    expect(prune).toHaveBeenCalledTimes(1)
  })

  it("survives a failing prune query without throwing", async () => {
    spyOn(SyncLogRepository, "pruneExpiredEntries").mockRejectedValue(new Error("db down"))

    const worker = new SyncLogRetentionWorker({ pool }, { batchSize: 5 })
    await expect(worker.pruneOnce()).resolves.toBeUndefined()
  })
})
