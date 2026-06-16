import { logger } from "./logger"

/**
 * Ticker - Generic interval runner with concurrency control
 *
 * A fancy setInterval that:
 * - Skips ticks if callback is still running (unless < maxConcurrency)
 * - Provides drain() to wait for in-flight callbacks
 * - Provides stop() for immediate shutdown
 */

export interface TickerConfig {
  name: string // For observability
  intervalMs: number // Tick frequency
  maxConcurrency: number // Max parallel executions
}

export class Ticker {
  private readonly config: TickerConfig
  private timer: Timer | null = null
  private inFlightCount = 0
  private readonly inFlightPromises = new Set<Promise<void>>()

  constructor(config: TickerConfig) {
    this.config = config
  }

  /**
   * Start ticking. Callback is called every intervalMs.
   * If callback is still running, tick is skipped (unless < maxConcurrency).
   */
  start(callback: () => Promise<void>): void {
    if (this.timer) {
      throw new Error(`Ticker ${this.config.name} already started`)
    }

    this.timer = setInterval(() => {
      // Skip if at max concurrency
      if (this.inFlightCount >= this.config.maxConcurrency) {
        return
      }

      this.inFlightCount++

      const promise = callback()
        .catch((err) => {
          logger.error({ tickerName: this.config.name, err }, "Ticker callback error")
        })
        .finally(() => {
          this.inFlightCount--
          this.inFlightPromises.delete(promise)
        })

      this.inFlightPromises.add(promise)
    }, this.config.intervalMs)
  }

  /**
   * Stop ticking. Does NOT wait for in-flight callbacks.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Wait for all in-flight callbacks to complete.
   * Resolves immediately if no callbacks running.
   */
  async drain(): Promise<void> {
    if (this.inFlightPromises.size === 0) {
      return
    }

    await Promise.all(Array.from(this.inFlightPromises))
  }

  getInFlightCount(): number {
    return this.inFlightCount
  }

  isRunning(): boolean {
    return this.timer !== null
  }
}
