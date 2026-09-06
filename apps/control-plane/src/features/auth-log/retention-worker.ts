import type { Pool } from "pg"
import { Ticker, logger } from "@threahq/backend-common"
import { AuthLogRepository } from "./repository"

export interface AuthLogRetentionWorkerConfig {
  intervalMs: number
  retentionMs: number
  batchSize: number
  maxBatchesPerRun: number
}

const DEFAULT_CONFIG: AuthLogRetentionWorkerConfig = {
  intervalMs: 6 * 60 * 60 * 1000,
  // 13 months (confirmed §10 decision 1). Approximated as 396 days.
  retentionMs: 396 * 24 * 60 * 60 * 1000,
  batchSize: 1000,
  maxBatchesPerRun: 10,
}

/**
 * Batched-DELETE retention for `auth_log`. The table is plain (not partitioned),
 * so retention is a bounded `DELETE ... WHERE occurred_at < cutoff` loop rather
 * than a partition drop. Same Ticker/start/stop shape as
 * `OutboxRetentionWorker`; runs on every pod (idempotent, no leader election).
 */
export class AuthLogRetentionWorker {
  private readonly ticker: Ticker
  private readonly config: AuthLogRetentionWorkerConfig

  constructor(
    private readonly pool: Pool,
    config: Partial<AuthLogRetentionWorkerConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }

    if (this.config.intervalMs <= 0) {
      throw new Error(`AuthLogRetentionWorker intervalMs must be > 0, got ${this.config.intervalMs}`)
    }
    if (this.config.retentionMs <= 0) {
      throw new Error(`AuthLogRetentionWorker retentionMs must be > 0, got ${this.config.retentionMs}`)
    }
    if (this.config.batchSize <= 0) {
      throw new Error(`AuthLogRetentionWorker batchSize must be > 0, got ${this.config.batchSize}`)
    }
    if (this.config.maxBatchesPerRun <= 0) {
      throw new Error(`AuthLogRetentionWorker maxBatchesPerRun must be > 0, got ${this.config.maxBatchesPerRun}`)
    }

    this.ticker = new Ticker({ name: "auth-log-retention", intervalMs: this.config.intervalMs, maxConcurrency: 1 })
  }

  start(): void {
    this.ticker.start(() => this.cleanup())
    logger.info(
      { intervalMs: this.config.intervalMs, retentionMs: this.config.retentionMs },
      "AuthLogRetentionWorker started"
    )
  }

  async stop(): Promise<void> {
    this.ticker.stop()
    await this.ticker.drain()
    logger.info("AuthLogRetentionWorker stopped")
  }

  isRunning(): boolean {
    return this.ticker.isRunning()
  }

  async cleanup(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - this.config.retentionMs)
      let totalDeleted = 0
      let batches = 0

      while (batches < this.config.maxBatchesPerRun) {
        const deleted = await AuthLogRepository.deleteOlderThan(this.pool, cutoff, this.config.batchSize)
        if (deleted === 0) break
        totalDeleted += deleted
        batches += 1
        if (deleted < this.config.batchSize) break
      }

      if (totalDeleted > 0) {
        logger.info(
          { deleted: totalDeleted, batches, cutoff: cutoff.toISOString() },
          "auth_log retention cleanup completed"
        )
      }
    } catch (err) {
      logger.error({ err }, "auth_log retention cleanup failed")
    }
  }
}
