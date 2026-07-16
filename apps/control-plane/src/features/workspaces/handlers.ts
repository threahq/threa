import type { Request, Response } from "express"
import { z } from "zod/v4"
import { HttpError } from "@threa/backend-common"
import type { ControlPlaneWorkspaceService } from "./service"
import type { InvitationShadowService } from "../invitation-shadows"

interface Dependencies {
  workspaceService: ControlPlaneWorkspaceService
  shadowService: InvitationShadowService
}

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
  region: z.string().min(1).optional(),
  // The creator's IANA zone; the region seeds the workspace's billing timezone
  // from it. Bounded but not resolved here — the control plane never draws a
  // month, and the regional backend re-validates before storing.
  timezone: z.string().min(1).max(64).optional(),
})

export function createWorkspaceHandlers({ workspaceService, shadowService }: Dependencies) {
  return {
    async list(req: Request, res: Response) {
      if (!req.workosUserId) {
        throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
      }

      const [workspaces, pendingInvitations] = await Promise.all([
        workspaceService.listForUser(req.workosUserId),
        req.authUser?.email ? shadowService.listPendingForEmail(req.authUser.email) : [],
      ])
      res.json({ workspaces, pendingInvitations })
    },

    async create(req: Request, res: Response) {
      if (!req.workosUserId || !req.authUser) {
        throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
      }

      const parsed = createWorkspaceSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }

      const workspace = await workspaceService.create({
        name: parsed.data.name,
        region: parsed.data.region,
        timezone: parsed.data.timezone,
        workosUserId: req.workosUserId,
        authUser: req.authUser,
      })

      res.status(201).json({ workspace })
    },

    async listRegions(_req: Request, res: Response) {
      res.json({ regions: workspaceService.listRegions() })
    },

    async getRegion(req: Request, res: Response) {
      const region = await workspaceService.getRegion(req.params.workspaceId)
      if (!region) {
        throw new HttpError("Workspace not found", { status: 404, code: "NOT_FOUND" })
      }
      res.json({ region })
    },

    async confirmMembership(req: Request, res: Response) {
      const { workspaceId, workosUserId } = req.params
      if (!workspaceId || !workosUserId) {
        throw new HttpError("Missing workspaceId or workosUserId", { status: 400, code: "VALIDATION_ERROR" })
      }
      const member = await workspaceService.isMember(workspaceId, workosUserId)
      res.json({ member })
    },
  }
}
