import type { Pool, PoolClient } from "pg"
import type { ConnectCallback } from "@threahq/backend-common"
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

/** pg keeps every client it has handed out or is still dialling in `_clients`. */
interface PoolInternals {
  _clients?: { _connected?: boolean }[]
}

/** Null when pg no longer exposes `_clients`, so the caller stays quiet instead of blaming every client. */
function countConnected(pool: Pool): number | null {
  const clients = (pool as unknown as PoolInternals)._clients
  return clients ? clients.filter((client) => client._connected === true).length : null
}

interface Checkout {
  acquiredAt: number
  site: Error
}

export interface PoolHolder {
  heldMs: number
  /** Text of the statement the client is running now; null while the holder does other work between queries. */
  query: string | null
  site: string[]
}

interface ClientInternals {
  _activeQuery?: { text?: string } | null
}

const MAX_REPORTED_HOLDERS = 10
const MAX_QUERY_CHARS = 120
const MAX_SITE_FRAMES = 3
const ABSOLUTE_PREFIX_BEFORE_REPO_PATH = /[^\s(]*\/(?=(apps|packages)\/)/

/**
 * Wraps `pool.connect`, which `pool.query` goes through too, so every checkout
 * records when and from where it was taken. Its stack is only formatted when a
 * saturated pool is reported.
 */
function trackCheckouts(pool: Pool): Map<PoolClient, Checkout> {
  const checkouts = new Map<PoolClient, Checkout>()
  const connect = pool.connect.bind(pool) as (cb?: ConnectCallback) => Promise<PoolClient> | void
  const remember = (client: PoolClient, site: Error) => checkouts.set(client, { acquiredAt: Date.now(), site })

  pool.connect = ((cb?: ConnectCallback) => {
    const site = new Error("pool checkout")
    if (cb) {
      return connect((err, client, done) => {
        if (client) remember(client, site)
        cb(err, client, done)
      })
    }
    return (connect() as Promise<PoolClient>).then((client) => {
      remember(client, site)
      return client
    })
  }) as Pool["connect"]

  pool.on("release", (_err: Error | undefined, client: PoolClient) => checkouts.delete(client))
  pool.on("remove", (client: PoolClient) => checkouts.delete(client))
  return checkouts
}

function callSite(site: Error): string[] {
  return (site.stack ?? "")
    .split("\n")
    .slice(1)
    .map((frame) => frame.trim())
    .filter((frame) => !frame.includes("node_modules") && !frame.includes("observability/pool-monitor."))
    .slice(0, MAX_SITE_FRAMES)
    .map((frame) => frame.replace(ABSOLUTE_PREFIX_BEFORE_REPO_PATH, ""))
}

function describeHolders(checkouts: Map<PoolClient, Checkout>, now: number): PoolHolder[] {
  return Array.from(checkouts)
    .sort(([, a], [, b]) => a.acquiredAt - b.acquiredAt)
    .slice(0, MAX_REPORTED_HOLDERS)
    .map(([client, checkout]) => ({
      heldMs: now - checkout.acquiredAt,
      query: (client as unknown as ClientInternals)._activeQuery?.text?.slice(0, MAX_QUERY_CHARS) ?? null,
      site: callSite(checkout.site),
    }))
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
  private unconnectedSamples = new Map<string, number>()
  private checkouts = new Map<string, Map<PoolClient, Checkout>>()

  constructor(pools: Record<string, Pool>, options: PoolMonitorOptions = {}) {
    this.pools = new Map(Object.entries(pools))
    for (const [name, pool] of this.pools) this.checkouts.set(name, trackCheckouts(pool))
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

      // A client pg is still dialling counts against totalCount before it is
      // connected, so a single unconnected client is normal and says nothing.
      // One that is still unconnected a sample later is not dialling any more.
      const pool = this.pools.get(stats.poolName)
      const connected = pool ? countConnected(pool) : null
      const unconnected = connected === null ? 0 : stats.totalCount - connected
      const priorSamples = unconnected > 0 ? (this.unconnectedSamples.get(stats.poolName) ?? 0) : 0
      this.unconnectedSamples.set(stats.poolName, unconnected > 0 ? priorSamples + 1 : 0)

      if (unconnected > 0 && priorSamples > 0) {
        logger.error(
          { ...logData, unconnectedClients: unconnected, samples: priorSamples + 1 },
          `Pool '${stats.poolName}' has held ${unconnected} unconnected client(s) for ${priorSamples + 1} samples; ` +
            `they are occupying pool slots without a connection`
        )
      }

      // Always log warnings/errors even if logging is disabled
      if (hasWaiting) {
        const checkouts = this.checkouts.get(stats.poolName)!
        // The PostHog log shipper truncates each attribute at 2 KB, so every holder ships as its own attribute.
        const holders = Object.fromEntries(
          describeHolders(checkouts, Date.now()).map((holder, index) => [`holder${index}`, holder])
        )
        logger.warn(
          { ...logData, held: checkouts.size, ...holders },
          `Pool '${stats.poolName}' has ${stats.waitingCount} waiting client(s)`
        )
      } else if (isHighUtilization) {
        logger.warn(logData, `Pool '${stats.poolName}' utilization at ${stats.utilizationPercent}%`)
      } else if (!this.options.disableLogging) {
        logger[this.options.logLevel](logData, `Pool stats for '${stats.poolName}'`)
      }
    }
  }
}
