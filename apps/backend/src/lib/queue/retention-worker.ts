import type { Pool } from "pg"
import { Ticker } from "@threahq/backend-common"
import { QueueRepository, type QueueRetentionCategory } from "./repository"
import { logger } from "../logger"

export interface QueueRetentionWorkerConfig {
  intervalMs: number
  completedRetentionMs: number
  cancelledRetentionMs: number
  dlqRetentionMs: number
  batchSize: number
  maxBatchesPerRun: number
}

const DEFAULT_CONFIG: QueueRetentionWorkerConfig = {
  intervalMs: 60 * 60 * 1000,
  completedRetentionMs: 7 * 24 * 60 * 60 * 1000,
  cancelledRetentionMs: 30 * 24 * 60 * 60 * 1000,
  dlqRetentionMs: 90 * 24 * 60 * 60 * 1000,
  batchSize: 5000,
  maxBatchesPerRun: 20,
}

/**
 * Periodically purges terminal queue_messages (completed / cancelled / DLQ)
 * past their per-category retention window. Deletes in bounded batches so a
 * large backlog is drained across ticks instead of one long-running DELETE.
 */
export class QueueRetentionWorker {
  private readonly ticker: Ticker
  private readonly config: QueueRetentionWorkerConfig

  constructor(
    private readonly pool: Pool,
    config: Partial<QueueRetentionWorkerConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }

    for (const [key, value] of Object.entries(this.config)) {
      if (value <= 0) {
        throw new Error(`QueueRetentionWorker ${key} must be > 0, got ${value}`)
      }
    }

    this.ticker = new Ticker({
      name: "queue-retention",
      intervalMs: this.config.intervalMs,
      maxConcurrency: 1,
    })
  }

  start(): void {
    this.ticker.start(() => this.runOnce())
    logger.info(
      {
        intervalMs: this.config.intervalMs,
        completedRetentionMs: this.config.completedRetentionMs,
        cancelledRetentionMs: this.config.cancelledRetentionMs,
        dlqRetentionMs: this.config.dlqRetentionMs,
        batchSize: this.config.batchSize,
        maxBatchesPerRun: this.config.maxBatchesPerRun,
      },
      "QueueRetentionWorker started"
    )
  }

  async stop(): Promise<void> {
    this.ticker.stop()
    await this.ticker.drain()
    logger.info("QueueRetentionWorker stopped")
  }

  isRunning(): boolean {
    return this.ticker.isRunning()
  }

  async runOnce(): Promise<void> {
    try {
      const now = Date.now()
      const categories: { category: QueueRetentionCategory; cutoff: Date }[] = [
        { category: "completed", cutoff: new Date(now - this.config.completedRetentionMs) },
        { category: "cancelled", cutoff: new Date(now - this.config.cancelledRetentionMs) },
        { category: "dlq", cutoff: new Date(now - this.config.dlqRetentionMs) },
      ]

      const deleted: Record<QueueRetentionCategory, number> = { completed: 0, cancelled: 0, dlq: 0 }

      for (const { category, cutoff } of categories) {
        for (let batch = 0; batch < this.config.maxBatchesPerRun; batch++) {
          const count = await QueueRepository.deleteExpiredMessagesBatch(this.pool, {
            category,
            cutoff,
            limit: this.config.batchSize,
          })
          deleted[category] += count
          if (count < this.config.batchSize) {
            break
          }
        }
      }

      if (deleted.completed + deleted.cancelled + deleted.dlq > 0) {
        logger.info({ ...deleted }, "Queue retention cleanup completed")
      }
    } catch (err) {
      logger.error({ err }, "Queue retention cleanup failed")
    }
  }
}
