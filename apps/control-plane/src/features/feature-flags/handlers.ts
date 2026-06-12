import type { Request, Response } from "express"
import { z } from "zod/v4"
import { HttpError } from "@threa/backend-common"
import { FEATURE_FLAG_KEYS } from "@threa/types"
import type { ControlPlaneFeatureFlagService } from "./service"

const setFlagSchema = z.object({
  workosUserId: z.string().min(1),
  flagKey: z.string().min(1),
  /** `null` clears the override (back to the code default: off). */
  enabled: z.boolean().nullable(),
})

interface Dependencies {
  featureFlagService: ControlPlaneFeatureFlagService
}

export function createFeatureFlagHandlers({ featureFlagService }: Dependencies) {
  return {
    /**
     * GET /api/backoffice/workspaces/:id/feature-flags
     * Registry keys + stored per-user overrides for the workspace. The
     * backoffice renders the member × flag grid from these two lists.
     */
    async listWorkspaceFlags(req: Request, res: Response) {
      const id = req.params.id
      if (!id) {
        throw new HttpError("Missing workspace id", { status: 400, code: "VALIDATION_ERROR" })
      }
      const overrides = await featureFlagService.listWorkspaceOverrides(id)
      res.json({
        flagKeys: FEATURE_FLAG_KEYS,
        overrides: overrides.map((o) => ({
          workosUserId: o.workosUserId,
          flagKey: o.flagKey,
          enabled: o.enabled,
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
        enabled: parsed.data.enabled,
      })
      res.status(204).end()
    },
  }
}
