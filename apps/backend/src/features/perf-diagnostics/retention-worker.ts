import type { Pool } from "pg"
import { Ticker } from "@threa/backend-common"
import { logger } from "../../lib/logger"
import { PerformanceCaptureRepository } from "./repository"

export interface PerfCaptureRetentionWorkerConfig {
  intervalMs?: number
  /** Captures older than this are deleted (default 14 days). */
  retentionMs?: number
  batchSize?: number
  maxBatchesPerRun?: number
}

const DEFAULT_CONFIG = {
  intervalMs: 3_600_000,
  retentionMs: 1_209_600_000, // 14 days
  batchSize: 1_000,
  maxBatchesPerRun: 50,
}

/**
 * Bounds `performance_captures`: diagnostic evidence is only useful while the
 * problem it describes is live, so every row leaves after the retention
 * horizon whether or not anyone read it.
 *
 * No leader election: the prune is a bounded, idempotent DELETE, so running on
 * every backend instance is safe — after one drains a window the others find
 * nothing due. Same posture as the sync-log retention sweep.
 */
export class PerfCaptureRetentionWorker {
  private readonly pool: Pool
  private readonly config: Required<PerfCaptureRetentionWorkerConfig>
  private readonly ticker: Ticker

  constructor(deps: { pool: Pool }, config?: PerfCaptureRetentionWorkerConfig) {
    this.pool = deps.pool
    // Per-field ?? (not spread): callers pass `undefined` for unset env
    // overrides, and an undefined retentionMs would prune everything.
    this.config = {
      intervalMs: config?.intervalMs ?? DEFAULT_CONFIG.intervalMs,
      retentionMs: config?.retentionMs ?? DEFAULT_CONFIG.retentionMs,
      batchSize: config?.batchSize ?? DEFAULT_CONFIG.batchSize,
      maxBatchesPerRun: config?.maxBatchesPerRun ?? DEFAULT_CONFIG.maxBatchesPerRun,
    }
    this.ticker = new Ticker({
      name: "perf-capture-retention",
      intervalMs: this.config.intervalMs,
      maxConcurrency: 1,
    })
  }

  start(): void {
    this.ticker.start(() => this.pruneOnce())
    logger.info({ ...this.config }, "PerfCaptureRetentionWorker started")
  }

  async stop(): Promise<void> {
    this.ticker.stop()
    await this.ticker.drain()
    logger.info("PerfCaptureRetentionWorker stopped")
  }

  async pruneOnce(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - this.config.retentionMs)
      let batches = 0
      let totalPruned = 0

      while (batches < this.config.maxBatchesPerRun) {
        const { deletedCount } = await PerformanceCaptureRepository.pruneOlderThan(this.pool, {
          cutoff,
          limit: this.config.batchSize,
        })
        totalPruned += deletedCount
        batches += 1

        // A short batch means the window is drained; a partial run is retried
        // next tick, never skipped.
        if (deletedCount < this.config.batchSize) break
      }

      if (totalPruned > 0) {
        logger.info({ pruned: totalPruned, batches, cutoff }, "performance-capture retention pruned expired captures")
      }
    } catch (err) {
      // Next tick retries; the table grows a little longer, nothing breaks.
      logger.error({ err }, "performance-capture retention prune failed")
    }
  }
}
