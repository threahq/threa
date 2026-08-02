import type { Pool } from "pg"
import { Ticker } from "@threa/backend-common"
import { logger } from "../logger"
import { queueMessagesPending, queueOldestPendingAgeSeconds, queueMessagesDlq } from "../observability"
import { QueueRepository } from "./repository"

export interface QueueDepthSamplerConfig {
  intervalMs?: number
}

const DEFAULT_CONFIG = {
  intervalMs: 15_000,
}

export class QueueDepthSampler {
  private readonly pool: Pool
  private readonly config: Required<QueueDepthSamplerConfig>
  private readonly ticker: Ticker
  private readonly knownQueues = new Set<string>()

  constructor(deps: { pool: Pool }, config?: QueueDepthSamplerConfig) {
    this.pool = deps.pool
    this.config = {
      intervalMs: config?.intervalMs ?? DEFAULT_CONFIG.intervalMs,
    }
    this.ticker = new Ticker({
      name: "queue-depth-sampler",
      intervalMs: this.config.intervalMs,
      maxConcurrency: 1,
    })
  }

  start(): void {
    this.ticker.start(() => this.sampleOnce())
    logger.info({ ...this.config }, "QueueDepthSampler started")
  }

  async stop(): Promise<void> {
    this.ticker.stop()
    await this.ticker.drain()
    logger.info("QueueDepthSampler stopped")
  }

  async sampleOnce(): Promise<void> {
    try {
      const rows = await QueueRepository.depthByQueue(this.pool)
      const now = Date.now()
      const seen = new Set<string>()

      for (const row of rows) {
        seen.add(row.queueName)
        this.knownQueues.add(row.queueName)
        queueMessagesPending.set({ queue: row.queueName }, row.pending)
        queueMessagesDlq.set({ queue: row.queueName }, row.dlq)
        queueOldestPendingAgeSeconds.set(
          { queue: row.queueName },
          row.oldestPendingAt ? Math.max(0, (now - row.oldestPendingAt.getTime()) / 1000) : 0
        )
      }

      // A drained queue stops producing a row entirely; without this its last
      // non-zero sample would sit in the registry forever.
      for (const queue of this.knownQueues) {
        if (seen.has(queue)) continue
        queueMessagesPending.set({ queue }, 0)
        queueMessagesDlq.set({ queue }, 0)
        queueOldestPendingAgeSeconds.set({ queue }, 0)
      }
    } catch (err) {
      logger.error({ err }, "queue depth sample failed")
    }
  }
}
