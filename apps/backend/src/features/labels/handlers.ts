import { z } from "zod"
import type { Request, Response } from "express"
import { LABELABLE_RESOURCE_TYPES, LabelActorTypes } from "@threa/types"
import { HttpError } from "../../lib/errors"
import type { LabelService } from "./service"
import type { LabelAssignmentService } from "./assignment-service"
import type { LabelMessageService } from "./label-message-service"

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

const assignmentSchema = z.object({
  resourceType: z.enum(LABELABLE_RESOURCE_TYPES),
  resourceId: z.string().min(1).max(64),
})

const createSchema = z.object({
  name: z.string().min(1).max(100),
  color: z.string().regex(COLOR_PATTERN, "color must be a #RRGGBB hex string"),
  emoji: z.string().max(32).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
})

const updateSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    color: z.string().regex(COLOR_PATTERN).optional(),
    emoji: z.string().max(32).nullable().optional(),
    description: z.string().max(500).nullable().optional(),
  })
  .refine(
    (d) => d.name !== undefined || d.color !== undefined || d.emoji !== undefined || d.description !== undefined,
    { message: "At least one field must be provided" }
  )

interface Dependencies {
  labelService: LabelService
  labelAssignmentService: LabelAssignmentService
  labelMessageService: LabelMessageService
}

export function createLabelHandlers({ labelService, labelAssignmentService, labelMessageService }: Dependencies) {
  return {
    async list(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const [labels, assignments] = await Promise.all([
        labelService.listForActor(workspaceId, userId),
        labelAssignmentService.listForViewer(workspaceId, { type: LabelActorTypes.USER, id: userId }),
      ])
      res.json({ labels, assignments })
    },

    /** Messages the viewer has filed under a label, hydrated for the label page. */
    async listMessages(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const labelId = req.params.labelId!
      const messages = await labelMessageService.listLabeledMessages(
        workspaceId,
        { type: LabelActorTypes.USER, id: userId },
        labelId
      )
      res.json({ messages })
    },

    async create(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const parsed = createSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid label payload", { status: 400, code: "VALIDATION_ERROR" })
      }

      const label = await labelService.create({
        workspaceId,
        actor: { type: LabelActorTypes.USER, id: userId },
        name: parsed.data.name,
        color: parsed.data.color,
        emoji: parsed.data.emoji ?? null,
        description: parsed.data.description ?? null,
      })
      res.status(201).json({ label })
    },

    async update(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const labelId = req.params.labelId!

      const parsed = updateSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid label payload", { status: 400, code: "VALIDATION_ERROR" })
      }

      const label = await labelService.update({
        workspaceId,
        actor: { type: LabelActorTypes.USER, id: userId },
        labelId,
        name: parsed.data.name,
        color: parsed.data.color,
        emoji: parsed.data.emoji,
        description: parsed.data.description,
      })
      res.json({ label })
    },

    async delete(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const labelId = req.params.labelId!
      await labelService.archive({ workspaceId, actor: { type: LabelActorTypes.USER, id: userId }, labelId })
      res.json({ ok: true })
    },

    async assign(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const labelId = req.params.labelId!

      const parsed = assignmentSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid assignment payload", { status: 400, code: "VALIDATION_ERROR" })
      }

      const assignment = await labelAssignmentService.assign({
        workspaceId,
        actor: { type: LabelActorTypes.USER, id: userId },
        labelId,
        resourceType: parsed.data.resourceType,
        resourceId: parsed.data.resourceId,
      })
      res.status(201).json({ assignment })
    },

    async unassign(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const labelId = req.params.labelId!

      const parsed = assignmentSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid assignment payload", { status: 400, code: "VALIDATION_ERROR" })
      }

      await labelAssignmentService.unassign({
        workspaceId,
        actor: { type: LabelActorTypes.USER, id: userId },
        labelId,
        resourceType: parsed.data.resourceType,
        resourceId: parsed.data.resourceId,
      })
      res.json({ ok: true })
    },
  }
}
