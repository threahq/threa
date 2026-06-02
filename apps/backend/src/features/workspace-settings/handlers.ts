import { z } from "zod"
import type { Request, Response } from "express"
import type { WorkspaceSettingsService } from "./service"
import { workScheduleSchema } from "../../lib/schemas"

const updateWorkspaceSettingsSchema = z.object({
  defaultWorkSchedule: workScheduleSchema.optional(),
})

export { updateWorkspaceSettingsSchema }

interface Dependencies {
  workspaceSettingsService: WorkspaceSettingsService
}

export function createWorkspaceSettingsHandlers({ workspaceSettingsService }: Dependencies) {
  return {
    async get(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const settings = await workspaceSettingsService.getSettings(workspaceId)
      res.json({ settings })
    },

    // Write is gated to workspace admins at the route layer.
    async update(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const result = updateWorkspaceSettingsSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const settings = await workspaceSettingsService.updateSettings(workspaceId, result.data)
      res.json({ settings })
    },
  }
}
