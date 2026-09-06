import type { Request, Response } from "express"
import { z } from "zod/v4"
import type { Pool } from "pg"
import { HttpError } from "@threahq/backend-common"
import { WORKSPACE_USER_ROLES } from "@threahq/types"
import type { AdminActor, WorkosAuthzAdminService } from "./admin-service"
import { WorkspaceRegistryRepository } from "../workspaces"

interface Dependencies {
  pool: Pool
  adminService: WorkosAuthzAdminService
}

const roleSlugSchema = z.enum(WORKSPACE_USER_ROLES)

const internalActor = z.object({ workosUserId: z.string().min(1) })

const internalChangeRoleBody = z.object({
  actor: internalActor,
  roleSlug: roleSlugSchema,
})

const internalRemoveBody = z.object({
  actor: internalActor,
})

const backofficeChangeRoleBody = z.object({
  roleSlug: roleSlugSchema,
})

const backofficeAssignBody = z.object({
  workosUserId: z.string().min(1),
  roleSlug: roleSlugSchema,
})

async function resolveOrganizationId(pool: Pool, workspaceId: string): Promise<string> {
  const orgId = await WorkspaceRegistryRepository.getWorkosOrganizationId(pool, workspaceId)
  if (!orgId) {
    throw new HttpError("Workspace not linked to a WorkOS organization", {
      status: 404,
      code: "NOT_LINKED",
    })
  }
  return orgId
}

function requireParam(value: string | undefined, name: string): string {
  if (!value) {
    throw new HttpError(`Missing ${name}`, { status: 400, code: "VALIDATION_ERROR" })
  }
  return value
}

// `isPlatformAdmin` is hard-coded `false` here: the platform-admin bypass is
// only reachable via the backoffice surface, which gates on
// `requirePlatformAdmin`.
export function createInternalAuthzAdminHandlers({ pool, adminService }: Dependencies) {
  return {
    async changeRole(req: Request, res: Response): Promise<void> {
      const workspaceId = requireParam(req.params.workspaceId, "workspaceId")
      const targetUserId = requireParam(req.params.userId, "userId")
      const parsed = internalChangeRoleBody.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }
      const organizationId = await resolveOrganizationId(pool, workspaceId)
      const actor: AdminActor = { workosUserId: parsed.data.actor.workosUserId, isPlatformAdmin: false }
      await adminService.changeRole({
        actor,
        organizationId,
        targetUserId,
        roleSlug: parsed.data.roleSlug,
      })
      res.status(204).end()
    },

    async removeMember(req: Request, res: Response): Promise<void> {
      const workspaceId = requireParam(req.params.workspaceId, "workspaceId")
      const targetUserId = requireParam(req.params.userId, "userId")
      const parsed = internalRemoveBody.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }
      const organizationId = await resolveOrganizationId(pool, workspaceId)
      const actor: AdminActor = { workosUserId: parsed.data.actor.workosUserId, isPlatformAdmin: false }
      await adminService.removeMember({
        actor,
        organizationId,
        targetUserId,
      })
      res.status(204).end()
    },
  }
}

// Platform admin is set true here, but the admin service still applies
// last-owner / self-demote guards so a platform admin can't orphan a
// workspace.
export function createBackofficeAuthzAdminHandlers({ pool, adminService }: Dependencies) {
  return {
    async assignMember(req: Request, res: Response): Promise<void> {
      if (!req.authUser) {
        throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
      }
      const workspaceId = requireParam(req.params.id, "workspaceId")
      const parsed = backofficeAssignBody.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }
      const organizationId = await resolveOrganizationId(pool, workspaceId)
      const actor: AdminActor = { workosUserId: req.authUser.id, isPlatformAdmin: true }
      await adminService.assignRole({
        actor,
        organizationId,
        targetUserId: parsed.data.workosUserId,
        roleSlug: parsed.data.roleSlug,
      })
      res.status(204).end()
    },

    async changeRole(req: Request, res: Response): Promise<void> {
      if (!req.authUser) {
        throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
      }
      const workspaceId = requireParam(req.params.id, "workspaceId")
      const targetUserId = requireParam(req.params.userId, "userId")
      const parsed = backofficeChangeRoleBody.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }
      const organizationId = await resolveOrganizationId(pool, workspaceId)
      const actor: AdminActor = { workosUserId: req.authUser.id, isPlatformAdmin: true }
      await adminService.changeRole({
        actor,
        organizationId,
        targetUserId,
        roleSlug: parsed.data.roleSlug,
      })
      res.status(204).end()
    },

    async removeMember(req: Request, res: Response): Promise<void> {
      if (!req.authUser) {
        throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
      }
      const workspaceId = requireParam(req.params.id, "workspaceId")
      const targetUserId = requireParam(req.params.userId, "userId")
      const organizationId = await resolveOrganizationId(pool, workspaceId)
      const actor: AdminActor = { workosUserId: req.authUser.id, isPlatformAdmin: true }
      await adminService.removeMember({
        actor,
        organizationId,
        targetUserId,
      })
      res.status(204).end()
    },
  }
}
