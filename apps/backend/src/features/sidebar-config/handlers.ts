import { z } from "zod"
import type { Request, Response } from "express"
import type { SidebarConfigService } from "./service"
import { SIDEBAR_SECTION_KEYS, SIDEBAR_TYPE_SECTIONS, SIDEBAR_BASE_PRESETS } from "@threa/types"

const sidebarSectionSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("smart"), bucket: z.enum(SIDEBAR_SECTION_KEYS) }),
  z.object({ kind: z.literal("type"), streamType: z.enum(SIDEBAR_TYPE_SECTIONS) }),
])

const sidebarSectionSchema = z.object({
  id: z.string().min(1).max(64),
  spec: sidebarSectionSpecSchema,
})

// The PATCH body is the full config document — it replaces the stored layout.
const updateSidebarConfigSchema = z.object({
  basePreset: z.enum(SIDEBAR_BASE_PRESETS),
  sections: z.array(sidebarSectionSchema).max(50),
})

export { updateSidebarConfigSchema }

interface Dependencies {
  sidebarConfigService: SidebarConfigService
}

export function createSidebarConfigHandlers({ sidebarConfigService }: Dependencies) {
  return {
    async get(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const sidebarConfig = await sidebarConfigService.getConfig(workspaceId, userId)
      res.json({ sidebarConfig })
    },

    async update(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const result = updateSidebarConfigSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const sidebarConfig = await sidebarConfigService.updateConfig(workspaceId, userId, result.data)
      res.json({ sidebarConfig })
    },
  }
}
