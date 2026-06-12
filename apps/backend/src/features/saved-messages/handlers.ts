import { z } from "zod"
import type { Request, Response } from "express"
import { SAVED_STATUSES } from "@threa/types"
import { HttpError } from "../../lib/errors"
import type { SavedMessagesService } from "./service"

const TITLE_MAX_LENGTH = 300
const NOTE_MAX_LENGTH = 4000

// Create is either a message save (messageId) or a standalone to-do (title).
// Notes are only accepted with a title — message saves start without one and
// gain it via PATCH, so the upsert's conflict path never has to merge notes.
const saveSchema = z
  .object({
    messageId: z.string().min(1).optional(),
    title: z.string().trim().min(1).max(TITLE_MAX_LENGTH).optional(),
    note: z.string().trim().min(1).max(NOTE_MAX_LENGTH).optional(),
    remindAt: z.string().datetime().nullable().optional(),
  })
  .refine((d) => (d.messageId !== undefined) !== (d.title !== undefined), {
    message: "Must provide exactly one of 'messageId' or 'title'",
  })
  .refine((d) => d.note === undefined || d.title !== undefined, {
    message: "'note' is only allowed together with 'title'",
  })

// Status, remindAt, and content (title/note) must be changed in separate
// requests so each mutation is one transaction and one socket event. A single
// PATCH that combined groups would emit two outbox events and leave an
// observable intermediate state between them. Title and note are one group:
// the edit dialog saves them together as a single content change.
const updateSchema = z
  .object({
    status: z.enum(SAVED_STATUSES).optional(),
    remindAt: z.string().datetime().nullable().optional(),
    title: z.string().trim().min(1).max(TITLE_MAX_LENGTH).optional(),
    note: z.string().trim().max(NOTE_MAX_LENGTH).nullable().optional(),
  })
  .refine(
    (d) => {
      const groups = [d.status !== undefined, d.remindAt !== undefined, d.title !== undefined || d.note !== undefined]
      return groups.filter(Boolean).length === 1
    },
    { message: "Must provide exactly one of 'status', 'remindAt', or content ('title'/'note')" }
  )

const listQuerySchema = z.object({
  status: z.enum(SAVED_STATUSES).default("saved"),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
})

interface Dependencies {
  savedMessagesService: SavedMessagesService
}

export function createSavedMessagesHandlers({ savedMessagesService }: Dependencies) {
  return {
    async create(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const parsed = saveSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid save request", { status: 400, code: "VALIDATION_ERROR" })
      }

      const remindAt = parsed.data.remindAt ? new Date(parsed.data.remindAt) : null

      // Schema guarantees exactly one of messageId or title is present.
      const saved = parsed.data.messageId
        ? await savedMessagesService.save({
            workspaceId,
            userId,
            messageId: parsed.data.messageId,
            remindAt,
          })
        : await savedMessagesService.createStandalone({
            workspaceId,
            userId,
            title: parsed.data.title!,
            note: parsed.data.note ?? null,
            remindAt,
          })

      res.json({ saved })
    },

    async list(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const parsed = listQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        throw new HttpError("Invalid list request", { status: 400, code: "VALIDATION_ERROR" })
      }

      const result = await savedMessagesService.list({
        workspaceId,
        userId,
        status: parsed.data.status,
        limit: parsed.data.limit,
        cursor: parsed.data.cursor,
      })

      res.json(result)
    },

    async update(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const savedId = req.params.savedId!

      const parsed = updateSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid update request", { status: 400, code: "VALIDATION_ERROR" })
      }

      // Schema guarantees exactly one mutation group is present.
      let saved
      if (parsed.data.remindAt !== undefined) {
        saved = await savedMessagesService.updateReminder({
          workspaceId,
          userId,
          savedId,
          remindAt: parsed.data.remindAt ? new Date(parsed.data.remindAt) : null,
        })
      } else if (parsed.data.status !== undefined) {
        saved = await savedMessagesService.updateStatus({
          workspaceId,
          userId,
          savedId,
          status: parsed.data.status,
        })
      } else {
        saved = await savedMessagesService.updateContent({
          workspaceId,
          userId,
          savedId,
          title: parsed.data.title,
          // Trimmed-empty notes clear like null — "  " is not a note.
          note: parsed.data.note === "" ? null : parsed.data.note,
        })
      }

      res.json({ saved })
    },

    async delete(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const savedId = req.params.savedId!

      await savedMessagesService.delete({ workspaceId, userId, savedId })

      res.json({ ok: true })
    },
  }
}
