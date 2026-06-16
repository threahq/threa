import type { Request, Response, NextFunction } from "express"
import type { LinkPreviewService } from "./service"

interface HandlerDeps {
  linkPreviewService: LinkPreviewService
}

export function createLinkPreviewHandlers(deps: HandlerDeps) {
  const { linkPreviewService } = deps

  return {
    /** GET /api/workspaces/:workspaceId/messages/:messageId/link-previews */
    async getForMessage(req: Request, res: Response, next: NextFunction) {
      try {
        const { workspaceId, messageId } = req.params
        const userId = req.user!.id

        const previews = await linkPreviewService.getPreviewsForMessage(workspaceId, messageId)
        const dismissals = await linkPreviewService.getDismissals(workspaceId, userId, [messageId])

        const result = previews.map((p) => ({
          ...p,
          dismissed: dismissals.has(`${messageId}:${p.id}`),
        }))

        res.json({ previews: result })
      } catch (err) {
        next(err)
      }
    },

    /** POST /api/workspaces/:workspaceId/messages/:messageId/link-previews/:linkPreviewId/dismiss */
    async dismiss(req: Request, res: Response, next: NextFunction) {
      try {
        const { workspaceId, messageId, linkPreviewId } = req.params
        const userId = req.user!.id

        await linkPreviewService.dismiss(workspaceId, userId, messageId, linkPreviewId)
        res.json({ ok: true })
      } catch (err) {
        next(err)
      }
    },

    /**
     * GET /api/workspaces/:workspaceId/link-previews/:linkPreviewId/resolve
     * Returns different data depending on the viewer's access tier.
     */
    async resolveMessageLink(req: Request, res: Response, next: NextFunction) {
      try {
        const { workspaceId, linkPreviewId } = req.params
        const userId = req.user!.id

        const data = await linkPreviewService.resolveMessageLink(workspaceId, userId, linkPreviewId)
        if (!data) {
          res.status(404).json({ error: "Not found" })
          return
        }

        res.json(data)
      } catch (err) {
        next(err)
      }
    },
  }
}
