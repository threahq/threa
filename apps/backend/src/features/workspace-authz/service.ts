import type { Pool } from "pg"
import {
  permissionsForRole,
  WORKSPACE_USER_ROLES,
  type WorkspacePermissionSlug,
  type WorkspaceRoleSlug,
} from "@threa/types"
import { logger, serializeBigInt, type WorkosMembershipStatus } from "@threa/backend-common"
import { withTransaction } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { UserRepository } from "../workspaces"
import { WorkspaceUserPermissionsRepository } from "./repository"

export interface ApplyMembershipChangeInput {
  workspaceId: string
  workosUserId: string
  roleSlugs: string[]
  status: WorkosMembershipStatus
  lastEventAt: Date
}

export interface ApplyMembershipRemovalInput {
  workspaceId: string
  workosUserId: string
  eventCreatedAt: Date
}

interface Dependencies {
  pool: Pool
}

const KNOWN_ROLE_SLUGS: ReadonlySet<string> = new Set(WORKSPACE_USER_ROLES)

function isWorkspaceRoleSlug(value: string): value is WorkspaceRoleSlug {
  return KNOWN_ROLE_SLUGS.has(value)
}

/**
 * Union the permission set granted by every recognized role on a mirror row.
 * Unknown role slugs are skipped so a WorkOS dashboard role added ahead of a
 * code release degrades gracefully (caller falls through to 403).
 */
export function expandRoleSlugs(roleSlugs: readonly string[]): WorkspacePermissionSlug[] {
  const union = new Set<WorkspacePermissionSlug>()
  for (const slug of roleSlugs) {
    if (!isWorkspaceRoleSlug(slug)) continue
    for (const perm of permissionsForRole(slug)) {
      union.add(perm)
    }
  }
  return [...union]
}

/**
 * Applies CP fan-out events to the regional `workspace_user_permissions`
 * mirror, and exposes the read paths for permission checks. Permissions are
 * derived from `role_slugs` at request time, so stored state stays minimal.
 */
export class WorkspaceAuthzService {
  private pool: Pool

  constructor({ pool }: Dependencies) {
    this.pool = pool
  }

  async applyMembershipChange(input: ApplyMembershipChangeInput): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const updated = await WorkspaceUserPermissionsRepository.upsert(client, input)
      if (!updated) {
        logger.debug(
          { workspaceId: input.workspaceId, workosUserId: input.workosUserId },
          "workspace_user_permissions upsert ignored as stale"
        )
        return
      }

      // A non-active membership (inactive/pending) derives no role from the
      // mirror: the user read's JOIN is gated on status='active', so loading the
      // user here would fall back to the stale users.role and broadcast the
      // pre-change role — the opposite of this fix's intent. Deactivation is
      // surfaced through the removal/credential paths, not this freshness
      // broadcast, so skip non-active transitions (the same status gate
      // resolveActivePermissions applies).
      if (updated.status !== "active") {
        logger.debug(
          { workspaceId: input.workspaceId, workosUserId: input.workosUserId, status: updated.status },
          "workspace_user_permissions upsert is non-active; skipping broadcast"
        )
        return
      }

      // Role is derived from the mirror at read time, so the user loaded here —
      // in the SAME transaction, after the upsert — already carries the freshly
      // applied role. Broadcasting it keeps every connected client's cached
      // role current (e.g. a demoted admin loses the admin UI) without waiting
      // for a reconnect or reload (INV-4/INV-7).
      const user = await UserRepository.findByWorkosUserIdInWorkspace(client, input.workspaceId, input.workosUserId)
      if (!user) {
        // Mirror landed before the regional user row (e.g. between invite
        // acceptance and the next WorkOS poll). There is nothing to broadcast
        // yet; the user's first read will derive the role from the mirror.
        logger.debug(
          { workspaceId: input.workspaceId, workosUserId: input.workosUserId },
          "workspace_user_permissions upsert applied before user row exists; skipping broadcast"
        )
        return
      }

      await OutboxRepository.insert(client, "workspace_user:updated", {
        workspaceId: input.workspaceId,
        user: serializeBigInt(user),
      })
    })
  }

  async applyMembershipRemoval(input: ApplyMembershipRemovalInput): Promise<void> {
    const removed = await WorkspaceUserPermissionsRepository.delete(this.pool, input)
    if (!removed) {
      logger.debug(
        { workspaceId: input.workspaceId, workosUserId: input.workosUserId },
        "workspace_user_permissions delete ignored as stale"
      )
    }
  }

  /**
   * Resolve the active permission set for a workspace user from the mirror.
   * Returns `null` when the user has no active mirror row — callers should
   * treat this as "credential no longer usable" (401), not "missing
   * permission" (403).
   */
  async resolveActivePermissions(workspaceId: string, workosUserId: string): Promise<WorkspacePermissionSlug[] | null> {
    const mirror = await WorkspaceUserPermissionsRepository.getByWorkspaceAndUser(this.pool, workspaceId, workosUserId)
    if (!mirror || mirror.status !== "active") return null
    return expandRoleSlugs(mirror.roleSlugs)
  }
}
