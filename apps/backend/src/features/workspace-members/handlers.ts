import type { Request, Response } from "express"
import { z } from "zod"
import type { Pool } from "pg"
import { WORKSPACE_USER_ROLES } from "@threahq/types"
import { HttpError } from "../../lib/errors"
import type { ControlPlaneClient } from "../../lib/control-plane-client"
import { UserRepository } from "../workspaces"

interface Dependencies {
  pool: Pool
  controlPlaneClient: ControlPlaneClient | null
}

const changeRoleBody = z.object({
  roleSlug: z.enum(WORKSPACE_USER_ROLES),
})

async function resolveTargetWorkosUserId(pool: Pool, workspaceId: string, userId: string): Promise<string> {
  const user = await UserRepository.findById(pool, workspaceId, userId)
  if (!user) {
    throw new HttpError("User not found in workspace", { status: 404, code: "NOT_FOUND" })
  }
  return user.workosUserId
}

function requireControlPlane(client: ControlPlaneClient | null): ControlPlaneClient {
  if (!client) {
    throw new HttpError("Control plane is not configured for this regional backend", {
      status: 503,
      code: "CONTROL_PLANE_UNAVAILABLE",
    })
  }
  return client
}

// Pass-through to the control plane: WorkOS is the source of truth and the
// CP event poller fans changes back into the regional mirror under INV-20
// timestamp guards, so we never write to the local mirror here.
export function createWorkspaceMemberManagementHandlers({ pool, controlPlaneClient }: Dependencies) {
  return {
    async changeRole(req: Request, res: Response): Promise<void> {
      const workspaceId = req.workspaceId
      const actorWorkosUserId = req.user?.workosUserId
      const targetUserRowId = req.params.userId
      if (!workspaceId || !actorWorkosUserId) {
        throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
      }
      if (!targetUserRowId) {
        throw new HttpError("Missing userId", { status: 400, code: "VALIDATION_ERROR" })
      }
      const parsed = changeRoleBody.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }

      const cp = requireControlPlane(controlPlaneClient)
      const targetWorkosUserId = await resolveTargetWorkosUserId(pool, workspaceId, targetUserRowId)
      await cp.changeWorkspaceMemberRole({
        workspaceId,
        targetUserId: targetWorkosUserId,
        actorWorkosUserId,
        roleSlug: parsed.data.roleSlug,
      })

      res.status(204).end()
    },

    async removeMember(req: Request, res: Response): Promise<void> {
      const workspaceId = req.workspaceId
      const actorWorkosUserId = req.user?.workosUserId
      const targetUserRowId = req.params.userId
      if (!workspaceId || !actorWorkosUserId) {
        throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
      }
      if (!targetUserRowId) {
        throw new HttpError("Missing userId", { status: 400, code: "VALIDATION_ERROR" })
      }

      const cp = requireControlPlane(controlPlaneClient)
      const targetWorkosUserId = await resolveTargetWorkosUserId(pool, workspaceId, targetUserRowId)
      await cp.removeWorkspaceMember({
        workspaceId,
        targetUserId: targetWorkosUserId,
        actorWorkosUserId,
      })

      res.status(204).end()
    },
  }
}
