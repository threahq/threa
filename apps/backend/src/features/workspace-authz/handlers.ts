import type { NextFunction, Request, Response } from "express"
import { z } from "zod"
import { WORKOS_MEMBERSHIP_STATUSES } from "@threa/backend-common"
import { HttpError } from "../../lib/errors"
import type { WorkspaceAuthzService } from "./service"

const upsertSchema = z.object({
  kind: z.literal("upsert"),
  workspaceId: z.string().min(1),
  workosUserId: z.string().min(1),
  // Role slugs are not constrained: WorkOS dashboard can introduce a new role
  // ahead of a code release, and `expandRoleSlugs` is intentionally tolerant
  // (skips unknown slugs). Validation happens at expansion time.
  roleSlugs: z.array(z.string().min(1)),
  status: z.enum(WORKOS_MEMBERSHIP_STATUSES),
  lastEventAt: z.string().datetime(),
})

const removeSchema = z.object({
  kind: z.literal("remove"),
  workspaceId: z.string().min(1),
  workosUserId: z.string().min(1),
  eventCreatedAt: z.string().datetime(),
})

const bodySchema = z.discriminatedUnion("kind", [upsertSchema, removeSchema])

interface Dependencies {
  workspaceAuthzService: WorkspaceAuthzService
}

export function createWorkspaceAuthzHandlers({ workspaceAuthzService }: Dependencies) {
  return {
    /** CP fan-out endpoint for membership changes within this region. */
    async syncMembership(req: Request, res: Response, next: NextFunction) {
      const result = bodySchema.safeParse(req.body)
      if (!result.success) {
        next(new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" }))
        return
      }

      if (result.data.kind === "upsert") {
        await workspaceAuthzService.applyMembershipChange({
          workspaceId: result.data.workspaceId,
          workosUserId: result.data.workosUserId,
          roleSlugs: result.data.roleSlugs,
          status: result.data.status,
          lastEventAt: new Date(result.data.lastEventAt),
        })
      } else {
        await workspaceAuthzService.applyMembershipRemoval({
          workspaceId: result.data.workspaceId,
          workosUserId: result.data.workosUserId,
          eventCreatedAt: new Date(result.data.eventCreatedAt),
        })
      }

      res.status(204).end()
    },
  }
}
