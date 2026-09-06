import { z } from "zod"
import type { Request, Response } from "express"
import type { UserPreferencesService } from "./service"
import {
  ANALYTICS_CONSENT_OPTIONS,
  THEME_OPTIONS,
  MESSAGE_DISPLAY_OPTIONS,
  DATE_FORMAT_OPTIONS,
  TIME_FORMAT_OPTIONS,
  PREF_NOTIFICATION_LEVEL_OPTIONS,
  FONT_SIZE_OPTIONS,
  FONT_FAMILY_OPTIONS,
  MESSAGE_SEND_MODE_OPTIONS,
  COMPOSER_ACTION_SIDE_OPTIONS,
  LINK_PREVIEW_DEFAULT_OPTIONS,
  LABEL_REMOVE_ON_MOVE_OPTIONS,
  UNREAD_OPEN_POSITION_OPTIONS,
  VOICE_POLISH_LEVEL_OPTIONS,
  VOICE_STEERING_WORDS_MAX,
  VOICE_STEERING_WORD_MAX_LENGTH,
  CODE_BLOCK_COLLAPSE_THRESHOLD_MIN,
  CODE_BLOCK_COLLAPSE_THRESHOLD_MAX,
  BLOCKQUOTE_COLLAPSE_THRESHOLD_MIN,
  BLOCKQUOTE_COLLAPSE_THRESHOLD_MAX,
  CODE_BLOCK_WRAP_OPTIONS,
  CODE_LANGUAGE_IDS,
  MESSAGE_COLLAPSE_AT_HEIGHT_MIN,
  MESSAGE_COLLAPSE_AT_HEIGHT_MAX,
  MESSAGE_COLLAPSE_TO_HEIGHT_MIN,
  MESSAGE_COLLAPSE_TO_HEIGHT_MAX,
  MESSAGE_COLLAPSE_THRESHOLD_MIN,
  MESSAGE_COLLAPSE_THRESHOLD_MAX,
  BOARD_CARD_COLLAPSE_AT_HEIGHT_MIN,
  BOARD_CARD_COLLAPSE_AT_HEIGHT_MAX,
  BOARD_CARD_COLLAPSE_TO_HEIGHT_MIN,
  BOARD_CARD_COLLAPSE_TO_HEIGHT_MAX,
  BOARD_CARD_COLLAPSE_THRESHOLD_MIN,
  BOARD_CARD_COLLAPSE_THRESHOLD_MAX,
  BOARD_FULL_TAIL_COUNT_MIN,
  BOARD_FULL_TAIL_COUNT_MAX,
  BOARD_LEDGER_ROWS_MIN,
  BOARD_LEDGER_ROWS_MAX,
  BOARD_LEAD_LINE_LENGTH_MIN,
  BOARD_LEAD_LINE_LENGTH_MAX,
  BOARD_MASS_BADGE_MODES,
  degradeBoardLens,
} from "@threa/types"
import { workScheduleSchema, statusPresetsSchema } from "../../lib/schemas"
import { validateRequest } from "../../lib/validation"

const CODE_LANGUAGE_ID_SET = new Set<string>(CODE_LANGUAGE_IDS)

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
  mobileInlineAttachments: z.boolean().optional(),
  linkPreviewDefault: z.enum(LINK_PREVIEW_DEFAULT_OPTIONS).optional(),
  labelRemoveOnMove: z.enum(LABEL_REMOVE_ON_MOVE_OPTIONS).optional(),
  unreadOpenPosition: z.enum(UNREAD_OPEN_POSITION_OPTIONS).optional(),
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
  codeBlockWrap: z.enum(CODE_BLOCK_WRAP_OPTIONS).optional(),
  // Keys outside the registry are dropped, not rejected: the client always
  // re-sends the whole map, so a language retired from the registry must not
  // make every later preferences write fail (same posture as boardDefaultLens).
  codeBlockWrapOverrides: z
    .record(z.string().min(1).max(64), z.enum(CODE_BLOCK_WRAP_OPTIONS))
    .transform((overrides) =>
      Object.fromEntries(Object.entries(overrides).filter(([languageId]) => CODE_LANGUAGE_ID_SET.has(languageId)))
    )
    .optional(),
  messageCollapseEnabled: z.boolean().optional(),
  messageCollapseAtHeight: z
    .number()
    .int()
    .min(MESSAGE_COLLAPSE_AT_HEIGHT_MIN)
    .max(MESSAGE_COLLAPSE_AT_HEIGHT_MAX)
    .optional(),
  messageCollapseToHeight: z
    .number()
    .int()
    .min(MESSAGE_COLLAPSE_TO_HEIGHT_MIN)
    .max(MESSAGE_COLLAPSE_TO_HEIGHT_MAX)
    .optional(),
  messageCollapseThreshold: z
    .number()
    .int()
    .min(MESSAGE_COLLAPSE_THRESHOLD_MIN)
    .max(MESSAGE_COLLAPSE_THRESHOLD_MAX)
    .optional(),
  boardCardCollapseEnabled: z.boolean().optional(),
  boardCardCollapseAtHeight: z
    .number()
    .int()
    .min(BOARD_CARD_COLLAPSE_AT_HEIGHT_MIN)
    .max(BOARD_CARD_COLLAPSE_AT_HEIGHT_MAX)
    .optional(),
  boardCardCollapseToHeight: z
    .number()
    .int()
    .min(BOARD_CARD_COLLAPSE_TO_HEIGHT_MIN)
    .max(BOARD_CARD_COLLAPSE_TO_HEIGHT_MAX)
    .optional(),
  boardCardCollapseThreshold: z
    .number()
    .int()
    .min(BOARD_CARD_COLLAPSE_THRESHOLD_MIN)
    .max(BOARD_CARD_COLLAPSE_THRESHOLD_MAX)
    .optional(),
  boardFullTailCount: z.number().int().min(BOARD_FULL_TAIL_COUNT_MIN).max(BOARD_FULL_TAIL_COUNT_MAX).optional(),
  boardLedgerRows: z.number().int().min(BOARD_LEDGER_ROWS_MIN).max(BOARD_LEDGER_ROWS_MAX).optional(),
  boardLeadLineLength: z.number().int().min(BOARD_LEAD_LINE_LENGTH_MIN).max(BOARD_LEAD_LINE_LENGTH_MAX).optional(),
  boardMassBadge: z.enum(BOARD_MASS_BADGE_MODES).optional(),
  // Degrades retired lens values (`decisions`) instead of 400ing: an SW-cached
  // old bundle pinning a retired lens must not have its whole preferences PATCH
  // rejected and rolled back. Same authority as board-views' baseLens.
  boardDefaultLens: z.string().transform(degradeBoardLens).optional(),
  // A saved board view id (`boardview_…`) or null to clear. Non-empty, matching
  // the board-view endpoints' own id validation (board-views/handlers.ts); a
  // well-formed but stale id is accepted and degrades to the default lens
  // client-side, but an empty string is rejected.
  boardDefaultViewId: z.string().min(1).max(64).nullable().optional(),
  // Model id like "elevenlabs:scribe-v2-realtime". Validated against the model
  // registry server-side when a session opens; this layer only bounds length.
  voiceTranscriptionModel: z.string().max(100).nullable().optional(),
  voicePolishLevel: z.enum(VOICE_POLISH_LEVEL_OPTIONS).optional(),
  // Custom dictation steering words. Trimmed per entry (drops blank/whitespace);
  // count and length bounded. Provider keyterm caps and the baked-in product
  // terms are applied at session-open time, not here.
  voiceSteeringWords: z
    .array(z.string().trim().min(1).max(VOICE_STEERING_WORD_MAX_LENGTH))
    .max(VOICE_STEERING_WORDS_MAX)
    .optional(),
  // null clears the personal override (revert to the workspace default).
  workSchedule: workScheduleSchema.nullable().optional(),
  // Personal default companion persona id; null clears back to the workspace
  // default. Semantic validation (active persona in this workspace) runs in the service.
  defaultCompanionPersonaId: z.string().min(1).max(64).nullable().optional(),
  // The user's personal narrowing of the workspace's delegable model set. Not
  // validated against the registry here on purpose: it is intersected with the
  // workspace set at resolution, so an id that stops existing simply drops out
  // rather than 400ing a preferences PATCH the user can't fix.
  subagentModels: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
  // Per-user custom status presets, additive to the workspace/system defaults.
  statusPresets: statusPresetsSchema.optional(),
  gettingStartedDismissed: z.boolean().optional(),
  performanceDiagnosticsOptIn: z.boolean().optional(),
  analyticsConsent: z.enum(ANALYTICS_CONSENT_OPTIONS).optional(),
  keyboardShortcuts: z.record(z.string(), z.string()).optional(),
  accessibility: z
    .object({
      reducedMotion: z.boolean().optional(),
      highContrast: z.boolean().optional(),
      fontSize: z.enum(FONT_SIZE_OPTIONS).optional(),
      fontFamily: z.enum(FONT_FAMILY_OPTIONS).optional(),
      composerActionSide: z.enum(COMPOSER_ACTION_SIDE_OPTIONS).optional(),
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

      const data = validateRequest(updatePreferencesSchema, req.body)

      const preferences = await userPreferencesService.updatePreferences(workspaceId, userId, data)
      res.json({ preferences })
    },
  }
}
