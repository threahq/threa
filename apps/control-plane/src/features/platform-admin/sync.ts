import type { Pool } from "pg"
import { logger, OutboxRepository, type Querier } from "@threa/backend-common"
import { PlatformRoleRepository } from "../backoffice"
import { WorkspaceRegistryRepository } from "../workspaces"
import type { RegionalClient } from "../../lib/regional-client"

export const OUTBOX_PLATFORM_ADMIN_SYNC = "platform_admin_sync"

/**
 * Outbox payload for the regional fan-out. Carries only identity — the
 * handler re-reads the grant and the user's memberships at delivery time and
 * pushes a full snapshot, so rapid changes collapse to the latest state and
 * replays are idempotent (same shape as the feature-flags sync).
 */
export interface PlatformAdminSyncPayload extends Record<string, unknown> {
  workosUserId: string
}

interface Dependencies {
  pool: Pool
  regionalClient: RegionalClient
}

/**
 * Pushes control-plane platform-admin grants (`platform_roles`) to the
 * regional `platform_admin_access` mirrors so the product app can gate links
 * into the backoffice. The control plane stays the authorization source of
 * truth — the mirror is cosmetic (UI gating only); the backoffice re-checks
 * `requirePlatformAdmin` on every request regardless.
 *
 * Emission points:
 * - startup seeding (`seedPlatformAdmins` callers) — re-emits every boot,
 *   which doubles as self-heal for any membership created while an emit was
 *   missed or a region was unreachable;
 * - membership creation (workspace create, invitation accept) via
 *   `enqueueIfAdmin`, so an admin's brand-new workspace shows the link
 *   without waiting for the next control-plane restart.
 */
export class PlatformAdminSyncService {
  private pool: Pool
  private regionalClient: RegionalClient

  constructor({ pool, regionalClient }: Dependencies) {
    this.pool = pool
    this.regionalClient = regionalClient
  }

  /**
   * Enqueue fan-outs for a batch of users in one round-trip (INV-56) — the
   * startup-seeding path. Pass the transaction client to commit atomically
   * with surrounding writes (INV-7).
   */
  async enqueueMany(db: Querier, workosUserIds: string[]): Promise<void> {
    await OutboxRepository.insertMany(
      db,
      workosUserIds.map((workosUserId) => ({
        eventType: OUTBOX_PLATFORM_ADMIN_SYNC,
        payload: { workosUserId } satisfies PlatformAdminSyncPayload,
      }))
    )
  }

  /**
   * Enqueue only when the user actually holds a platform-admin grant — the
   * membership-creation hook. Non-admins (the overwhelmingly common case)
   * cost one indexed read and no event; their regional default is already
   * "no access".
   */
  async enqueueIfAdmin(db: Querier, workosUserId: string): Promise<void> {
    const row = await PlatformRoleRepository.findByWorkosUserId(db, workosUserId)
    if (row?.role === "admin") {
      await OutboxRepository.insert(db, OUTBOX_PLATFORM_ADMIN_SYNC, {
        workosUserId,
      } satisfies PlatformAdminSyncPayload)
    }
  }

  /**
   * Outbox handler: re-read the grant and fan the snapshot out to every
   * workspace the user belongs to, in parallel. Partial failures are
   * aggregated and rethrown so the outbox retries (successful regions just
   * re-apply an idempotent snapshot).
   */
  async syncToRegions(payload: PlatformAdminSyncPayload): Promise<void> {
    const role = await PlatformRoleRepository.findByWorkosUserId(this.pool, payload.workosUserId)
    const isPlatformAdmin = role?.role === "admin"
    const workspaces = await WorkspaceRegistryRepository.listByUser(this.pool, payload.workosUserId)
    if (workspaces.length === 0) return

    const results = await Promise.allSettled(
      workspaces.map((ws) =>
        this.regionalClient.syncPlatformAdminAccess(ws.region, {
          workspaceId: ws.id,
          workosUserId: payload.workosUserId,
          isPlatformAdmin,
        })
      )
    )

    const errors: unknown[] = []
    results.forEach((result, idx) => {
      if (result.status === "rejected") {
        const ws = workspaces[idx]
        logger.error(
          { err: result.reason, region: ws.region, workspaceId: ws.id, workosUserId: payload.workosUserId },
          "Regional platform-admin sync failed for workspace"
        )
        errors.push(result.reason)
      }
    })

    if (errors.length > 0) {
      throw new AggregateError(errors, "Regional platform-admin sync failed for one or more workspaces")
    }
  }
}
