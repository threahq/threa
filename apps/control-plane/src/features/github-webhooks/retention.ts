import type { Pool } from "pg"
import { logger, Ticker } from "@threahq/backend-common"
import {
  GITHUB_WEBHOOK_RETENTION_DAYS,
  GITHUB_WEBHOOK_SWEEP_BATCH_SIZE,
  GITHUB_WEBHOOK_SWEEP_INTERVAL_MS,
} from "./constants"
import { GithubWebhookDeliveryRepository } from "./repository"

interface Dependencies {
  pool: Pool
  retentionDays?: number
  batchSize?: number
}

/**
 * Hourly sweep that deletes github_webhook_deliveries rows past the retention
 * window (see GITHUB_WEBHOOK_RETENTION_DAYS). The table grows one row per routed
 * webhook and is bounded nowhere else, so it needs a reaper.
 *
 * Scheduling is delegated to the shared `Ticker` (maxConcurrency 1 → a tick is
 * skipped while the previous sweep is still running; `stop()` + `drain()` give a
 * clean shutdown). No DB lease: the control plane runs single-instance, and the
 * deletes are batched and idempotent, so a second instance sweeping concurrently
 * is harmless — each `DELETE ... WHERE id IN (SELECT ... LIMIT n)` just removes
 * whatever rows it wins.
 */
export class GithubWebhookRetentionSweeper {
  private readonly pool: Pool
  private readonly retentionDays: number
  private readonly batchSize: number
  private readonly ticker: Ticker

  constructor({ pool, retentionDays, batchSize }: Dependencies) {
    this.pool = pool
    this.retentionDays = retentionDays ?? GITHUB_WEBHOOK_RETENTION_DAYS
    this.batchSize = batchSize ?? GITHUB_WEBHOOK_SWEEP_BATCH_SIZE
    this.ticker = new Ticker({
      name: "github-webhook-retention",
      intervalMs: GITHUB_WEBHOOK_SWEEP_INTERVAL_MS,
      maxConcurrency: 1,
    })
  }

  start(): void {
    this.ticker.start(() => this.sweep().then(() => {}))
  }

  /** Stops scheduling new sweeps and waits for the in-flight one to finish. */
  async stop(): Promise<void> {
    this.ticker.stop()
    await this.ticker.drain()
  }

  /**
   * Delete every row older than the cutoff in bounded batches, looping until a
   * batch comes back short of the batch size (backlog drained). Returns the
   * total deleted. Runs on demand for tests and the scheduled loop alike.
   */
  async sweep(): Promise<number> {
    const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000)
    let total = 0
    for (;;) {
      const deleted = await GithubWebhookDeliveryRepository.deleteOlderThanBatch(this.pool, cutoff, this.batchSize)
      total += deleted
      if (deleted < this.batchSize) break
    }
    if (total > 0) {
      logger.info({ deleted: total, retentionDays: this.retentionDays }, "Swept expired GitHub webhook deliveries")
    }
    return total
  }
}
