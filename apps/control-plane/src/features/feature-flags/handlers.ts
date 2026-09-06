import type { Request, Response } from "express"
import { z } from "zod/v4"
import { HttpError } from "@threahq/backend-common"
import { FEATURE_FLAG_DEFINITIONS, FEATURE_FLAG_KEYS, FEATURE_FLAG_SCOPES } from "@threahq/types"
import type { ControlPlaneFeatureFlagService } from "./service"

const setFlagSchema = z.object({
  subjectType: z.enum(FEATURE_FLAG_SCOPES),
  /** Workspace id for workspace scope, workos_user_id for user scope. */
  subjectId: z.string().min(1),
  flagKey: z.string().min(1),
  /** Must be one of the flag's declared values; the flag's explicit default clears the override. */
  value: z.string().min(1),
})

interface Dependencies {
  featureFlagService: ControlPlaneFeatureFlagService
}

export function createFeatureFlagHandlers({ featureFlagService }: Dependencies) {
  return {
    /**
     * Registry (key + declared values + each flag's explicit default + declared
     * scopes) plus the stored overrides. The backoffice renders the workspace
     * row and the member × flag grid from these two lists.
     */
    async listWorkspaceFlags(req: Request, res: Response) {
      const id = req.params.id
      if (!id) {
        throw new HttpError("Missing workspace id", { status: 400, code: "VALIDATION_ERROR" })
      }
      const overrides = await featureFlagService.listWorkspaceOverrides(id)
      res.json({
        flags: FEATURE_FLAG_KEYS.map((key) => ({
          key,
          values: FEATURE_FLAG_DEFINITIONS[key].values,
          default: FEATURE_FLAG_DEFINITIONS[key].default,
          scopes: FEATURE_FLAG_DEFINITIONS[key].scopes,
        })),
        overrides: overrides.map((o) => ({
          subjectType: o.subjectType,
          subjectId: o.subjectId,
          flagKey: o.flagKey,
          value: o.value,
          updatedAt: o.updatedAt.toISOString(),
        })),
      })
    },

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
        subjectType: parsed.data.subjectType,
        subjectId: parsed.data.subjectId,
        flagKey: parsed.data.flagKey,
        value: parsed.data.value,
      })
      res.status(204).end()
    },
  }
}
