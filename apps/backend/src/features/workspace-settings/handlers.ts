import { z } from "zod"
import type { Request, Response } from "express"
import {
  VOICE_STEERING_WORDS_MAX,
  VOICE_STEERING_WORD_MAX_LENGTH,
  MAX_PENDING_FOLLOW_UPS_MIN,
  MAX_PENDING_FOLLOW_UPS_MAX,
} from "@threa/types"
import type { WorkspaceSettingsService } from "./service"
import { workScheduleSchema, statusPresetsSchema } from "../../lib/schemas"
import { validateRequest } from "../../lib/validation"
import { isValidIanaTimezone } from "../../lib/temporal"

const updateWorkspaceSettingsSchema = z
  .object({
    defaultWorkSchedule: workScheduleSchema.optional(),
    userStatusPresets: statusPresetsSchema.optional(),
    // Language name or BCP-47 tag; null clears the override back to per-conversation.
    memoLanguage: z.string().trim().min(1).max(40).nullable().optional(),
    // Shared dictation steering words; same bounds as the per-user list. Provider
    // keyterm caps and the baked-in product terms are applied at session-open time.
    voiceSteeringWords: z
      .array(z.string().trim().min(1).max(VOICE_STEERING_WORD_MAX_LENGTH))
      .max(VOICE_STEERING_WORDS_MAX)
      .optional(),
    // Per-stream pending follow-up cap the assistant self-regulates against (roadmap 1.4).
    maxPendingFollowUps: z.number().int().min(MAX_PENDING_FOLLOW_UPS_MIN).max(MAX_PENDING_FOLLOW_UPS_MAX).optional(),
    // Workspace default companion persona id; null clears back to built-in Ariadne.
    // Semantic validation (active persona in this workspace) runs in the service.
    defaultCompanionPersonaId: z.string().min(1).max(64).nullable().optional(),
    // The workspace's reporting timezone for AI spend. Rejected unless it is a real
    // IANA zone — a bad value would make every downstream Intl call throw.
    billingTimezone: z
      .string()
      .refine(isValidIanaTimezone, { message: "must be a valid IANA timezone identifier" })
      .optional(),
  })
  // Reject unknown keys instead of silently stripping them: a stale client
  // PATCHing the retired `callsEnabled` (now the `calls` feature flag) must fail
  // loud, not get an apparent success while the kill switch does nothing (INV-11).
  .strict()

export { updateWorkspaceSettingsSchema }

interface Dependencies {
  workspaceSettingsService: WorkspaceSettingsService
}

export function createWorkspaceSettingsHandlers({ workspaceSettingsService }: Dependencies) {
  return {
    async get(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const settings = await workspaceSettingsService.getSettings(workspaceId)
      res.json({ settings })
    },

    // Write is gated to workspace admins at the route layer.
    async update(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const data = validateRequest(updateWorkspaceSettingsSchema, req.body)

      const settings = await workspaceSettingsService.updateSettings(workspaceId, data)
      res.json({ settings })
    },
  }
}
