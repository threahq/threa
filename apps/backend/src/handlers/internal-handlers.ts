import type { Request, Response } from "express"
import { z } from "zod"
import { HttpError } from "../lib/errors"
import type { WorkspaceService } from "../features/workspaces"
import type { InvitationService } from "../features/invitations"

const createWorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
  ownerWorkosUserId: z.string().min(1),
  ownerEmail: z.string().email(),
  ownerName: z.string().min(1),
})

const acceptInvitationSchema = z.object({
  workosUserId: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
})

interface InternalHandlersDeps {
  workspaceService: WorkspaceService
  invitationService: InvitationService
}

export function createInternalHandlers(deps: InternalHandlersDeps) {
  const { workspaceService, invitationService } = deps

  return {
    /**
     * Called by the control-plane to create a workspace in this region.
     * Accepts a pre-generated workspace ID and slug.
     */
    async createWorkspace(req: Request, res: Response) {
      const result = createWorkspaceSchema.safeParse(req.body)
      if (!result.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }

      const { id, name, slug, ownerWorkosUserId, ownerEmail, ownerName } = result.data

      const workspace = await workspaceService.createWorkspaceFromControlPlane({
        id,
        name,
        slug,
        ownerWorkosUserId,
        ownerEmail,
        ownerName,
      })

      res.status(201).json({ workspace })
    },

    /** Called by the control-plane to accept a specific invitation in this region. */
    async acceptInvitation(req: Request, res: Response) {
      const invitationId = req.params.id
      if (!invitationId) {
        throw new HttpError("Missing invitation ID", { status: 400, code: "MISSING_INVITATION_ID" })
      }

      const result = acceptInvitationSchema.safeParse(req.body)
      if (!result.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }

      const workspaceId = await invitationService.acceptInvitation(invitationId, result.data)

      if (!workspaceId) {
        throw new HttpError("Invitation not found or already processed", {
          status: 404,
          code: "INVITATION_NOT_FOUND",
        })
      }

      res.status(200).json({ workspaceId })
    },
  }
}
