import type { Request, Response } from "express"
import type { Pool } from "pg"
import type { PoolMonitor } from "../lib/observability"

interface Dependencies {
  pool: Pool
  poolMonitor: PoolMonitor
}

export function createDebugHandlers({ pool, poolMonitor }: Dependencies) {
  return {
    readiness(_req: Request, res: Response) {
      const poolStats = poolMonitor.getAllPoolStats()
      res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        pools: poolStats,
      })
    },

    poolState(_req: Request, res: Response) {
      const mainPool = pool as any

      const clients =
        mainPool._clients?.map((client: any, index: number) => ({
          index,
          connected: client._connected,
          connecting: client._connecting,
          ending: client._ending,
          queryable: client._queryable,
        })) ?? []

      const idle =
        mainPool._idle?.map((item: any) => ({
          connected: item.client._connected,
        })) ?? []

      res.json({
        publicStats: {
          totalCount: mainPool.totalCount,
          idleCount: mainPool.idleCount,
          waitingCount: mainPool.waitingCount,
        },
        internals: {
          _clients_length: mainPool._clients?.length,
          _idle_length: mainPool._idle?.length,
          _pendingQueue_length: mainPool._pendingQueue?.length,
        },
        clients,
        idle,
      })
    },

    async metrics(_req: Request, res: Response) {
      const { registry } = await import("../lib/observability")
      res.set("Content-Type", registry.contentType)
      res.end(await registry.metrics())
    },
  }
}
