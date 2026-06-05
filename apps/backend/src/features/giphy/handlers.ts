import type { Request, Response, NextFunction } from "express"
import { z } from "zod"
import type { GiphyConfigResponse, GiphySearchResponse } from "@threa/types"
import { HttpError } from "../../lib/errors"
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

function requireEnabled(giphyService: GiphyService): void {
  if (!giphyService.isEnabled()) {
    throw new HttpError("Giphy is not configured", { status: 404, code: "GIPHY_NOT_CONFIGURED" })
  }
}

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
        requireEnabled(giphyService)
        const parsed = SearchQuerySchema.safeParse(req.query)
        if (!parsed.success) {
          throw new HttpError("Invalid search parameters", { status: 400, code: "VALIDATION_ERROR" })
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
        requireEnabled(giphyService)
        const parsed = TrendingQuerySchema.safeParse(req.query)
        if (!parsed.success) {
          throw new HttpError("Invalid parameters", { status: 400, code: "VALIDATION_ERROR" })
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
        requireEnabled(giphyService)
        const parsedId = GifIdSchema.safeParse(req.params.gifId)
        if (!parsedId.success) {
          throw new HttpError("Invalid GIF id", { status: 400, code: "VALIDATION_ERROR" })
        }
        const file = await giphyService.fetchGif(parsedId.data)
        if (!file) {
          throw new HttpError("GIF not found", { status: 404, code: "GIF_NOT_FOUND" })
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
