import { Pool } from "pg"
import { logger } from "../logger"
import { poolConnectionsTotal, poolConnectionsIdle, poolConnectionsWaiting, poolUtilizationPercent } from "./metrics"

export interface PoolStats {
  poolName: string
  totalCount: number
  idleCount: number
  waitingCount: number
  /** Percentage of pool capacity in use (0-100) */
  utilizationPercent: number
  timestamp: string
}

export interface PoolMonitorOptions {
  /** How often to log pool stats (ms). Default: 30000 (30 seconds) */
  logIntervalMs?: number
  /** Log level for periodic stats. Default: 'debug' */
  logLevel?: "debug" | "info" | "warn"
  /** Warn threshold for utilization percent. Default: 80 */
  warnThreshold?: number
  /** Disable console logging (still exports metrics to Prometheus). Default: false */
  disableLogging?: boolean
}

/**
 * Monitors connection pool health and logs metrics.
 *
 * Usage:
 *   const monitor = new PoolMonitor({ main: pool1, listen: pool2 })
 *   monitor.start()
 *   // Later...
 *   monitor.stop()
 */
export class PoolMonitor {
  private pools: Map<string, Pool>
  private intervalId?: NodeJS.Timeout
  private options: Required<PoolMonitorOptions>

  constructor(pools: Record<string, Pool>, options: PoolMonitorOptions = {}) {
    this.pools = new Map(Object.entries(pools))
    this.options = {
      logIntervalMs: options.logIntervalMs ?? 30000,
      logLevel: options.logLevel ?? "debug",
      warnThreshold: options.warnThreshold ?? 80,
      disableLogging: options.disableLogging ?? false,
    }
  }

  getPoolStats(poolName: string): PoolStats | null {
    const pool = this.pools.get(poolName)
    if (!pool) return null

    return this.collectStats(poolName, pool)
  }

  getAllPoolStats(): PoolStats[] {
    const stats: PoolStats[] = []
    for (const [name, pool] of this.pools) {
      stats.push(this.collectStats(name, pool))
    }
    return stats
  }

  start(): void {
    if (this.intervalId) {
      logger.warn("PoolMonitor already started")
      return
    }

    logger.info(
      {
        pools: Array.from(this.pools.keys()),
        intervalMs: this.options.logIntervalMs,
      },
      "Starting pool monitor"
    )

    this.logAllPoolStats()

    this.intervalId = setInterval(() => {
      this.logAllPoolStats()
    }, this.options.logIntervalMs)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
      logger.info("Stopped pool monitor")
    }
  }

  private collectStats(poolName: string, pool: Pool): PoolStats {
    const totalCount = pool.totalCount
    const idleCount = pool.idleCount
    const waitingCount = pool.waitingCount

    const maxSize = (pool.options as { max?: number }).max ?? 10
    const activeCount = totalCount - idleCount
    const utilizationPercent = Math.round((activeCount / maxSize) * 100)

    return {
      poolName,
      totalCount,
      idleCount,
      waitingCount,
      utilizationPercent,
      timestamp: new Date().toISOString(),
    }
  }

  private logAllPoolStats(): void {
    const allStats = this.getAllPoolStats()

    for (const stats of allStats) {
      const isHighUtilization = stats.utilizationPercent >= this.options.warnThreshold
      const hasWaiting = stats.waitingCount > 0

      const logData = {
        pool: stats.poolName,
        total: stats.totalCount,
        idle: stats.idleCount,
        waiting: stats.waitingCount,
        utilizationPercent: stats.utilizationPercent,
      }

      poolConnectionsTotal.set({ pool: stats.poolName }, stats.totalCount)
      poolConnectionsIdle.set({ pool: stats.poolName }, stats.idleCount)
      poolConnectionsWaiting.set({ pool: stats.poolName }, stats.waitingCount)
      poolUtilizationPercent.set({ pool: stats.poolName }, stats.utilizationPercent)

      // Detect phantom connection state: high total count with persistent waiters suggests
      // pool corruption where connections exist in _clients but aren't actually connected
      const pool = this.pools.get(stats.poolName)
      if (pool && stats.totalCount > 20 && hasWaiting && stats.waitingCount >= 10) {
        const poolInternal = pool as any
        const connectedCount = poolInternal._clients?.filter((c: any) => c._connected === true).length ?? 0

        logger.error(
          {
            ...logData,
            connectedClients: connectedCount,
            phantomClients: stats.totalCount - connectedCount,
          },
          `POOL CORRUPTION DETECTED: Pool '${stats.poolName}' has ${connectedCount} connected clients but ${stats.totalCount} total. ` +
            `${stats.totalCount - connectedCount} phantom connections detected!`
        )
      }

      // Always log warnings/errors even if logging is disabled
      if (hasWaiting) {
        logger.warn(logData, `Pool '${stats.poolName}' has ${stats.waitingCount} waiting client(s)`)
      } else if (isHighUtilization) {
        logger.warn(logData, `Pool '${stats.poolName}' utilization at ${stats.utilizationPercent}%`)
      } else if (!this.options.disableLogging) {
        logger[this.options.logLevel](logData, `Pool stats for '${stats.poolName}'`)
      }
    }
  }
}
