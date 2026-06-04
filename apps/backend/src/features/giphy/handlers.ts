import type { Request, Response, NextFunction } from "express"
import { z } from "zod"
import type { GiphyConfigResponse, GiphySearchResponse } from "@threa/types"
import type { GiphyService } from "./service"
import { GIPHY_MAX_PAGE_SIZE, GIPHY_MAX_QUERY_LENGTH, GIPHY_PAGE_SIZE } from "./config"

interface HandlerDeps {
  giphyService: GiphyService
}

const SearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(GIPHY_MAX_QUERY_LENGTH),
  offset: z.coerce.number().int().min(0).max(4999).optional(),
  limit: z.coerce.number().int().min(1).max(GIPHY_MAX_PAGE_SIZE).optional(),
})

const TrendingQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).max(4999).optional(),
  limit: z.coerce.number().int().min(1).max(GIPHY_MAX_PAGE_SIZE).optional(),
})

const GifIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9]+$/)
  .max(64)

export function createGiphyHandlers({ giphyService }: HandlerDeps) {
  return {
    /** GET /api/workspaces/:workspaceId/giphy/config */
    getConfig(_req: Request, res: Response) {
      const body: GiphyConfigResponse = { enabled: giphyService.isEnabled() }
      res.json(body)
    },

    /** GET /api/workspaces/:workspaceId/giphy/search?q=&offset=&limit= */
    async search(req: Request, res: Response, next: NextFunction) {
      try {
        if (!giphyService.isEnabled()) {
          res.status(404).json({ error: "Giphy is not configured" })
          return
        }
        const parsed = SearchQuerySchema.safeParse(req.query)
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid search parameters", details: parsed.error.format() })
          return
        }
        const { q, offset, limit } = parsed.data
        const page = await giphyService.search(q, { offset, limit: limit ?? GIPHY_PAGE_SIZE })
        const body: GiphySearchResponse = page
        res.json(body)
      } catch (err) {
        next(err)
      }
    },

    /** GET /api/workspaces/:workspaceId/giphy/trending?offset=&limit= */
    async trending(req: Request, res: Response, next: NextFunction) {
      try {
        if (!giphyService.isEnabled()) {
          res.status(404).json({ error: "Giphy is not configured" })
          return
        }
        const parsed = TrendingQuerySchema.safeParse(req.query)
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid parameters", details: parsed.error.format() })
          return
        }
        const { offset, limit } = parsed.data
        const page = await giphyService.trending({ offset, limit: limit ?? GIPHY_PAGE_SIZE })
        const body: GiphySearchResponse = page
        res.json(body)
      } catch (err) {
        next(err)
      }
    },

    /**
     * GET /api/workspaces/:workspaceId/giphy/:gifId/file
     * Streams the chosen GIF's bytes so the frontend can re-upload them through
     * the normal attachment pipeline. Same-origin keeps the browser off Giphy's
     * CDN for the actual upload (no CORS), and the bytes never touch the client
     * until they're attached.
     */
    async file(req: Request, res: Response, next: NextFunction) {
      try {
        if (!giphyService.isEnabled()) {
          res.status(404).json({ error: "Giphy is not configured" })
          return
        }
        const parsedId = GifIdSchema.safeParse(req.params.gifId)
        if (!parsedId.success) {
          res.status(400).json({ error: "Invalid GIF id" })
          return
        }
        const file = await giphyService.fetchGif(parsedId.data)
        if (!file) {
          res.status(404).json({ error: "GIF not found" })
          return
        }
        res.setHeader("Content-Type", file.mimeType)
        res.setHeader("Content-Length", String(file.sizeBytes))
        res.setHeader("Content-Disposition", `inline; filename="${file.filename}"`)
        res.send(file.buffer)
      } catch (err) {
        next(err)
      }
    },
  }
}
