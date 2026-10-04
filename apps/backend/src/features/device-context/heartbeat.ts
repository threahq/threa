import type { Pool } from "pg"
import { withTransaction } from "../../db"
import { parseDeviceContext, type DeviceContext } from "@threahq/types"
import { logger } from "../../lib/logger"
import { UserDeviceContextRepository, type DeviceTarget } from "./repository"

/** Stores the user's latest device in each workspace, skipping any where they turned sharing off or left. */
export async function storeDevice(pool: Pool, targets: DeviceTarget[], device: DeviceContext) {
  if (targets.length === 0) return
  await withTransaction(pool, async (client) => {
    const members = await UserDeviceContextRepository.lockMembers(client, targets)
    await UserDeviceContextRepository.upsert(client, members, device)
  })
}

/**
 * Stores the device an interacted heartbeat reports, for every workspace the
 * connection serves. Only interacted heartbeats count: they name the device the
 * user is actually using, so across a user's devices the most recently stored
 * report wins.
 */
export function storeHeartbeatDevice(
  pool: Pool,
  heartbeat: { device?: unknown; interacted: boolean },
  targets: DeviceTarget[]
): void {
  if (!heartbeat.interacted) return
  const device = parseDeviceContext(heartbeat.device)
  if (!device) return

  storeDevice(pool, targets, device).catch((err) => {
    logger.warn({ err, targets }, "Failed to store device context")
  })
}
