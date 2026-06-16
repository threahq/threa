import type { Pool } from "pg"
import { HttpError, logger, type WorkosOrganizationMembership, type WorkosOrgService } from "@threa/backend-common"
import { rolesGrant, WORKSPACE_PERMISSION_SCOPES, WORKSPACE_USER_ROLES, type WorkspaceRoleSlug } from "@threa/types"
import { withOrganizationAdminLock } from "./org-admin-lock"

interface Dependencies {
  pool: Pool
  workosOrgService: WorkosOrgService
}

/**
 * The user performing an admin action. `isPlatformAdmin` is set by the
 * backoffice surface (gated on `requirePlatformAdmin`) and bypasses the
 * permission check, while data-integrity guards (last-owner, self-demote)
 * still apply. Regional surfaces pass `isPlatformAdmin: false`; the regional
 * `requireWorkspacePermission('members:write')` middleware is the first gate
 * and `assertActorMayManage` here is the second. Ownership-touching ops add
 * a third gate that requires the actor to hold the `workspace:owner`
 * permission. Both gates derive from permissions, never from role slug.
 */
export interface AdminActor {
  workosUserId: string
  isPlatformAdmin: boolean
}

export interface AssignRoleParams {
  actor: AdminActor
  organizationId: string
  targetUserId: string
  roleSlug: WorkspaceRoleSlug
}

export interface ChangeRoleParams {
  actor: AdminActor
  organizationId: string
  targetUserId: string
  roleSlug: WorkspaceRoleSlug
}

export interface RemoveMemberParams {
  actor: AdminActor
  organizationId: string
  targetUserId: string
}

/**
 * Write paths for WorkOS organization memberships.
 *
 * Concurrency model: every write acquires a per-organization advisory lock
 * via `withOrganizationAdminLock`, then reads the *authoritative* membership
 * list from WorkOS (not the local mirror, which is async-updated by the event
 * poller and would be stale here). All guards — actor permission, target
 * lookup, last-owner protection — derive from that single fresh snapshot.
 *
 * This is intentional: a check-then-act against the mirror is INV-20-unsafe
 * because the mirror's `last_event_at` only advances after the poller picks
 * up the WorkOS event, so two concurrent admin writes both see the pre-write
 * state. The lock + WorkOS read makes the guard transactional from the
 * caller's perspective.
 *
 * The poller continues to be the canonical mirror updater; this path does not
 * write to the mirror.
 */
export class WorkosAuthzAdminService {
  private pool: Pool
  private workosOrgService: WorkosOrgService

  constructor({ pool, workosOrgService }: Dependencies) {
    this.pool = pool
    this.workosOrgService = workosOrgService
  }

  async assignRole(params: AssignRoleParams): Promise<void> {
    assertKnownRole(params.roleSlug)
    await withOrganizationAdminLock(this.pool, params.organizationId, async () => {
      const memberships = await this.workosOrgService.listOrganizationMemberships(params.organizationId)
      this.assertActorMayManage(params.actor, memberships)

      // Promotion to owner via assign is allowed (this is how a new owner gets
      // their first membership). Demotion of an existing owner is a
      // `changeRole` concern and is guarded there.
      await this.workosOrgService.ensureOrganizationMembership({
        organizationId: params.organizationId,
        userId: params.targetUserId,
        roleSlug: params.roleSlug,
      })
      logger.info(
        {
          actor: params.actor.workosUserId,
          organizationId: params.organizationId,
          targetUserId: params.targetUserId,
          roleSlug: params.roleSlug,
        },
        "WorkosAuthzAdminService: assignRole"
      )
    })
  }

  async changeRole(params: ChangeRoleParams): Promise<void> {
    assertKnownRole(params.roleSlug)
    await withOrganizationAdminLock(this.pool, params.organizationId, async () => {
      const memberships = await this.workosOrgService.listOrganizationMemberships(params.organizationId)
      this.assertActorMayManage(params.actor, memberships)

      const target = requireTargetMembership(memberships, params.targetUserId)
      const targetIsOwner = rolesGrant(target.roleSlugs, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_OWNER)
      const newRoleIsOwner = rolesGrant([params.roleSlug], WORKSPACE_PERMISSION_SCOPES.WORKSPACE_OWNER)

      if (targetIsOwner || newRoleIsOwner) {
        this.assertActorMayTouchOwnership(params.actor, memberships)
      }

      if (targetIsOwner && !newRoleIsOwner) {
        this.assertNotSelfDemote(params.actor, params.targetUserId)
        this.assertNotLastOwner(memberships, params.targetUserId)
      }

      await this.workosOrgService.changeOrganizationMembershipRole({
        organizationMembershipId: target.id,
        roleSlug: params.roleSlug,
      })
      logger.info(
        {
          actor: params.actor.workosUserId,
          organizationId: params.organizationId,
          targetUserId: params.targetUserId,
          fromRoles: target.roleSlugs,
          toRole: params.roleSlug,
        },
        "WorkosAuthzAdminService: changeRole"
      )
    })
  }

  async removeMember(params: RemoveMemberParams): Promise<void> {
    await withOrganizationAdminLock(this.pool, params.organizationId, async () => {
      const memberships = await this.workosOrgService.listOrganizationMemberships(params.organizationId)
      this.assertActorMayManage(params.actor, memberships)

      const target = requireTargetMembership(memberships, params.targetUserId)
      this.assertNotSelfDemote(params.actor, params.targetUserId)
      if (rolesGrant(target.roleSlugs, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_OWNER)) {
        this.assertActorMayTouchOwnership(params.actor, memberships)
        this.assertNotLastOwner(memberships, params.targetUserId)
      }

      await this.workosOrgService.removeOrganizationMembership(target.id)
      logger.info(
        {
          actor: params.actor.workosUserId,
          organizationId: params.organizationId,
          targetUserId: params.targetUserId,
        },
        "WorkosAuthzAdminService: removeMember"
      )
    })
  }

  // Guards all derive from a single WorkOS snapshot taken under the per-org
  // advisory lock.
  private assertActorMayManage(actor: AdminActor, memberships: WorkosOrganizationMembership[]): void {
    if (actor.isPlatformAdmin) return
    const actorMembership = memberships.find((m) => m.userId === actor.workosUserId)
    if (!actorMembership || !rolesGrant(actorMembership.roleSlugs, WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE)) {
      throw new HttpError("Actor lacks members:write permission", {
        status: 403,
        code: "FORBIDDEN",
      })
    }
  }

  private assertActorMayTouchOwnership(actor: AdminActor, memberships: WorkosOrganizationMembership[]): void {
    if (actor.isPlatformAdmin) return
    const actorMembership = memberships.find((m) => m.userId === actor.workosUserId)
    if (!actorMembership || !rolesGrant(actorMembership.roleSlugs, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_OWNER)) {
      throw new HttpError("Actor lacks workspace:owner permission", {
        status: 403,
        code: "OWNER_ACTION",
      })
    }
  }

  private assertNotSelfDemote(actor: AdminActor, targetUserId: string): void {
    if (actor.workosUserId === targetUserId) {
      throw new HttpError("Owners cannot demote or remove themselves; transfer ownership first", {
        status: 422,
        code: "SELF_DEMOTE",
      })
    }
  }

  private assertNotLastOwner(memberships: WorkosOrganizationMembership[], targetUserId: string): void {
    const remainingOwners = memberships.filter(
      (m) => m.userId !== targetUserId && rolesGrant(m.roleSlugs, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_OWNER)
    ).length
    if (remainingOwners === 0) {
      throw new HttpError("Cannot leave the workspace without an owner", {
        status: 422,
        code: "LAST_OWNER",
      })
    }
  }
}

function requireTargetMembership(
  memberships: WorkosOrganizationMembership[],
  targetUserId: string
): WorkosOrganizationMembership {
  const target = memberships.find((m) => m.userId === targetUserId)
  if (!target) {
    throw new HttpError("Target member not found", { status: 404, code: "NOT_FOUND" })
  }
  return target
}

function assertKnownRole(slug: string): asserts slug is WorkspaceRoleSlug {
  if (!WORKSPACE_USER_ROLES.includes(slug as WorkspaceRoleSlug)) {
    throw new HttpError(`Unknown workspace role: ${slug}`, { status: 400, code: "INVALID_ROLE" })
  }
}
