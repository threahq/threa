import { z } from "zod"
import type { Request, Response } from "express"
import type { BoardViewService } from "./service"
import { validateRequest } from "../../lib/validation"
import { HttpError } from "../../lib/errors"
import type { FeatureFlagService } from "../feature-flags"
import {
  BOARD_LENSES,
  BOARD_SCOPE_STREAM_TYPES,
  MAX_BOARD_SCOPE_STREAMS,
  MAX_BOARD_VIEW_NAME_LENGTH,
} from "@threa/types"

const boardViewParamsSchema = z.object({ boardViewId: z.string().min(1) })

const scopeStreamIdsSchema = z.array(z.string().min(1)).max(MAX_BOARD_SCOPE_STREAMS)
const scopeStreamTypesSchema = z.array(z.enum(BOARD_SCOPE_STREAM_TYPES))

const createBoardViewSchema = z.object({
  name: z.string().trim().min(1).max(MAX_BOARD_VIEW_NAME_LENGTH),
  baseLens: z.enum(BOARD_LENSES),
  scopeStreamIds: scopeStreamIdsSchema.optional().default([]),
  scopeStreamTypes: scopeStreamTypesSchema.optional().default([]),
})

const updateBoardViewSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_BOARD_VIEW_NAME_LENGTH).optional(),
    baseLens: z.enum(BOARD_LENSES).optional(),
    scopeStreamIds: scopeStreamIdsSchema.optional(),
    scopeStreamTypes: scopeStreamTypesSchema.optional(),
    sortOrder: z.number().int().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), { message: "Provide at least one field" })

interface Dependencies {
  boardViewService: BoardViewService
  featureFlagService: FeatureFlagService
}

/**
 * User-saved board lenses (board-view-design.md § "Lenses"). All board-flag-gated
 * (404 without `board-view`, like the feed). No stream-access check: a saved view
 * is just filter state (names of streams the viewer already sees), and the feed it
 * expands to is itself access-filtered (INV-62) — a muted/inaccessible stream in a
 * saved scope simply returns nothing.
 */
export function createBoardViewHandlers({ boardViewService, featureFlagService }: Dependencies) {
  async function requireBoardFlag(req: Request): Promise<void> {
    if ((await featureFlagService.getFlag(req.workspaceId!, req.user!.id, "board-view")) !== "on") {
      throw new HttpError("Not found", { status: 404, code: "NOT_FOUND" })
    }
  }

  return {
    async list(req: Request, res: Response) {
      await requireBoardFlag(req)
      const boardViews = await boardViewService.list(req.workspaceId!, req.user!.id)
      res.json({ boardViews })
    },

    async create(req: Request, res: Response) {
      await requireBoardFlag(req)
      const body = validateRequest(createBoardViewSchema, req.body)
      const boardView = await boardViewService.create({
        workspaceId: req.workspaceId!,
        userId: req.user!.id,
        ...body,
      })
      res.status(201).json({ boardView })
    },

    async update(req: Request, res: Response) {
      await requireBoardFlag(req)
      const { boardViewId } = validateRequest(boardViewParamsSchema, req.params)
      const body = validateRequest(updateBoardViewSchema, req.body)
      const boardView = await boardViewService.update(req.workspaceId!, req.user!.id, boardViewId, body)
      res.json({ boardView })
    },

    async remove(req: Request, res: Response) {
      await requireBoardFlag(req)
      const { boardViewId } = validateRequest(boardViewParamsSchema, req.params)
      await boardViewService.delete(req.workspaceId!, req.user!.id, boardViewId)
      res.json({ ok: true })
    },
  }
}
