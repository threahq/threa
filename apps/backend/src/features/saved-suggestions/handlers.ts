import { z } from "zod"
import type { Request, Response } from "express"
import { SAVED_SUGGESTION_STATUSES } from "@threa/types"
import { HttpError } from "../../lib/errors"
import type { SavedSuggestionsService } from "./service"

// Suggestions list filters to one status at a time, defaulting to the
// suggested pile (the only one the UI surfaces by default).
const listQuerySchema = z.object({
  status: z.enum(SAVED_SUGGESTION_STATUSES).default("suggested"),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
})

interface Dependencies {
  savedSuggestionsService: SavedSuggestionsService
}

export function createSavedSuggestionsHandlers({ savedSuggestionsService }: Dependencies) {
  return {
    async list(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const parsed = listQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        throw new HttpError("Invalid list request", { status: 400, code: "VALIDATION_ERROR" })
      }

      const result = await savedSuggestionsService.list({
        workspaceId,
        userId,
        status: parsed.data.status,
        limit: parsed.data.limit,
        cursor: parsed.data.cursor,
      })

      res.json(result)
    },

    async accept(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const suggestionId = req.params.suggestionId!

      const result = await savedSuggestionsService.accept({ workspaceId, userId, suggestionId })
      res.json(result)
    },

    async dismiss(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const suggestionId = req.params.suggestionId!

      const suggestion = await savedSuggestionsService.dismiss({ workspaceId, userId, suggestionId })
      res.json({ suggestion })
    },
  }
}
