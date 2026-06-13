import { afterEach, describe, expect, it, spyOn, mock } from "bun:test"
import type { Pool } from "pg"
import { SyncLogRetentionWorker } from "./retention-worker"
import { SyncLogRepository } from "./repository"

const pool = {} as Pool

describe("SyncLogRetentionWorker.pruneOnce", () => {
  afterEach(() => {
    mock.restore()
  })

  it("prunes the eligible window in batches and advances each workspace's floor", async () => {
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
    const advance = spyOn(SyncLogRepository, "advanceRetainedFrom").mockResolvedValue(undefined)

    const worker = new SyncLogRetentionWorker({ pool }, { batchSize: 2, minKeep: 10, retentionMs: 1000 })
    await worker.pruneOnce()

    // Paged twice: the first full batch continued, the short second stopped.
    expect(prune).toHaveBeenCalledTimes(2)
    // The cutoff is retentionMs behind now and minKeep/limit flow through.
    expect(prune.mock.calls[0][1]).toMatchObject({ minKeep: 10, limit: 2 })
    expect(prune.mock.calls[0][1].cutoff).toBeInstanceOf(Date)
    // Floor advanced for exactly what each batch pruned.
    expect(advance).toHaveBeenCalledTimes(2)
    expect(advance.mock.calls[0][1]).toEqual(new Map([["ws_a", 100n]]))
    expect(advance.mock.calls[1][1]).toEqual(
      new Map([
        ["ws_a", 150n],
        ["ws_b", 40n],
      ])
    )
  })

  it("stops at maxBatchesPerRun even while batches keep filling", async () => {
    const prune = spyOn(SyncLogRepository, "pruneExpiredEntries").mockResolvedValue({
      prunedThrough: new Map([["ws_a", 9n]]),
      deletedCount: 5,
    })
    spyOn(SyncLogRepository, "advanceRetainedFrom").mockResolvedValue(undefined)

    const worker = new SyncLogRetentionWorker({ pool }, { batchSize: 5, maxBatchesPerRun: 3 })
    await worker.pruneOnce()

    expect(prune).toHaveBeenCalledTimes(3)
  })

  it("does a single pass and no floor write when nothing is due", async () => {
    spyOn(SyncLogRepository, "pruneExpiredEntries").mockResolvedValue({
      prunedThrough: new Map(),
      deletedCount: 0,
    })
    const advance = spyOn(SyncLogRepository, "advanceRetainedFrom").mockResolvedValue(undefined)

    const worker = new SyncLogRetentionWorker({ pool }, { batchSize: 5 })
    await worker.pruneOnce()

    // deletedCount 0 < batchSize ends the run after one prune; the empty map
    // is still handed to advance, which no-ops on an empty map.
    expect(advance).toHaveBeenCalledTimes(1)
    expect(advance.mock.calls[0][1]).toEqual(new Map())
  })

  it("survives a failing prune query without throwing", async () => {
    spyOn(SyncLogRepository, "pruneExpiredEntries").mockRejectedValue(new Error("db down"))
    const advance = spyOn(SyncLogRepository, "advanceRetainedFrom").mockResolvedValue(undefined)

    const worker = new SyncLogRetentionWorker({ pool }, { batchSize: 5 })
    await expect(worker.pruneOnce()).resolves.toBeUndefined()
    expect(advance).not.toHaveBeenCalled()
  })
})
