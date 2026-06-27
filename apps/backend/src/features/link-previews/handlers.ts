import type { Request, Response, NextFunction } from "express"
import { z } from "zod"
import { HttpError } from "../../lib/errors"
import type { LinkPreviewService } from "./service"

interface HandlerDeps {
  linkPreviewService: LinkPreviewService
}

const resolveByUrlQuerySchema = z.object({ url: z.string().url() })

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
     * Resolves an in-app link (message, stream, or memo) to viewer-scoped,
     * access-tiered data. Returns different data depending on the viewer's access tier.
     */
    async resolveInAppLink(req: Request, res: Response, next: NextFunction) {
      try {
        const { workspaceId, linkPreviewId } = req.params
        const userId = req.user!.id

        const data = await linkPreviewService.resolveInAppLink(workspaceId, userId, linkPreviewId)
        if (!data) {
          res.status(404).json({ error: "Not found" })
          return
        }

        res.json(data)
      } catch (err) {
        next(err)
      }
    },

    /**
     * GET /api/workspaces/:workspaceId/link-previews/resolve?url=...
     * Resolves an in-app link straight from its URL (no persisted preview row),
     * for the composer rendering a draft. Same per-viewer, access-tiered data as
     * the by-id resolve. A URL that isn't a recognized in-app link is a 404.
     */
    async resolveInAppLinkByUrl(req: Request, res: Response, next: NextFunction) {
      try {
        const { workspaceId } = req.params
        const userId = req.user!.id

        const parsed = resolveByUrlQuerySchema.safeParse(req.query)
        if (!parsed.success) {
          throw new HttpError("Invalid url", { status: 400, code: "VALIDATION_ERROR" })
        }

        const data = await linkPreviewService.resolveInAppLinkByUrl(workspaceId, userId, parsed.data.url)
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
