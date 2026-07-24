import type { Request, Response } from "express"
import type { ActivityService } from "./service"

interface Dependencies {
  activityService: ActivityService
}

export function createActivityHandlers({ activityService }: Dependencies) {
  return {
    async list(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const rawLimit = req.query.limit ? Number(req.query.limit) : 50
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined
      const unreadOnly = req.query.unreadOnly === "true"
      const mineOnly = req.query.mineOnly === "true"
      const othersOnly = req.query.othersOnly === "true"

      const activities = await activityService.listFeed(userId, workspaceId, {
        limit,
        cursor,
        unreadOnly,
        mineOnly,
        othersOnly,
      })

      res.json({ activities })
    },

    async markAllAsRead(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      await activityService.markAllAsRead(userId, workspaceId)

      res.json({ ok: true })
    },

    async markOneAsRead(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const activityId = req.params.id

      await activityService.markAsRead(activityId, userId, workspaceId)

      res.json({ ok: true })
    },
  }
}
