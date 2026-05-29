import { z } from "zod"
import type { Request, Response } from "express"
import type { SidebarConfigService } from "./service"
import { HttpError } from "../../lib/errors"
import {
  SIDEBAR_SECTION_KEYS,
  SIDEBAR_TYPE_SECTIONS,
  SIDEBAR_BASE_PRESETS,
  SIDEBAR_QUICK_LINKS,
  SIDEBAR_QUICK_LINK_VISIBILITIES,
} from "@threa/types"

const sidebarSectionSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("smart"), bucket: z.enum(SIDEBAR_SECTION_KEYS) }),
  z.object({ kind: z.literal("type"), streamType: z.enum(SIDEBAR_TYPE_SECTIONS) }),
  z.object({ kind: z.literal("label"), labelId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("quicklinks") }),
])

const sidebarSectionSchema = z.object({
  id: z.string().min(1).max(64),
  spec: sidebarSectionSpecSchema,
})

// `visibility` is the current tri-state; `enabled` is the pre-v2 boolean an
// older client may still send. Both are optional so either shape validates; the
// service's normalizeSidebarConfig collapses them to a canonical visibility.
const sidebarQuickLinkSchema = z.object({
  key: z.enum(SIDEBAR_QUICK_LINKS),
  visibility: z.enum(SIDEBAR_QUICK_LINK_VISIBILITIES).optional(),
  enabled: z.boolean().optional(),
})

// The PATCH body is the full config document — it replaces the stored layout.
// version + quickLinks are optional/defaulted so a client predating either field
// (an in-flight request during a backend-first rollout) still validates; the
// service normalizes (version bump, full quick-link set) on write.
const updateSidebarConfigSchema = z.object({
  version: z.number().int().optional(),
  basePreset: z.enum(SIDEBAR_BASE_PRESETS),
  sections: z.array(sidebarSectionSchema).max(50),
  quickLinks: z.array(sidebarQuickLinkSchema).max(SIDEBAR_QUICK_LINKS.length).optional().default([]),
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
        throw new HttpError("Invalid sidebar config", { status: 400, code: "VALIDATION_ERROR" })
      }

      const sidebarConfig = await sidebarConfigService.updateConfig(workspaceId, userId, result.data)
      res.json({ sidebarConfig })
    },
  }
}
