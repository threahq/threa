import type { Pool } from "pg"
import { Ticker } from "../ticker"
import { logger } from "../logger"
import { ensureMonthlyPartitions, dropExpiredMonthlyPartitions } from "./monthly"

export interface PartitionMaintenanceWorkerConfig {
  parentTable: string
  retainMonths: number
  aheadMonths: number
  intervalMs: number
}

/**
 * Keeps a monthly range-partitioned table healthy: creates the current +
 * `aheadMonths` future partitions and drops any older than `retainMonths`.
 *
 * Runs on every pod without leader election — every operation is idempotent
 * and set-based, so a partition another pod already created/dropped is a no-op
 * here (same posture as the outbox/sync retention sweeps).
 */
export class PartitionMaintenanceWorker {
  private readonly ticker: Ticker

  constructor(
    private readonly pool: Pool,
    private readonly config: PartitionMaintenanceWorkerConfig
  ) {
    if (config.intervalMs <= 0) {
      throw new Error(`PartitionMaintenanceWorker intervalMs must be > 0, got ${config.intervalMs}`)
    }
    if (config.retainMonths <= 0) {
      throw new Error(`PartitionMaintenanceWorker retainMonths must be > 0, got ${config.retainMonths}`)
    }
    if (config.aheadMonths < 0) {
      throw new Error(`PartitionMaintenanceWorker aheadMonths must be >= 0, got ${config.aheadMonths}`)
    }

    this.ticker = new Ticker({
      name: `partition-maintenance:${config.parentTable}`,
      intervalMs: config.intervalMs,
      maxConcurrency: 1,
    })
  }

  start(): void {
    // Eager first run: Ticker's first fire is intervalMs away, and a pod
    // booting into a DB whose seeded partitions have lapsed (restored backup,
    // parked environment) would otherwise drop every insert until then —
    // shrinking audit coverage in the direction the design forbids.
    void this.maintain()
    this.ticker.start(() => this.maintain())
    logger.info(
      {
        parentTable: this.config.parentTable,
        retainMonths: this.config.retainMonths,
        aheadMonths: this.config.aheadMonths,
        intervalMs: this.config.intervalMs,
      },
      "PartitionMaintenanceWorker started"
    )
  }

  async stop(): Promise<void> {
    this.ticker.stop()
    await this.ticker.drain()
    logger.info({ parentTable: this.config.parentTable }, "PartitionMaintenanceWorker stopped")
  }

  isRunning(): boolean {
    return this.ticker.isRunning()
  }

  private async maintain(): Promise<void> {
    try {
      await ensureMonthlyPartitions(this.pool, this.config.parentTable, { aheadMonths: this.config.aheadMonths })
      const dropped = await dropExpiredMonthlyPartitions(this.pool, this.config.parentTable, {
        retainMonths: this.config.retainMonths,
      })
      if (dropped.length > 0) {
        logger.info({ parentTable: this.config.parentTable, dropped }, "Dropped expired partitions")
      }
    } catch (err) {
      logger.error({ err, parentTable: this.config.parentTable }, "Partition maintenance failed")
    }
  }
}
