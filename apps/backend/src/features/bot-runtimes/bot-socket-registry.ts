import type { Socket } from "socket.io"

export interface BotSocketKey {
  workspaceId: string
  botId: string
  instanceId: string
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
 */
export class BotSocketRegistry {
  private byInstance = new Map<string, Set<Socket>>()

  private keyOf(k: BotSocketKey): string {
    return `${k.workspaceId}|${k.botId}|${k.instanceId}`
  }

  register(key: BotSocketKey, socket: Socket): void {
    const k = this.keyOf(key)
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
    if (sockets.size === 0) this.byInstance.delete(k)
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
}
