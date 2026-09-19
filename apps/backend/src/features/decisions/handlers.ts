import type { Request, Response } from "express"
import { z } from "zod"
import { validateRequest } from "../../lib/validation"
import { sealedBodySchema } from "../messaging"
import { DECISION_NOTE_MAX_CHARS, DECISION_OPTION_ID_MAX_CHARS } from "./config"
import { serializeDecisionRequest } from "./repository"
import type { DecisionService } from "./service"

export const resolveDecisionSchema = z
  .object({
    optionId: z.string().min(1).max(DECISION_OPTION_ID_MAX_CHARS),
    note: z.string().min(1).max(DECISION_NOTE_MAX_CHARS).optional(),
    /** The note on a sealed card, sealed under the same stream key as the card. */
    sealedNote: sealedBodySchema.optional(),
    /** The version the card was rendered at — the CAS token (INV-66). */
    version: z.number().int().min(1),
  })
  .refine((body) => body.note == null || body.sealedNote == null, {
    message: "Send either note or sealedNote, not both",
    path: ["note"],
  })

interface Dependencies {
  decisionService: DecisionService
}

/**
 * First-party HTTP surface for decision cards: the option buttons a member
 * clicks. Access is
 * `checkStreamAccess` inside the service (INV-62) — anyone who can read the
 * stream can answer the question put to it.
 */
export function createDecisionHandlers({ decisionService }: Dependencies) {
  return {
    async resolve(req: Request, res: Response) {
      const { optionId, note, sealedNote, version } = validateRequest(resolveDecisionSchema, req.body)
      const decision = await decisionService.resolve({
        workspaceId: req.workspaceId!,
        id: req.params.id!,
        userId: req.user!.id,
        optionId,
        note,
        sealedNote,
        version,
      })
      res.json({ decision: serializeDecisionRequest(decision) })
    },
  }
}
