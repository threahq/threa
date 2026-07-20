import type { NextFunction, Request, Response } from "express"
import { z } from "zod"
import { FEATURE_FLAG_SCOPES } from "@threa/types"
import { HttpError } from "../../lib/errors"
import type { FeatureFlagService } from "./service"

// Flag keys/values are not constrained to the registry here: the control
// plane can deploy with a new key or value ahead of this region's release.
// Unknown entries are stored and ignored at read time (resolveFeatureFlags
// filters them). subjectType IS constrained — it selects the storage layer,
// and derives from the shared scope list so a new scope can't silently DLQ.
const syncSchema = z.object({
  workspaceId: z.string().min(1),
  subjectType: z.enum(FEATURE_FLAG_SCOPES),
  subjectId: z.string().min(1),
  overrides: z.record(z.string().min(1), z.string().min(1)),
})

interface Dependencies {
  featureFlagService: FeatureFlagService
}

export function createFeatureFlagHandlers({ featureFlagService }: Dependencies) {
  return {
    /** CP fan-out endpoint: replace one subject's flag overrides in this region. */
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
