import type { Pool } from "pg"
import type { Server } from "socket.io"
import type { SyncHeartbeatPayload } from "@threa/types"
import { Ticker } from "@threa/backend-common"
import { logger } from "../../lib/logger"
import { SyncLogRepository } from "./repository"

export interface SyncHeartbeatWorkerConfig {
  intervalMs?: number
}

const DEFAULT_CONFIG = {
  intervalMs: 15_000,
}

/** The bare workspace room (`ws:<id>`), not its `:stream:`/`:user:` subrooms. */
const WORKSPACE_ROOM_PATTERN = /^ws:([^:]+)$/

/**
 * Periodically broadcasts each workspace's sync-log head to its workspace
 * room (`sync:heartbeat`), so active-mode clients can detect a dropped emit
 * by comparing the head against their cursor position and trigger catch-up —
 * without waiting for a reconnect/resume. Design:
 * docs/plans/sync-v2-heartbeat.md.
 *
 * Deliberately NOT an outbox event (INV-4 governs domain state changes): the
 * heartbeat carries no state — it is a derived `MAX` over the very log whose
 * head it reports, idempotent and periodic, so logging it would advance the
 * head it measures.
 *
 * Emits with the `local` flag: the Socket.io Postgres adapter fans a plain
 * room emit out through every backend instance, and each instance runs its
 * own ticker for its own sockets — without `local`, N instances would deliver
 * N copies per interval. `adapter.rooms` is node-local, so the room scan and
 * the emit cover exactly this instance's connections.
 */
export class SyncHeartbeatWorker {
  private readonly pool: Pool
  private readonly io: Server
  private readonly ticker: Ticker

  constructor(deps: { pool: Pool; io: Server }, config?: SyncHeartbeatWorkerConfig) {
    this.pool = deps.pool
    this.io = deps.io
    this.ticker = new Ticker({
      name: "sync-heartbeat",
      intervalMs: config?.intervalMs ?? DEFAULT_CONFIG.intervalMs,
      maxConcurrency: 1,
    })
  }

  start(): void {
    this.ticker.start(() => this.tickOnce())
    logger.info("SyncHeartbeatWorker started")
  }

  async stop(): Promise<void> {
    this.ticker.stop()
    await this.ticker.drain()
    logger.info("SyncHeartbeatWorker stopped")
  }

  /** One heartbeat pass; the ticker calls this on its interval. */
  async tickOnce(): Promise<void> {
    try {
      const workspaceIds: string[] = []
      for (const room of this.io.sockets.adapter.rooms.keys()) {
        const match = WORKSPACE_ROOM_PATTERN.exec(room)
        if (match) {
          workspaceIds.push(match[1])
        }
      }
      if (workspaceIds.length === 0) {
        return
      }

      const heads = await SyncLogRepository.getHeads(this.pool, workspaceIds)
      for (const workspaceId of workspaceIds) {
        const payload: SyncHeartbeatPayload = {
          workspaceId,
          // A workspace absent from sync_log has head 0; no client position
          // sits below 0, so the emit is a harmless no-op compare.
          head: (heads.get(workspaceId) ?? 0n).toString(),
        }
        this.io.local.to(`ws:${workspaceId}`).emit("sync:heartbeat", payload)
      }
    } catch (err) {
      // Next tick retries with a fresh head; detection latency degrades,
      // correctness doesn't — catch-up triggers on the following heartbeat.
      logger.error({ err }, "sync heartbeat tick failed")
    }
  }
}
