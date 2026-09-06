import type { Request, Response, NextFunction } from "express"
import type { Pool } from "pg"
import { displayNameFromWorkos, logger } from "@threahq/backend-common"
import { WORKSPACE_ROLE_SLUGS } from "@threahq/types"
import { UserRepository, type User, type WorkspaceService } from "../features/workspaces"
import type { ControlPlaneClient } from "../lib/control-plane-client"

declare global {
  namespace Express {
    interface Request {
      workspaceId?: string
      user?: User
    }
  }
}

interface Dependencies {
  pool: Pool
  workspaceService: WorkspaceService
  controlPlaneClient: ControlPlaneClient | null
}

export function createWorkspaceUserMiddleware({ pool, workspaceService, controlPlaneClient }: Dependencies) {
  return async function workspaceUserMiddleware(req: Request, res: Response, next: NextFunction) {
    const { workspaceId } = req.params

    if (!workspaceId) {
      return next()
    }

    const workosUserId = req.workosUserId
    if (!workosUserId) {
      return res.status(401).json({ error: "Not authenticated" })
    }

    const access = await UserRepository.findWorkspaceUserAccess(pool, workspaceId, workosUserId)
    if (!access.workspaceExists) {
      return res.status(404).json({ error: "Workspace not found" })
    }

    let user = access.user
    if (!user) {
      // No regional `users` row. The control plane is the source of truth for
      // membership: if this region's DB drifted behind it (failed accept-sync,
      // restored snapshot) a confirmed member would otherwise be permanently
      // 403'd. Self-heal by re-provisioning from the CP's confirmation.
      user = await selfHealMissingUser({
        workspaceService,
        controlPlaneClient,
        workspaceId,
        workosUserId,
        authUser: req.authUser,
      })
    }

    if (!user) {
      return res.status(403).json({ error: "Not a user in this workspace" })
    }

    req.workspaceId = workspaceId
    req.user = user
    next()
  }
}

async function selfHealMissingUser(params: {
  workspaceService: WorkspaceService
  controlPlaneClient: ControlPlaneClient | null
  workspaceId: string
  workosUserId: string
  authUser: Request["authUser"]
}): Promise<User | null> {
  const { workspaceService, controlPlaneClient, workspaceId, workosUserId, authUser } = params

  // Need WorkOS identity to provision (email/name) and the CP client to
  // confirm membership. Without either, fail closed with the 403.
  if (!authUser || !controlPlaneClient) {
    return null
  }

  let member: boolean
  try {
    const result = await controlPlaneClient.getWorkspaceMembership({ workspaceId, workosUserId })
    member = result.member
  } catch (error) {
    // CP unreachable / non-2xx — fail closed rather than fabricate access.
    logger.error(
      { err: error, workspaceId, workosUserId },
      "Self-heal aborted: could not confirm workspace membership with control plane"
    )
    return null
  }

  if (!member) {
    return null
  }

  const user = await workspaceService.ensureUserProvisioned({
    workspaceId,
    workosUserId,
    email: authUser.email,
    name: displayNameFromWorkos(authUser),
    role: WORKSPACE_ROLE_SLUGS.MEMBER,
  })
  logger.info({ workspaceId, workosUserId, userId: user.id }, "Self-healed missing regional user from control plane")
  return user
}
