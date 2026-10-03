import type { Querier } from "../../db"
import { parseDeviceContext, type DeviceContext } from "@threahq/types"
import { logger } from "../../lib/logger"
import { UserDeviceContextRepository } from "./repository"

interface HeartbeatTarget {
  workspaceId: string
  userId: string
}

/**
 * One socket connection's view of the device its heartbeats report. Only an
 * interacted heartbeat is written (the device the user is actually using), and
 * only when it differs from what this connection last wrote, so steady-state
 * heartbeats never touch the DB.
 */
export class DeviceHeartbeatSync {
  private readonly applied = new Map<string, DeviceContext>()

  constructor(private readonly db: Querier) {}

  handle(heartbeat: { device?: unknown; interacted: boolean }, targets: Iterable<HeartbeatTarget>): void {
    const device = parseDeviceContext(heartbeat.device)
    if (!device) {
      // The client stopped reporting (sharing turned off), whose stored row is
      // deleted; forgetting what was written makes a later opt-in write it again.
      this.applied.clear()
      return
    }
    if (!heartbeat.interacted) return

    for (const { workspaceId, userId } of targets) {
      const key = `${workspaceId}:${userId}`
      const previous = this.applied.get(key)
      if (
        previous &&
        previous.layout === device.layout &&
        previous.os === device.os &&
        previous.installed === device.installed
      ) {
        continue
      }
      this.applied.set(key, device)
      UserDeviceContextRepository.upsert(this.db, workspaceId, userId, device).catch((err) => {
        this.applied.delete(key)
        logger.warn({ err, workspaceId, userId }, "Failed to store device context")
      })
    }
  }
}
