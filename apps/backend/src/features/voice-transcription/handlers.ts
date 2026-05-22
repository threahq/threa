import { z } from "zod"
import type { Request, Response } from "express"
import { HttpError } from "../../lib/errors"
import type { VoiceTranscriptionService } from "./service"

const createSessionSchema = z.object({
  model: z.string().min(1).max(100).optional(),
  language: z.string().min(2).max(20).optional(),
})

interface Dependencies {
  voiceTranscriptionService: VoiceTranscriptionService
}

export function createVoiceTranscriptionHandlers({ voiceTranscriptionService }: Dependencies) {
  return {
    async createSession(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const userId = req.user!.id

      const result = createSessionSchema.safeParse(req.body)
      if (!result.success) {
        throw new HttpError("Invalid voice session request", { status: 400, code: "VALIDATION_ERROR" })
      }

      const row = await voiceTranscriptionService.createSession({
        workspaceId,
        userId,
        model: result.data.model,
        language: result.data.language,
      })

      res.status(201).json({
        voiceSessionId: row.id,
        model: row.model,
        provider: row.provider,
        region: row.region,
        expiresAt: row.expiresAt.toISOString(),
      })
    },

    async abortSession(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const userId = req.user!.id
      const { sessionId } = req.params

      await voiceTranscriptionService.abortSession({ workspaceId, userId, sessionId })
      res.status(204).send()
    },
  }
}
