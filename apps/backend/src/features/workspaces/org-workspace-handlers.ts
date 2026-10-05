import type { Request, Response } from "express"
import { orgWorkspaceEnsureSchema } from "@threahq/types"
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
  }
}
