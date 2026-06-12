import type { Request, Response } from "express"
import { z } from "zod/v4"
import { HttpError } from "@threa/backend-common"
import { FEATURE_FLAGS, FEATURE_FLAG_KEYS } from "@threa/types"
import type { ControlPlaneFeatureFlagService } from "./service"

const setFlagSchema = z.object({
  workosUserId: z.string().min(1),
  flagKey: z.string().min(1),
  /** Must be one of the flag's declared values; the default (first) value clears the override. */
  value: z.string().min(1),
})

interface Dependencies {
  featureFlagService: ControlPlaneFeatureFlagService
}

export function createFeatureFlagHandlers({ featureFlagService }: Dependencies) {
  return {
    /**
     * GET /api/backoffice/workspaces/:id/feature-flags
     * Registry (key + declared values, first value is the default) plus the
     * stored per-user overrides. The backoffice renders the member × flag
     * grid from these two lists.
     */
    async listWorkspaceFlags(req: Request, res: Response) {
      const id = req.params.id
      if (!id) {
        throw new HttpError("Missing workspace id", { status: 400, code: "VALIDATION_ERROR" })
      }
      const overrides = await featureFlagService.listWorkspaceOverrides(id)
      res.json({
        flags: FEATURE_FLAG_KEYS.map((key) => ({ key, values: FEATURE_FLAGS[key] })),
        overrides: overrides.map((o) => ({
          workosUserId: o.workosUserId,
          flagKey: o.flagKey,
          value: o.value,
          updatedAt: o.updatedAt.toISOString(),
        })),
      })
    },

    /** PUT /api/backoffice/workspaces/:id/feature-flags */
    async setWorkspaceFlag(req: Request, res: Response) {
      const id = req.params.id
      if (!id) {
        throw new HttpError("Missing workspace id", { status: 400, code: "VALIDATION_ERROR" })
      }
      const parsed = setFlagSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }
      await featureFlagService.setFlag({
        workspaceId: id,
        workosUserId: parsed.data.workosUserId,
        flagKey: parsed.data.flagKey,
        value: parsed.data.value,
      })
      res.status(204).end()
    },
  }
}
