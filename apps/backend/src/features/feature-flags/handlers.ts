import type { NextFunction, Request, Response } from "express"
import { z } from "zod"
import { HttpError } from "../../lib/errors"
import type { FeatureFlagService } from "./service"

// Flag keys/values are not constrained to the registry here: the control
// plane can deploy with a new key or value ahead of this region's release.
// Unknown entries are stored and ignored at read time (resolveFeatureFlags
// filters them).
const syncSchema = z.object({
  workspaceId: z.string().min(1),
  workosUserId: z.string().min(1),
  flags: z.record(z.string().min(1), z.string().min(1)),
})

interface Dependencies {
  featureFlagService: FeatureFlagService
}

export function createFeatureFlagHandlers({ featureFlagService }: Dependencies) {
  return {
    /**
     * POST /internal/feature-flags
     * CP fan-out endpoint: replace one user's flag snapshot in this region.
     */
    async sync(req: Request, res: Response, next: NextFunction) {
      const result = syncSchema.safeParse(req.body)
      if (!result.success) {
        next(new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" }))
        return
      }

      await featureFlagService.applySync(result.data)
      res.status(204).end()
    },
  }
}
