import { z } from "zod"
import type { Request, Response } from "express"
import type { UserPreferencesService } from "./service"
import {
  THEME_OPTIONS,
  MESSAGE_DISPLAY_OPTIONS,
  DATE_FORMAT_OPTIONS,
  TIME_FORMAT_OPTIONS,
  PREF_NOTIFICATION_LEVEL_OPTIONS,
  FONT_SIZE_OPTIONS,
  FONT_FAMILY_OPTIONS,
  MESSAGE_SEND_MODE_OPTIONS,
  LINK_PREVIEW_DEFAULT_OPTIONS,
  LABEL_REMOVE_ON_MOVE_OPTIONS,
  VOICE_POLISH_LEVEL_OPTIONS,
  CODE_BLOCK_COLLAPSE_THRESHOLD_MIN,
  CODE_BLOCK_COLLAPSE_THRESHOLD_MAX,
  BLOCKQUOTE_COLLAPSE_THRESHOLD_MIN,
  BLOCKQUOTE_COLLAPSE_THRESHOLD_MAX,
} from "@threa/types"
import { workScheduleSchema, statusPresetsSchema } from "../../lib/schemas"

const updatePreferencesSchema = z.object({
  theme: z.enum(THEME_OPTIONS).optional(),
  messageDisplay: z.enum(MESSAGE_DISPLAY_OPTIONS).optional(),
  dateFormat: z.enum(DATE_FORMAT_OPTIONS).optional(),
  timeFormat: z.enum(TIME_FORMAT_OPTIONS).optional(),
  timezone: z.string().optional(),
  language: z.string().optional(),
  notificationLevel: z.enum(PREF_NOTIFICATION_LEVEL_OPTIONS).optional(),
  sidebarCollapsed: z.boolean().optional(),
  messageSendMode: z.enum(MESSAGE_SEND_MODE_OPTIONS).optional(),
  linkPreviewDefault: z.enum(LINK_PREVIEW_DEFAULT_OPTIONS).optional(),
  labelRemoveOnMove: z.enum(LABEL_REMOVE_ON_MOVE_OPTIONS).optional(),
  scratchpadCustomPrompt: z.string().max(8000).nullable().optional(),
  codeBlockCollapseThreshold: z
    .number()
    .int()
    .min(CODE_BLOCK_COLLAPSE_THRESHOLD_MIN)
    .max(CODE_BLOCK_COLLAPSE_THRESHOLD_MAX)
    .optional(),
  blockquoteCollapseThreshold: z
    .number()
    .int()
    .min(BLOCKQUOTE_COLLAPSE_THRESHOLD_MIN)
    .max(BLOCKQUOTE_COLLAPSE_THRESHOLD_MAX)
    .optional(),
  // Model id like "elevenlabs:scribe-v2-realtime". Validated against the model
  // registry server-side when a session opens; this layer only bounds length.
  voiceTranscriptionModel: z.string().max(100).nullable().optional(),
  voicePolishLevel: z.enum(VOICE_POLISH_LEVEL_OPTIONS).optional(),
  // null clears the personal override (revert to the workspace default).
  workSchedule: workScheduleSchema.nullable().optional(),
  // Per-user custom status presets, additive to the workspace/system defaults.
  statusPresets: statusPresetsSchema.optional(),
  gettingStartedDismissed: z.boolean().optional(),
  keyboardShortcuts: z.record(z.string(), z.string()).optional(),
  accessibility: z
    .object({
      reducedMotion: z.boolean().optional(),
      highContrast: z.boolean().optional(),
      fontSize: z.enum(FONT_SIZE_OPTIONS).optional(),
      fontFamily: z.enum(FONT_FAMILY_OPTIONS).optional(),
    })
    .optional(),
})

export { updatePreferencesSchema }

interface Dependencies {
  userPreferencesService: UserPreferencesService
}

export function createUserPreferencesHandlers({ userPreferencesService }: Dependencies) {
  return {
    async get(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const preferences = await userPreferencesService.getPreferences(workspaceId, userId)
      res.json({ preferences })
    },

    async update(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const result = updatePreferencesSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const preferences = await userPreferencesService.updatePreferences(workspaceId, userId, result.data)
      res.json({ preferences })
    },
  }
}
