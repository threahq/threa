import type { NextFunction, Request, Response } from "express"
import { z } from "zod"
import { HttpError } from "../../lib/errors"
import type { PlatformAdminService } from "./service"

const syncSchema = z.object({
  workspaceId: z.string().min(1),
  workosUserId: z.string().min(1),
  isPlatformAdmin: z.boolean(),
})

interface Dependencies {
  platformAdminService: PlatformAdminService
}

export function createPlatformAdminHandlers({ platformAdminService }: Dependencies) {
  return {
    /**
     * POST /internal/platform-admin
     * CP fan-out endpoint: replace one workspace user's platform-admin mirror
     * row in this region (grant upserts, revoke deletes — idempotent).
     */
    async sync(req: Request, res: Response, next: NextFunction) {
      const result = syncSchema.safeParse(req.body)
      if (!result.success) {
        next(new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" }))
        return
      }

      await platformAdminService.applySync(result.data)
      res.status(204).end()
    },
  }
}
