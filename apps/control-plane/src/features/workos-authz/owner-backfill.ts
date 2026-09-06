import type { Pool } from "pg"
import { logger } from "@threahq/backend-common"
import { WORKSPACE_ROLE_SLUGS } from "@threahq/types"
import { WorkspaceRegistryRepository } from "../workspaces"
import type { AdminActor, WorkosAuthzAdminService } from "./admin-service"
import { WorkosAuthzRepository } from "./repository"

export interface WorkspaceOwnerBackfillOptions {
  /** When true, classify candidates but skip the WorkOS mutation. */
  dryRun?: boolean
}

export interface WorkspaceOwnerBackfillResult {
  workspacesScanned: number
  alreadyOwners: number
  upgraded: number
  newlyAssigned: number
  errors: Array<{ workspaceId: string; error: string }>
}

/**
 * One-shot data correction: assign the `owner` role to every workspace creator
 * who isn't already an owner in the WorkOS mirror. Idempotent — re-running
 * after a successful pass reports zero changes.
 *
 * Two paths per candidate:
 * - Mirror has a row at a lower role → `changeRole` (preserves membership id)
 * - Mirror has no row at all → `assignRole` (creates a fresh membership)
 *
 * The mirror catches up asynchronously through the regular event poller.
 */
export class WorkspaceOwnerBackfill {
  constructor(
    private pool: Pool,
    private adminService: WorkosAuthzAdminService,
    private actor: AdminActor
  ) {}

  async run(options: WorkspaceOwnerBackfillOptions = {}): Promise<WorkspaceOwnerBackfillResult> {
    const scanned = await WorkspaceRegistryRepository.countWithWorkosOrganizationId(this.pool)
    const candidates = await WorkosAuthzRepository.findWorkspaceCreatorsMissingOwnerRole(this.pool)

    const result: WorkspaceOwnerBackfillResult = {
      workspacesScanned: scanned,
      alreadyOwners: scanned - candidates.length,
      upgraded: 0,
      newlyAssigned: 0,
      errors: [],
    }

    for (const candidate of candidates) {
      const hasExistingMembership = candidate.organizationMembershipId !== null

      if (options.dryRun) {
        if (hasExistingMembership) result.upgraded += 1
        else result.newlyAssigned += 1
        logger.info(
          {
            workspaceId: candidate.workspaceId,
            createdBy: candidate.createdByWorkosUserId,
            currentRoles: candidate.roleSlugs,
            action: hasExistingMembership ? "upgrade" : "newlyAssign",
          },
          "WorkspaceOwnerBackfill: would assign owner (dry-run)"
        )
        continue
      }

      try {
        if (hasExistingMembership) {
          await this.adminService.changeRole({
            actor: this.actor,
            organizationId: candidate.workosOrganizationId,
            targetUserId: candidate.createdByWorkosUserId,
            roleSlug: WORKSPACE_ROLE_SLUGS.OWNER,
          })
          result.upgraded += 1
        } else {
          await this.adminService.assignRole({
            actor: this.actor,
            organizationId: candidate.workosOrganizationId,
            targetUserId: candidate.createdByWorkosUserId,
            roleSlug: WORKSPACE_ROLE_SLUGS.OWNER,
          })
          result.newlyAssigned += 1
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        result.errors.push({ workspaceId: candidate.workspaceId, error: message })
        logger.error(
          { err, workspaceId: candidate.workspaceId, createdBy: candidate.createdByWorkosUserId },
          "WorkspaceOwnerBackfill: failed to assign owner"
        )
      }
    }

    return result
  }
}
