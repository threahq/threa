import { z } from "zod"
import type { Request, Response } from "express"
import { HttpError } from "../../lib/errors"
import { deriveContentMarkdown } from "../messaging"
import type { DraftsService } from "./service"

const contentJsonSchema = z.object({
  type: z.literal("doc"),
  content: z.array(z.any()),
})

const commandSchema = z.object({
  name: z.string().min(1),
  clientActionId: z.string().nullable(),
})

// PUT body. `expectedVersion` is the version the edit was based on (0 when the
// client has never seen a server confirmation). `writeId` is the per-push
// idempotency key. Exactly one content shape: plaintext (`contentJson`) or the
// E2E `ciphertext` triple — never both, which would be ambiguous.
const upsertSchema = z
  .object({
    scope: z.string().min(1),
    rootStreamId: z.string().min(1).nullable().optional(),
    expectedVersion: z.number().int().min(0),
    writeId: z.string().min(1),
    clientUpdatedAt: z.string().datetime(),
    contentJson: contentJsonSchema.nullable().optional(),
    attachmentIds: z.array(z.string()).optional(),
    command: commandSchema.nullable().optional(),
    contextRefs: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
    ciphertext: z.string().min(1).nullable().optional(),
    envelope: z.unknown().optional(),
    e2eVersion: z.number().int().nullable().optional(),
  })
  .refine((d) => !(d.contentJson && d.ciphertext), {
    message: "A draft carries either plaintext contentJson or an E2E ciphertext, not both",
  })

const resolveSchema = z.object({
  expectedVersion: z.number().int().min(1),
})

interface Dependencies {
  draftsService: DraftsService
}

export function createDraftsHandlers({ draftsService }: Dependencies) {
  return {
    async list(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const drafts = await draftsService.list({ workspaceId, userId })
      res.json({ drafts })
    },

    async upsert(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const id = req.params.id!

      const parsed = upsertSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid draft upsert request", { status: 400, code: "VALIDATION_ERROR" })
      }
      const data = parsed.data

      // Markdown moves with the JSON: derive it at the boundary (INV-58) when the
      // draft is plaintext; E2E drafts carry no plaintext to derive from.
      const contentJson = data.contentJson ?? null
      const result = await draftsService.upsert({
        workspaceId,
        userId,
        id,
        scope: data.scope,
        rootStreamId: data.rootStreamId ?? null,
        expectedVersion: data.expectedVersion,
        writeId: data.writeId,
        clientUpdatedAt: new Date(data.clientUpdatedAt),
        contentJson,
        contentMarkdown: contentJson ? deriveContentMarkdown(contentJson) : null,
        attachmentIds: data.attachmentIds ?? [],
        command: data.command ?? null,
        contextRefs: data.contextRefs ?? null,
        ciphertext: data.ciphertext ?? null,
        envelope: data.envelope ?? null,
        e2eVersion: data.e2eVersion ?? null,
      })

      res.json(result)
    },

    async resolve(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const id = req.params.id!

      const parsed = resolveSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid draft resolve request", { status: 400, code: "VALIDATION_ERROR" })
      }

      const result = await draftsService.resolve({
        workspaceId,
        userId,
        id,
        expectedVersion: parsed.data.expectedVersion,
      })
      res.json(result)
    },

    async delete(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const id = req.params.id!

      await draftsService.delete({ workspaceId, userId, id })
      res.json({ ok: true })
    },
  }
}
