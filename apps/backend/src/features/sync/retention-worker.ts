import type { Pool } from "pg"
import { Ticker } from "@threahq/backend-common"
import { logger } from "../../lib/logger"
import { SyncLogRepository } from "./repository"

export interface SyncLogRetentionWorkerConfig {
  intervalMs?: number
  /** Entries older than this are eligible for pruning (default 30 days). */
  retentionMs?: number
  /** Most recent entries to keep per workspace even past the horizon. */
  minKeep?: number
  batchSize?: number
  maxBatchesPerRun?: number
}

const DEFAULT_CONFIG = {
  intervalMs: 3_600_000, // hourly — retention is slow-moving, not latency-bound
  retentionMs: 2_592_000_000, // 30 days
  minKeep: 2_000,
  batchSize: 5_000,
  maxBatchesPerRun: 50,
}

/**
 * Bounds sync_log growth: each tick prunes entries older than the retention
 * horizon, while always keeping at least `minKeep` of the most recent entries
 * per workspace so a quiet workspace's returning client still catches up from
 * the log instead of forcing a full bootstrap.
 *
 * Pruning advances a per-workspace `retained_from` floor; catch-up compares a
 * client's cursor against it and signals `requiresBootstrap` when the cursor
 * predates the pruned span (SyncService.catchUp).
 *
 * No leader election: the prune is a single set-based, idempotent DELETE and
 * the floor advances with GREATEST, so running on every backend instance is
 * safe — after one instance prunes a window, the others find nothing due. Same
 * posture as the reconciliation sweep.
 */
export class SyncLogRetentionWorker {
  private readonly pool: Pool
  private readonly config: Required<SyncLogRetentionWorkerConfig>
  private readonly ticker: Ticker

  constructor(deps: { pool: Pool }, config?: SyncLogRetentionWorkerConfig) {
    this.pool = deps.pool
    // Per-field ?? (not spread): callers pass `undefined` for unset env
    // overrides, and an undefined retentionMs/minKeep would prune far more
    // aggressively than intended.
    this.config = {
      intervalMs: config?.intervalMs ?? DEFAULT_CONFIG.intervalMs,
      retentionMs: config?.retentionMs ?? DEFAULT_CONFIG.retentionMs,
      minKeep: config?.minKeep ?? DEFAULT_CONFIG.minKeep,
      batchSize: config?.batchSize ?? DEFAULT_CONFIG.batchSize,
      maxBatchesPerRun: config?.maxBatchesPerRun ?? DEFAULT_CONFIG.maxBatchesPerRun,
    }
    this.ticker = new Ticker({
      name: "sync-log-retention",
      intervalMs: this.config.intervalMs,
      maxConcurrency: 1,
    })
  }

  start(): void {
    this.ticker.start(() => this.pruneOnce())
    logger.info({ ...this.config }, "SyncLogRetentionWorker started")
  }

  async stop(): Promise<void> {
    this.ticker.stop()
    await this.ticker.drain()
    logger.info("SyncLogRetentionWorker stopped")
  }

  async pruneOnce(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - this.config.retentionMs)
      let batches = 0
      let totalPruned = 0
      const workspacesTouched = new Set<string>()

      while (batches < this.config.maxBatchesPerRun) {
        // pruneExpiredEntries deletes the batch AND advances each touched
        // workspace's retention floor in one atomic statement (see its doc) —
        // catch-up must never replay a deleted span.
        const { prunedThrough, deletedCount } = await SyncLogRepository.pruneExpiredEntries(this.pool, {
          cutoff,
          minKeep: this.config.minKeep,
          limit: this.config.batchSize,
        })

        for (const workspaceId of prunedThrough.keys()) {
          workspacesTouched.add(workspaceId)
        }
        totalPruned += deletedCount
        batches += 1

        // A short batch means the window is drained. Pruned rows drop out of the
        // next pass, so a partial run is retried next tick, never skipped.
        if (deletedCount < this.config.batchSize) {
          break
        }
      }

      if (totalPruned > 0) {
        logger.info(
          { pruned: totalPruned, workspaces: workspacesTouched.size, batches, cutoff },
          "sync-log retention pruned expired entries"
        )
      }
    } catch (err) {
      // Next tick retries; the table grows a little longer, nothing breaks.
      logger.error({ err }, "sync-log retention prune failed")
    }
  }
}
