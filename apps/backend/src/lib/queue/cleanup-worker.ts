import type { Pool } from "pg"
import { Ticker } from "@threa/backend-common"
import { CronRepository } from "./cron-repository"
import { logger } from "../logger"

export interface CleanupWorkerConfig {
  intervalMs: number // How often to run cleanup (default: 300000 = 5 minutes)
  expiredThresholdMs: number // How old expired ticks must be before deletion (default: 300000 = 5 minutes)
}

const DEFAULT_CONFIG: CleanupWorkerConfig = {
  intervalMs: 300000, // 5 minutes
  expiredThresholdMs: 300000, // 5 minutes
}

/**
 * Periodically deletes expired and orphaned cron ticks so the cron_ticks table
 * doesn't grow unbounded on failures. See docs/distributed-cron-design.md.
 */
export class CleanupWorker {
  private readonly ticker: Ticker
  private readonly config: CleanupWorkerConfig

  constructor(
    private readonly pool: Pool,
    config: Partial<CleanupWorkerConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.ticker = new Ticker({
      name: "cron-cleanup",
      intervalMs: this.config.intervalMs,
      maxConcurrency: 1,
    })
  }

  start(): void {
    this.ticker.start(() => this.cleanup())
    logger.info(
      {
        intervalMs: this.config.intervalMs,
        expiredThresholdMs: this.config.expiredThresholdMs,
      },
      "CleanupWorker started"
    )
  }

  async stop(): Promise<void> {
    this.ticker.stop()
    await this.ticker.drain()
    logger.info("CleanupWorker stopped")
  }

  private async cleanup(): Promise<void> {
    try {
      const expiredBefore = new Date(Date.now() - this.config.expiredThresholdMs)

      const expiredCount = await CronRepository.deleteExpiredTicks(this.pool, {
        expiredBefore,
      })

      const orphanedCount = await CronRepository.deleteOrphanedTicks(this.pool)

      if (expiredCount > 0 || orphanedCount > 0) {
        logger.info({ expiredCount, orphanedCount }, "Cleaned up cron ticks")
      }
    } catch (err) {
      logger.error({ err }, "Failed to clean up cron ticks")
    }
  }

  isRunning(): boolean {
    return this.ticker.isRunning()
  }
}
