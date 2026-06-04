import { z } from "zod"
import type { Request, Response } from "express"
import { HttpError } from "../../lib/errors"
import { deriveContentMarkdown } from "../messaging"
import type { ScheduledMessagesService } from "./service"

const contentJsonSchema = z.object({
  type: z.literal("doc"),
  content: z.array(z.any()),
})

const scheduleSchema = z.object({
  streamId: z.string().min(1),
  parentMessageId: z.string().min(1).nullable().optional(),
  contentJson: contentJsonSchema,
  attachmentIds: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  scheduledFor: z.string().datetime(),
  clientMessageId: z.string().min(1).optional(),
})

// PATCH allows any subset of editable fields plus a required
// `expectedVersion` so the server can run the optimistic-CAS check that
// makes "first save wins" possible without an exclusive editor lock.
const updateSchema = z
  .object({
    contentJson: contentJsonSchema.optional(),
    attachmentIds: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.string()).nullable().optional(),
    scheduledFor: z.string().datetime().optional(),
    expectedVersion: z.number().int().min(1),
  })
  .refine(
    (d) =>
      d.contentJson !== undefined ||
      d.attachmentIds !== undefined ||
      d.metadata !== undefined ||
      d.scheduledFor !== undefined,
    { message: "At least one editable field must be provided" }
  )

const listQuerySchema = z.object({
  status: z.enum(["pending", "sent", "failed", "cancelled"]).default("pending"),
  streamId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
})

interface Dependencies {
  scheduledMessagesService: ScheduledMessagesService
}

export function createScheduledMessagesHandlers({ scheduledMessagesService }: Dependencies) {
  return {
    async create(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const parsed = scheduleSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid schedule request", { status: 400, code: "VALIDATION_ERROR" })
      }
      const data = parsed.data

      const scheduled = await scheduledMessagesService.schedule({
        workspaceId,
        userId,
        streamId: data.streamId,
        parentMessageId: data.parentMessageId ?? null,
        contentJson: data.contentJson,
        contentMarkdown: deriveContentMarkdown(data.contentJson),
        attachmentIds: data.attachmentIds ?? [],
        metadata: data.metadata ?? null,
        scheduledFor: new Date(data.scheduledFor),
        clientMessageId: data.clientMessageId ?? null,
      })

      res.status(201).json({ scheduled })
    },

    async list(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const parsed = listQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        throw new HttpError("Invalid list request", { status: 400, code: "VALIDATION_ERROR" })
      }

      const result = await scheduledMessagesService.list({
        workspaceId,
        userId,
        status: parsed.data.status,
        streamId: parsed.data.streamId,
        limit: parsed.data.limit,
        cursor: parsed.data.cursor,
      })

      res.json(result)
    },

    async getById(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const id = req.params.id!

      const scheduled = await scheduledMessagesService.getById({ workspaceId, userId, id })
      if (!scheduled) {
        throw new HttpError("Scheduled message not found", {
          status: 404,
          code: "SCHEDULED_MESSAGE_NOT_FOUND",
        })
      }

      res.json({ scheduled })
    },

    async update(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const id = req.params.id!

      const parsed = updateSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid update request", { status: 400, code: "VALIDATION_ERROR" })
      }

      const scheduled = await scheduledMessagesService.update({
        workspaceId,
        userId,
        id,
        expectedVersion: parsed.data.expectedVersion,
        contentJson: parsed.data.contentJson,
        // Markdown moves with the JSON: derive it when the content changes, and
        // leave it untouched (undefined) when this edit only touches scheduling
        // or attachments.
        contentMarkdown: parsed.data.contentJson ? deriveContentMarkdown(parsed.data.contentJson) : undefined,
        attachmentIds: parsed.data.attachmentIds,
        metadata: parsed.data.metadata,
        scheduledFor: parsed.data.scheduledFor ? new Date(parsed.data.scheduledFor) : undefined,
      })

      res.json({ scheduled })
    },

    async lockForEdit(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const id = req.params.id!

      const result = await scheduledMessagesService.lockForEdit({ workspaceId, userId, id })
      res.json({
        scheduled: result.scheduled,
        editActiveUntil: result.editActiveUntil.toISOString(),
      })
    },

    async releaseEditLock(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const id = req.params.id!

      await scheduledMessagesService.releaseEditLock({ workspaceId, userId, id })
      res.json({ ok: true })
    },

    async sendNow(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const id = req.params.id!

      const scheduled = await scheduledMessagesService.sendNow({ workspaceId, userId, id })
      res.json({ scheduled })
    },

    async delete(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const id = req.params.id!

      await scheduledMessagesService.cancel({ workspaceId, userId, id })
      res.json({ ok: true })
    },
  }
}
