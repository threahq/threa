import { z } from "zod"
import type { Request, Response } from "express"
import { HttpError } from "../../lib/errors"
import { validateRequest } from "../../lib/validation"
import { contentJsonSchema, deriveContentMarkdown, conversationDirectiveSchema } from "../messaging"
import type { ScheduledMessagesService } from "./service"

const scheduleSchema = z.object({
  streamId: z.string().min(1),
  parentMessageId: z.string().min(1).nullable().optional(),
  contentJson: contentJsonSchema,
  attachmentIds: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  scheduledFor: z.string().datetime(),
  clientMessageId: z.string().min(1).optional(),
  conversation: conversationDirectiveSchema.optional(),
  confirmedPrivacyWarning: z.boolean().optional(),
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
    confirmedPrivacyWarning: z.boolean().optional(),
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

      const data = validateRequest(scheduleSchema, req.body)

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
        conversationDirective: data.conversation ?? null,
        confirmedPrivacyWarning: data.confirmedPrivacyWarning,
      })

      res.status(201).json({ scheduled })
    },

    async list(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const query = validateRequest(listQuerySchema, req.query)

      const result = await scheduledMessagesService.list({
        workspaceId,
        userId,
        status: query.status,
        streamId: query.streamId,
        limit: query.limit,
        cursor: query.cursor,
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

      const data = validateRequest(updateSchema, req.body)

      const scheduled = await scheduledMessagesService.update({
        workspaceId,
        userId,
        id,
        expectedVersion: data.expectedVersion,
        contentJson: data.contentJson,
        // Markdown moves with the JSON: derive it when the content changes, and
        // leave it untouched (undefined) when this edit only touches scheduling
        // or attachments.
        contentMarkdown: data.contentJson ? deriveContentMarkdown(data.contentJson) : undefined,
        attachmentIds: data.attachmentIds,
        metadata: data.metadata,
        scheduledFor: data.scheduledFor ? new Date(data.scheduledFor) : undefined,
        confirmedPrivacyWarning: data.confirmedPrivacyWarning,
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
