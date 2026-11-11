import {
  DEFAULT_ACCESSIBILITY,
  DEFAULT_USER_PREFERENCES,
  type AccessibilityPreferences,
  type UpdateUserPreferencesInput,
} from "@threahq/types"
import { SHORTCUT_ACTIONS, isCustomBinding } from "@/lib/keyboard-shortcuts"
import type { SettingId } from "./settings-registry"

type Preferences = typeof DEFAULT_USER_PREFERENCES
type PreferenceKey = Exclude<keyof Preferences & keyof UpdateUserPreferencesInput, "accessibility">

interface SettingDefault {
  /** The parts of the preferences this setting writes. */
  read: (preferences: Preferences) => unknown
  /** The write that puts the setting back; absent where resetting would throw away something the user wrote or chose to share. */
  reset?: (preferences: Preferences) => UpdateUserPreferencesInput
}

function preference(...keys: PreferenceKey[]): Required<SettingDefault> {
  const reset: Record<string, unknown> = {}
  for (const key of keys) reset[key] = DEFAULT_USER_PREFERENCES[key]
  return {
    read: (preferences) => keys.map((key) => preferences[key]),
    reset: () => reset as UpdateUserPreferencesInput,
  }
}

function accessibility(key: keyof AccessibilityPreferences): Required<SettingDefault> {
  return {
    read: (preferences) => preferences.accessibility[key],
    reset: () => ({ accessibility: { [key]: DEFAULT_ACCESSIBILITY[key] } }),
  }
}

type FoldHeightKey =
  | "messageCollapseAtHeight"
  | "messageCollapseToHeight"
  | "boardCardCollapseAtHeight"
  | "boardCardCollapseToHeight"

/** A fold's two heights, whose collapsed height never exceeds the one that collapses: each reset keeps the other within it. */
function foldHeights(at: FoldHeightKey, to: FoldHeightKey): Record<"at" | "to", Required<SettingDefault>> {
  const defaults = DEFAULT_USER_PREFERENCES
  return {
    at: {
      read: (preferences) => preferences[at],
      reset: (preferences) => ({ [at]: defaults[at], [to]: Math.min(preferences[to], defaults[at]) }),
    },
    to: {
      read: (preferences) => preferences[to],
      reset: (preferences) => ({ [to]: Math.min(defaults[to], preferences[at]) }),
    },
  }
}

const MESSAGE_FOLD = foldHeights("messageCollapseAtHeight", "messageCollapseToHeight")
const BOARD_CARD_FOLD = foldHeights("boardCardCollapseAtHeight", "boardCardCollapseToHeight")

function keep({ read }: SettingDefault): SettingDefault {
  return { read }
}

/**
 * The one map from a settings row to the preferences it writes and their
 * defaults. Rows not listed (profile fields, device and workspace settings,
 * consents with no neutral answer, a time zone detected per device) have no
 * default to differ from.
 */
const SETTING_DEFAULTS: Partial<Record<SettingId, SettingDefault>> = {
  theme: preference("theme"),
  density: preference("messageDisplay"),
  "font-size": accessibility("fontSize"),
  "font-family": accessibility("fontFamily"),
  "reduce-motion": accessibility("reducedMotion"),
  "high-contrast": accessibility("highContrast"),
  "notification-level": preference("notificationLevel"),
  "push-buttons": preference("pushActions", "pushReminderMinutes", "pushQuickReaction"),
  "working-hours": keep(preference("workSchedule")),
  "quiet-hours": preference("quietOutsideWorkingHours"),
  "unread-landing": preference("unreadOpenPosition"),
  "link-preview-count": preference("linkPreviewDefault", "linkPreviewOpenCount"),
  "link-preview-types": preference("linkPreviewTypeOverrides"),
  "message-collapse": preference("messageCollapseEnabled"),
  "message-collapse-at": MESSAGE_FOLD.at,
  "message-collapse-to": MESSAGE_FOLD.to,
  "code-collapse": preference("codeBlockCollapseEnabled", "codeBlockCollapseThreshold"),
  "code-wrap": preference("codeBlockWrap"),
  "code-wrap-languages": preference("codeBlockWrapOverrides"),
  "quote-collapse": preference("blockquoteCollapseEnabled", "blockquoteCollapseThreshold"),
  settling: preference("inboxClearMode"),
  "label-move": preference("labelRemoveOnMove"),
  "board-home": preference("boardDefaultLens", "boardDefaultViewId"),
  "board-card-collapse": preference("boardCardCollapseEnabled"),
  "board-card-collapse-at": BOARD_CARD_FOLD.at,
  "board-card-collapse-to": BOARD_CARD_FOLD.to,
  "board-full-tail": preference("boardFullTailCount"),
  "board-ledger-rows": preference("boardLedgerRows"),
  "board-lead-line": preference("boardLeadLineLength"),
  "board-head-badge": preference("boardMassBadge"),
  "send-key": preference("messageSendMode"),
  "send-side": accessibility("composerActionSide"),
  "file-insert": preference("mobileInlineAttachments"),
  emoticons: preference("convertEmoticons"),
  // A binding stored as its own default changes nothing.
  shortcuts: {
    read: (preferences) =>
      SHORTCUT_ACTIONS.filter((action) => isCustomBinding(action, preferences.keyboardShortcuts)).map((action) => [
        action.id,
        preferences.keyboardShortcuts[action.id],
      ]),
  },
  "time-format": preference("timeFormat"),
  "date-format": preference("dateFormat"),
  "ai-instructions": keep(preference("scratchpadCustomPrompt")),
  "default-companion": preference("defaultCompanionPersonaId"),
  "subagent-models": preference("subagentModels"),
  "dictation-model": preference("voiceTranscriptionModel"),
  "dictation-polish": preference("voicePolishLevel"),
  "steering-words": keep(preference("voiceSteeringWords")),
  "session-recording": keep(preference("sessionReplayOptIn")),
  "device-sharing": keep(preference("shareDeviceWithAgents")),
  diagnostics: keep(preference("performanceDiagnosticsOptIn")),
}

/** Settings the changed-from-default view covers, in registry order. */
export const SETTINGS_WITH_DEFAULTS = Object.keys(SETTING_DEFAULTS) as SettingId[]

/** Order-sensitive for arrays, order-blind for object keys; empty text counts as unset. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if ((a === "" || a === null || a === undefined) && (b === "" || b === null || b === undefined)) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => sameValue(item, b[i]))
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) => sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
    )
  }
  return false
}

export function isSettingChanged(setting: string, preferences: Preferences | null | undefined): boolean {
  const entry = preferences ? SETTING_DEFAULTS[setting as SettingId] : undefined
  if (!entry || !preferences) return false
  return !sameValue(entry.read(preferences), entry.read(DEFAULT_USER_PREFERENCES))
}

/** The write that restores a setting's default, or null where the row has no safe one-step reset. */
export function settingReset(setting: SettingId, preferences: Preferences): UpdateUserPreferencesInput | null {
  return SETTING_DEFAULTS[setting]?.reset?.(preferences) ?? null
}
