import { z } from "zod"
import type { Request, Response } from "express"
import type { BoardViewService } from "./service"
import { validateRequest } from "../../lib/validation"
import {
  degradeBoardLens,
  BOARD_SCOPE_STREAM_TYPES,
  MAX_BOARD_SCOPE_STREAMS,
  MAX_BOARD_SCOPE_LABELS,
  MAX_BOARD_VIEW_NAME_LENGTH,
} from "@threahq/types"

const boardViewParamsSchema = z.object({ boardViewId: z.string().min(1) })

/** A retired lens (`decisions`) degrades to the widest live lens instead of a
 *  400: the frontend deploys before the backend and SW-cached bundles linger, so
 *  an old bundle saving a view must get a saved view, not an error. Mirrors the
 *  read-side `normalizeLens` and the conversations handler's degrade. */
const baseLensSchema = z.string().transform(degradeBoardLens)

const scopeStreamIdsSchema = z.array(z.string().min(1)).max(MAX_BOARD_SCOPE_STREAMS)
const scopeStreamTypesSchema = z.array(z.enum(BOARD_SCOPE_STREAM_TYPES))
const scopeLabelIdsSchema = z.array(z.string().min(1)).max(MAX_BOARD_SCOPE_LABELS)

const createBoardViewSchema = z.object({
  name: z.string().trim().min(1).max(MAX_BOARD_VIEW_NAME_LENGTH),
  baseLens: baseLensSchema,
  scopeStreamIds: scopeStreamIdsSchema.optional().default([]),
  scopeStreamTypes: scopeStreamTypesSchema.optional().default([]),
  scopeLabelIds: scopeLabelIdsSchema.optional().default([]),
  excludeStreamIds: scopeStreamIdsSchema.optional().default([]),
  excludeStreamTypes: scopeStreamTypesSchema.optional().default([]),
  excludeLabelIds: scopeLabelIdsSchema.optional().default([]),
})

const updateBoardViewSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_BOARD_VIEW_NAME_LENGTH).optional(),
    baseLens: baseLensSchema.optional(),
    scopeStreamIds: scopeStreamIdsSchema.optional(),
    scopeStreamTypes: scopeStreamTypesSchema.optional(),
    scopeLabelIds: scopeLabelIdsSchema.optional(),
    excludeStreamIds: scopeStreamIdsSchema.optional(),
    excludeStreamTypes: scopeStreamTypesSchema.optional(),
    excludeLabelIds: scopeLabelIdsSchema.optional(),
    sortOrder: z.number().int().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), { message: "Provide at least one field" })

interface Dependencies {
  boardViewService: BoardViewService
}

/**
 * User-saved board lenses. No stream-access
 * check: a saved view is just filter state (names of streams the viewer already
 * sees), and the feed it expands to is itself access-filtered (INV-62) — a
 * muted/inaccessible stream in a saved scope simply returns nothing.
 */
export function createBoardViewHandlers({ boardViewService }: Dependencies) {
  return {
    async list(req: Request, res: Response) {
      const boardViews = await boardViewService.list(req.workspaceId!, req.user!.id)
      res.json({ boardViews })
    },

    async create(req: Request, res: Response) {
      const body = validateRequest(createBoardViewSchema, req.body)
      const boardView = await boardViewService.create({
        workspaceId: req.workspaceId!,
        userId: req.user!.id,
        ...body,
      })
      res.status(201).json({ boardView })
    },

    async update(req: Request, res: Response) {
      const { boardViewId } = validateRequest(boardViewParamsSchema, req.params)
      const body = validateRequest(updateBoardViewSchema, req.body)
      const boardView = await boardViewService.update(req.workspaceId!, req.user!.id, boardViewId, body)
      res.json({ boardView })
    },

    async remove(req: Request, res: Response) {
      const { boardViewId } = validateRequest(boardViewParamsSchema, req.params)
      await boardViewService.delete(req.workspaceId!, req.user!.id, boardViewId)
      res.json({ ok: true })
    },
  }
}
