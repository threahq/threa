import type { Querier } from "../../db"
import { parseDeviceContext } from "@threahq/types"
import { logger } from "../../lib/logger"
import { UserDeviceContextRepository } from "./repository"

interface HeartbeatTarget {
  workspaceId: string
  userId: string
}

/**
 * Stores the device an interacted heartbeat reports, for every workspace the
 * connection serves. Only interacted heartbeats count: they name the device the
 * user is actually using, so the latest one wins across a user's devices.
 */
export function storeHeartbeatDevice(
  db: Querier,
  heartbeat: { device?: unknown; interacted: boolean },
  targets: Iterable<HeartbeatTarget>
): void {
  if (!heartbeat.interacted) return
  const device = parseDeviceContext(heartbeat.device)
  if (!device) return

  for (const { workspaceId, userId } of targets) {
    UserDeviceContextRepository.upsert(db, workspaceId, userId, device).catch((err) => {
      logger.warn({ err, workspaceId, userId }, "Failed to store device context")
    })
  }
}
