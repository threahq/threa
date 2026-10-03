import type { Pool } from "pg"
import { withTransaction } from "../../db"
import { parseDeviceContext, type DeviceContext } from "@threahq/types"
import { logger } from "../../lib/logger"
import { UserDeviceContextRepository } from "./repository"

interface HeartbeatTarget {
  workspaceId: string
  userId: string
}

/** Stores the user's latest device, unless they turned sharing off or are no longer a member. */
export async function storeDevice(pool: Pool, workspaceId: string, userId: string, device: DeviceContext) {
  await withTransaction(pool, async (client) => {
    if (!(await UserDeviceContextRepository.lockUser(client, workspaceId, userId, "report"))) return
    await UserDeviceContextRepository.upsert(client, workspaceId, userId, device)
  })
}

/**
 * Stores the device an interacted heartbeat reports, for every workspace the
 * connection serves. Only interacted heartbeats count: they name the device the
 * user is actually using, so the latest one wins across a user's devices.
 */
export function storeHeartbeatDevice(
  pool: Pool,
  heartbeat: { device?: unknown; interacted: boolean },
  targets: Iterable<HeartbeatTarget>
): void {
  if (!heartbeat.interacted) return
  const device = parseDeviceContext(heartbeat.device)
  if (!device) return

  for (const { workspaceId, userId } of targets) {
    storeDevice(pool, workspaceId, userId, device).catch((err) => {
      logger.warn({ err, workspaceId, userId }, "Failed to store device context")
    })
  }
}
