import type { Request, Response } from "express"
import { orgWorkspaceClaimSchema, orgWorkspaceEnsureSchema } from "@threahq/types"
import { validateRequest } from "../../lib/validation"
import type { WorkspaceService } from "./service"

interface Dependencies {
  workspaceService: WorkspaceService
}

export function createOrgWorkspaceHandlers({ workspaceService }: Dependencies) {
  return {
    /** Control-plane fan-out: idempotent, so the outbox can replay it and repeat shares add only new people. */
    async ensure(req: Request, res: Response) {
      const params = validateRequest(orgWorkspaceEnsureSchema, req.body)
      await workspaceService.ensureOrgWorkspaceFromControlPlane(params)
      res.status(200).json({ workspaceId: params.workspaceId })
    },

    /** Control-plane claim: converges on replay, so the outbox can retry it. */
    async claim(req: Request, res: Response) {
      const params = validateRequest(orgWorkspaceClaimSchema, req.body)
      await workspaceService.claimOrgWorkspaceFromControlPlane(params)
      res.status(200).json({ workspaceId: params.workspaceId })
    },
  }
}
