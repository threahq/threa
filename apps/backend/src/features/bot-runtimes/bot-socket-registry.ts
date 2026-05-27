import type { Socket } from "socket.io"
import { logger } from "../../lib/logger"

export interface BotSocketKey {
  workspaceId: string
  botId: string
  instanceId: string
}

export interface BotSocketRegistryOptions {
  /**
   * When the last socket for `(workspaceId, botId, instanceId)` unregisters,
   * wait this long before declaring the instance offline. If any socket
   * re-registers under the same key inside the window the timer is cancelled.
   * Absorbs Wi-Fi blips and laptop-lid-close events without flapping the
   * presence row. Default 30_000 ms.
   */
  graceMs?: number
  /**
   * Called once the grace window elapses with no reconnect. Wired in
   * `server.ts` to `BotRuntimeInstanceRepository.markOffline`, which sets
   * `status='offline', accepting_invocations=false` without deleting the row
   * (the row must persist so `target_instance_id`-pinned invocations remain
   * routable on reconnect — see the plan doc for the rationale).
   */
  onInstanceOffline?: (key: BotSocketKey) => void | Promise<void>
}

/**
 * In-memory registry of `/bot` namespace sockets keyed by
 * (workspaceId, botId, instanceId). Sockets are tied to this server
 * process — connect/disconnect events keep the map in sync, lookups are
 * O(1), and a stale entry can only outlive the actual disconnect event
 * by the engine's ping timeout.
 *
 * One instance can technically hold a Set of sockets to tolerate
 * reconnect overlap (browser opens a new socket before the old one's
 * disconnect timer fires) — siblings that won't both serve invocations
 * because the claim is brokered through Postgres.
 *
 * Use cases:
 *   - `getSockets(...)` for diagnostics and per-socket fanout that
 *     bypasses the room layer (key rotation, force-disconnect)
 *   - `disconnectInstance(...)` when an admin revokes a session and the
 *     runtime must drop its in-memory state immediately
 *   - `onInstanceOffline` after a grace window so the DB presence row
 *     reflects "this instance is no longer connected"
 */
export class BotSocketRegistry {
  private byInstance = new Map<string, Set<Socket>>()
  private graceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private graceMs: number
  private onInstanceOffline?: (key: BotSocketKey) => void | Promise<void>

  constructor(options: BotSocketRegistryOptions = {}) {
    this.graceMs = options.graceMs ?? 30_000
    this.onInstanceOffline = options.onInstanceOffline
  }

  private keyOf(k: BotSocketKey): string {
    return `${k.workspaceId}|${k.botId}|${k.instanceId}`
  }

  register(key: BotSocketKey, socket: Socket): void {
    const k = this.keyOf(key)
    // Reconnect within the grace window: cancel the pending offline mark so
    // we don't flap a row that's about to be live again.
    const pending = this.graceTimers.get(k)
    if (pending) {
      clearTimeout(pending)
      this.graceTimers.delete(k)
    }
    let sockets = this.byInstance.get(k)
    if (!sockets) {
      sockets = new Set()
      this.byInstance.set(k, sockets)
    }
    sockets.add(socket)
  }

  unregister(key: BotSocketKey, socket: Socket): void {
    const k = this.keyOf(key)
    const sockets = this.byInstance.get(k)
    if (!sockets) return
    sockets.delete(socket)
    if (sockets.size === 0) {
      this.byInstance.delete(k)
      if (this.onInstanceOffline) this.scheduleOffline(key)
    }
  }

  private scheduleOffline(key: BotSocketKey): void {
    const k = this.keyOf(key)
    const existing = this.graceTimers.get(k)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.graceTimers.delete(k)
      // Double-check inside the timer fire: a reconnect race could have put
      // sockets back without us seeing it (e.g. if graceMs is 0 in tests).
      if (this.byInstance.has(k)) return
      Promise.resolve()
        .then(() => this.onInstanceOffline?.(key))
        .catch((err: unknown) => {
          logger.error({ err, ...key }, "bot-socket-registry: onInstanceOffline callback failed")
        })
    }, this.graceMs)
    // Don't keep the event loop alive just for offline marking — graceful
    // shutdown should not have to wait for a 30 s timer to fire.
    if (typeof timer.unref === "function") timer.unref()
    this.graceTimers.set(k, timer)
  }

  getSockets(key: BotSocketKey): Socket[] {
    const sockets = this.byInstance.get(this.keyOf(key))
    return sockets ? Array.from(sockets) : []
  }

  /**
   * Force-disconnect every socket for this instance and return how many
   * were kicked. The caller usually emits a terminal event (e.g.
   * `bot:resync`) before calling this so the runtime knows why it lost
   * its connection.
   *
   * Note: `socket.disconnect(true)` schedules the disconnect event
   * asynchronously, so `getSockets(key)` keeps returning the kicked
   * sockets until the engine fires `disconnect` and the namespace handler
   * runs `unregister`. Don't read the registry to confirm a kick — read
   * the return value of this call.
   */
  disconnectInstance(key: BotSocketKey): number {
    const sockets = this.getSockets(key)
    for (const socket of sockets) {
      socket.disconnect(true)
    }
    return sockets.length
  }

  size(): number {
    let count = 0
    for (const sockets of this.byInstance.values()) count += sockets.size
    return count
  }

  /**
   * Cancel every pending offline timer. Call on graceful shutdown so the
   * server can exit without waiting for them to fire — the timers are
   * unref'd anyway, but this keeps the registry in a defined state.
   */
  dispose(): void {
    for (const timer of this.graceTimers.values()) clearTimeout(timer)
    this.graceTimers.clear()
  }
}
