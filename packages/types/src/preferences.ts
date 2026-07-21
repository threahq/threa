import type { WorkSchedule } from "./work-schedule"
import type { StatusPreset } from "./user-status"
import { DEFAULT_BOARD_LENS, type BoardLens } from "./constants"

// Workspace-scoped preferences that sync across devices.

export const THEME_OPTIONS = ["light", "dark", "system"] as const
export type Theme = (typeof THEME_OPTIONS)[number]

export const Themes = {
  LIGHT: "light",
  DARK: "dark",
  SYSTEM: "system",
} as const satisfies Record<string, Theme>

export const MESSAGE_DISPLAY_OPTIONS = ["compact", "comfortable"] as const
export type MessageDisplay = (typeof MESSAGE_DISPLAY_OPTIONS)[number]

export const MessageDisplays = {
  COMPACT: "compact",
  COMFORTABLE: "comfortable",
} as const satisfies Record<string, MessageDisplay>

// Date format (user chooses format independently of language)
export const DATE_FORMAT_OPTIONS = ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"] as const
export type DateFormat = (typeof DATE_FORMAT_OPTIONS)[number]

export const DateFormats = {
  ISO: "YYYY-MM-DD",
  EU: "DD/MM/YYYY",
  US: "MM/DD/YYYY",
} as const satisfies Record<string, DateFormat>

export const TIME_FORMAT_OPTIONS = ["24h", "12h"] as const
export type TimeFormat = (typeof TIME_FORMAT_OPTIONS)[number]

export const TimeFormats = {
  H24: "24h",
  H12: "12h",
} as const satisfies Record<string, TimeFormat>

// Notification level (user-level global preference, distinct from per-stream NotificationLevel)
export const PREF_NOTIFICATION_LEVEL_OPTIONS = ["all", "mentions", "none"] as const
export type PrefNotificationLevel = (typeof PREF_NOTIFICATION_LEVEL_OPTIONS)[number]

export const PrefNotificationLevels = {
  ALL: "all",
  MENTIONS: "mentions",
  NONE: "none",
} as const satisfies Record<string, PrefNotificationLevel>

export const FONT_SIZE_OPTIONS = ["small", "medium", "large"] as const
export type FontSize = (typeof FONT_SIZE_OPTIONS)[number]

export const FontSizes = {
  SMALL: "small",
  MEDIUM: "medium",
  LARGE: "large",
} as const satisfies Record<string, FontSize>

export const FONT_FAMILY_OPTIONS = ["system", "monospace", "dyslexic"] as const
export type FontFamily = (typeof FONT_FAMILY_OPTIONS)[number]

export const FontFamilies = {
  SYSTEM: "system",
  MONOSPACE: "monospace",
  DYSLEXIC: "dyslexic",
} as const satisfies Record<string, FontFamily>

// Link preview default display mode
export const LINK_PREVIEW_DEFAULT_OPTIONS = ["open", "collapsed"] as const
export type LinkPreviewDefault = (typeof LINK_PREVIEW_DEFAULT_OPTIONS)[number]

export const LinkPreviewDefaults = {
  OPEN: "open",
  COLLAPSED: "collapsed",
} as const satisfies Record<string, LinkPreviewDefault>

// Message send mode - how Enter key behaves in composer
export const MESSAGE_SEND_MODE_OPTIONS = ["enter", "cmdEnter"] as const
export type MessageSendMode = (typeof MESSAGE_SEND_MODE_OPTIONS)[number]

export const MessageSendModes = {
  ENTER: "enter",
  CMD_ENTER: "cmdEnter",
} as const satisfies Record<string, MessageSendMode>

// Where a stream opens when there are unread messages. "latest" (default)
// lands at the newest message with an "N new messages" affordance pointing up
// at the unread marker; "marker" (Discord-style) lands on the first unread
// with a jump-to-latest affordance pointing down.
export const UNREAD_OPEN_POSITION_OPTIONS = ["latest", "marker"] as const
export type UnreadOpenPosition = (typeof UNREAD_OPEN_POSITION_OPTIONS)[number]

export const UnreadOpenPositions = {
  LATEST: "latest",
  MARKER: "marker",
} as const satisfies Record<string, UnreadOpenPosition>

// Label-remove-on-move behavior — when a labeled stream is dragged out of its
// label section in the sidebar (into a custom section or a different label),
// whether to also strip the label it was sitting under. "ask" prompts each time
// (with a remember-my-choice option that flips this preference to always/never).
export const LABEL_REMOVE_ON_MOVE_OPTIONS = ["ask", "always", "never"] as const
export type LabelRemoveOnMove = (typeof LABEL_REMOVE_ON_MOVE_OPTIONS)[number]

export const LabelRemoveOnMoveOptions = {
  ASK: "ask",
  ALWAYS: "always",
  NEVER: "never",
} as const satisfies Record<string, LabelRemoveOnMove>

// Code block collapse threshold - line count above which blocks start collapsed.
// Blocks with fewer lines render expanded by default. A user can always toggle
// an individual block; this preference only controls the initial state.
export const CODE_BLOCK_COLLAPSE_THRESHOLD_MIN = 0
export const CODE_BLOCK_COLLAPSE_THRESHOLD_MAX = 500
export const DEFAULT_CODE_BLOCK_COLLAPSE_THRESHOLD = 10

// Blockquote collapse threshold - line count above which block quotes (and
// quote-reply attributions) start collapsed. Same semantics as the code-block
// threshold, but measured in rendered text lines of the quoted content.
export const BLOCKQUOTE_COLLAPSE_THRESHOLD_MIN = 0
export const BLOCKQUOTE_COLLAPSE_THRESHOLD_MAX = 500
export const DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD = 6

// Stream-description collapse threshold - rendered line count above which a
// "set the description" timeline event starts collapsed behind a Show more/less
// toggle. Same line-count semantics as the code/quote thresholds; not yet a
// user preference (no slider), so a single default rather than a stored value.
export const DEFAULT_DESCRIPTION_COLLAPSE_THRESHOLD = 8

// Message body collapse is opt-in. When enabled, messages taller than
// MESSAGE_COLLAPSE_AT_HEIGHT collapse to MESSAGE_COLLAPSE_TO_HEIGHT; a
// per-message toggle always overrides the automatic initial state.
export const MESSAGE_COLLAPSE_AT_HEIGHT_MIN = 120
export const MESSAGE_COLLAPSE_AT_HEIGHT_MAX = 4000
export const DEFAULT_MESSAGE_COLLAPSE_AT_HEIGHT = 420
export const MESSAGE_COLLAPSE_TO_HEIGHT_MIN = 80
export const MESSAGE_COLLAPSE_TO_HEIGHT_MAX = 2000
export const DEFAULT_MESSAGE_COLLAPSE_TO_HEIGHT = 240
// Legacy line-count threshold kept on the wire so older stored overrides and
// clients don't fail while the UI uses the height-based settings above.
export const MESSAGE_COLLAPSE_THRESHOLD_MIN = 0
export const MESSAGE_COLLAPSE_THRESHOLD_MAX = 500
export const DEFAULT_MESSAGE_COLLAPSE_THRESHOLD = 16

// Board-card collapse is opt-in. When enabled, cards taller than
// BOARD_CARD_COLLAPSE_AT_HEIGHT collapse to BOARD_CARD_COLLAPSE_TO_HEIGHT; a
// per-card toggle always overrides the automatic initial state.
export const BOARD_CARD_COLLAPSE_AT_HEIGHT_MIN = 120
export const BOARD_CARD_COLLAPSE_AT_HEIGHT_MAX = 4000
export const DEFAULT_BOARD_CARD_COLLAPSE_AT_HEIGHT = 600
export const BOARD_CARD_COLLAPSE_TO_HEIGHT_MIN = 120
export const BOARD_CARD_COLLAPSE_TO_HEIGHT_MAX = 2000
export const DEFAULT_BOARD_CARD_COLLAPSE_TO_HEIGHT = 320
// Legacy threshold retained on the wire for older clients.
export const BOARD_CARD_COLLAPSE_THRESHOLD_MIN = 0
export const BOARD_CARD_COLLAPSE_THRESHOLD_MAX = 4000
export const DEFAULT_BOARD_CARD_COLLAPSE_THRESHOLD = DEFAULT_BOARD_CARD_COLLAPSE_AT_HEIGHT

// Voice polish level: how aggressively the polish model rewrites a finalized
// dictation transcript. The id flows through the wire format and is mirrored
// by the backend prompt builder.
//   - "none"        → polish disabled; raw text commits straight to the editor
//   - "minor"       → punctuation, capitalization, restored apostrophes; preserves
//                     filler ("uh", "um") and never collapses self-corrections
//   - "opinionated" → drops filler, applies "no sorry X" corrections, formats
//                     lists, expands ":blush:"-style emoji shortcodes
export const VOICE_POLISH_LEVEL_OPTIONS = ["none", "minor", "opinionated"] as const
export type VoicePolishLevel = (typeof VOICE_POLISH_LEVEL_OPTIONS)[number]

export const VoicePolishLevels = {
  NONE: "none",
  MINOR: "minor",
  OPINIONATED: "opinionated",
} as const satisfies Record<string, VoicePolishLevel>

// Voice steering words: custom spellings (product names, people, domain jargon)
// the dictation pipeline is biased toward so they aren't mis-transcribed — e.g.
// the speaker's "Threa" coming back as "Freya". These are the user's own
// additions; the backend always prepends a small baked-in set (the product's own
// names) on top, so an empty list still corrects the product vocabulary.
// Bounds are shared by the settings UI and the backend validator. The per-term
// cap is loose enough for short phrases; the tighter realtime provider limits
// (ElevenLabs caps each keyterm at 20 chars) are enforced per-provider, not here.
export const VOICE_STEERING_WORDS_MAX = 50
export const VOICE_STEERING_WORD_MAX_LENGTH = 48

// Product proper nouns the dictation pipeline always biases toward, prepended to
// every user's own steering words server-side. These are names STT reliably
// botches ("Threa" → "Freya"); baking them in makes the correction work for
// everyone with zero setup. Shared so the settings UI can show them as
// always-on without duplicating the list (INV-33).
export const VOICE_STEERING_BASE_TERMS = ["Threa", "Ariadne"] as const

// Voice transcription model picker options. The id is the registry id the
// backend validates at session-open time. `null` means "use the server default"
// (currently ElevenLabs Scribe v2 Realtime); the option list itself stays in
// sync with what the backend's voice-transcription registry actually offers.
export interface VoiceTranscriptionModelOption {
  id: string
  name: string
  description: string
}

export const VOICE_TRANSCRIPTION_MODELS: readonly VoiceTranscriptionModelOption[] = [
  {
    id: "elevenlabs:scribe-v2-realtime",
    name: "ElevenLabs Scribe v2",
    description: "Multilingual auto-detect. Higher accuracy across languages.",
  },
  {
    id: "deepgram:nova-3",
    name: "Deepgram Nova-3",
    description: "Multilingual auto-detect. Lower latency.",
  },
] as const

export const SETTINGS_TAB_OPTIONS = [
  "profile",
  "ai",
  "dictation",
  "calls",
  "appearance",
  "datetime",
  "schedule",
  "notifications",
  "keyboard",
  "accessibility",
] as const
export type SettingsTab = (typeof SETTINGS_TAB_OPTIONS)[number]

export const SETTINGS_TABS = SETTINGS_TAB_OPTIONS

/**
 * Accessibility preferences stored as JSONB
 */
export interface AccessibilityPreferences {
  reducedMotion: boolean
  highContrast: boolean
  fontSize: FontSize
  fontFamily: FontFamily
}

/**
 * Default accessibility preferences
 */
export const DEFAULT_ACCESSIBILITY: AccessibilityPreferences = {
  reducedMotion: false,
  highContrast: false,
  fontSize: "medium",
  fontFamily: "system",
}

/**
 * Keyboard shortcuts stored as JSONB
 * Maps action IDs to key bindings (e.g., "openQuickSwitcher": "mod+k")
 */
export interface KeyboardShortcuts {
  [actionId: string]: string
}

/**
 * Full user preferences domain type (wire format)
 */
export interface UserPreferences {
  workspaceId: string
  userId: string
  theme: Theme
  messageDisplay: MessageDisplay
  dateFormat: DateFormat
  timeFormat: TimeFormat
  timezone: string
  language: string
  notificationLevel: PrefNotificationLevel
  sidebarCollapsed: boolean
  messageSendMode: MessageSendMode
  linkPreviewDefault: LinkPreviewDefault
  /**
   * What dragging a labeled stream out of its sidebar label section does to that
   * label. "ask" prompts each time; "always"/"never" act without prompting.
   */
  labelRemoveOnMove: LabelRemoveOnMove
  /**
   * Where a stream with unread messages opens: at the newest message
   * ("latest", the default) or at the first unread ("marker", Discord-style).
   */
  unreadOpenPosition: UnreadOpenPosition
  scratchpadCustomPrompt: string | null
  codeBlockCollapseThreshold: number
  blockquoteCollapseThreshold: number
  /** Whether long message bodies start collapsed automatically. */
  messageCollapseEnabled: boolean
  /** Rendered message-body height (px) above which the fold control appears. */
  messageCollapseAtHeight: number
  /** Max visible message-body height (px) while collapsed. */
  messageCollapseToHeight: number
  /** Legacy line-count setting retained for older clients. */
  messageCollapseThreshold: number
  /** Whether tall board cards start collapsed automatically. */
  boardCardCollapseEnabled: boolean
  /** Rendered card-body height (px) above which the fold control appears. */
  boardCardCollapseAtHeight: number
  /** Max visible card-body height (px) while collapsed. */
  boardCardCollapseToHeight: number
  /** Legacy height setting retained for older clients. */
  boardCardCollapseThreshold: number
  /**
   * The lens the board lands on when the URL names no lens segment (bare
   * `/board`). Defaults to `all`. This only picks the home; every lens still has
   * its own URL, and `all` stays the surfacing baseline a fresh post returns to.
   */
  boardDefaultLens: BoardLens
  /**
   * A saved board view (by id) that overrides `boardDefaultLens` as the landing:
   * the bare `/board` bounces to this view's filtered URL. `null` means land on
   * `boardDefaultLens`. A deleted/unresolved id falls back to `boardDefaultLens`,
   * so a stale pointer degrades quietly instead of dead-ending.
   */
  boardDefaultViewId: string | null
  /**
   * Preferred voice dictation model id (e.g. "elevenlabs:scribe-v2-realtime",
   * "deepgram:nova-3"). When null, the backend falls back to the configured
   * default. The string is validated server-side against the model registry.
   */
  voiceTranscriptionModel: string | null
  /**
   * How aggressively dictated transcripts are rewritten by the polish model.
   * Defaults to "opinionated" so dictation lands clean by default. The session
   * UI exposes a "Show original" toggle so the user can compare or revert
   * per take.
   */
  voicePolishLevel: VoicePolishLevel
  /**
   * Custom spellings the dictation pipeline biases toward (product names, people,
   * domain jargon). Merged with a baked-in set server-side, so `[]` still
   * corrects the product's own vocabulary.
   */
  voiceSteeringWords: string[]
  keyboardShortcuts: KeyboardShortcuts
  accessibility: AccessibilityPreferences
  /**
   * The user's personal working week + working hours. `null` means "inherit the
   * workspace default" — only a user who deliberately diverges from the
   * workspace stores an override. Resolve the effective schedule with
   * user.workSchedule ?? workspaceSettings.defaultWorkSchedule ?? DEFAULT_WORK_SCHEDULE.
   */
  workSchedule: WorkSchedule | null
  /**
   * The user's personal default companion persona for scratchpads with no
   * explicit persona pick. `null` means "inherit the workspace default" — only a
   * user who deliberately diverges from the workspace stores an override. Resolve
   * the effective default with
   * user.defaultCompanionPersonaId ?? workspaceSettings.defaultCompanionPersonaId
   * ?? built-in Ariadne; each tier degrades to the next when its id is missing,
   * archived, or not active in the workspace.
   */
  defaultCompanionPersonaId: string | null
  /**
   * The user's personal status presets, additive to the workspace/system
   * defaults shown in the status picker. Empty by default.
   */
  statusPresets: StatusPreset[]
  /**
   * Whether the user dismissed the sidebar "Getting started" checklist. The
   * checklist also disappears on its own once every task derives as done;
   * this flag only records an explicit dismissal so it stays gone across
   * devices.
   */
  gettingStartedDismissed: boolean
  createdAt: string
  updatedAt: string
}

/**
 * Default user preferences (matches database defaults)
 */
export const DEFAULT_USER_PREFERENCES: Omit<UserPreferences, "workspaceId" | "userId" | "createdAt" | "updatedAt"> = {
  theme: "system",
  messageDisplay: "comfortable",
  dateFormat: "YYYY-MM-DD",
  timeFormat: "24h",
  timezone: "UTC",
  language: "en",
  notificationLevel: "all",
  sidebarCollapsed: false,
  messageSendMode: "enter",
  linkPreviewDefault: "open",
  labelRemoveOnMove: "ask",
  unreadOpenPosition: "latest",
  scratchpadCustomPrompt: null,
  codeBlockCollapseThreshold: DEFAULT_CODE_BLOCK_COLLAPSE_THRESHOLD,
  blockquoteCollapseThreshold: DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD,
  messageCollapseEnabled: false,
  messageCollapseAtHeight: DEFAULT_MESSAGE_COLLAPSE_AT_HEIGHT,
  messageCollapseToHeight: DEFAULT_MESSAGE_COLLAPSE_TO_HEIGHT,
  messageCollapseThreshold: DEFAULT_MESSAGE_COLLAPSE_THRESHOLD,
  boardCardCollapseEnabled: false,
  boardCardCollapseAtHeight: DEFAULT_BOARD_CARD_COLLAPSE_AT_HEIGHT,
  boardCardCollapseToHeight: DEFAULT_BOARD_CARD_COLLAPSE_TO_HEIGHT,
  boardCardCollapseThreshold: DEFAULT_BOARD_CARD_COLLAPSE_THRESHOLD,
  boardDefaultLens: DEFAULT_BOARD_LENS,
  boardDefaultViewId: null,
  voiceTranscriptionModel: null,
  voicePolishLevel: "opinionated",
  voiceSteeringWords: [],
  keyboardShortcuts: {},
  accessibility: DEFAULT_ACCESSIBILITY,
  workSchedule: null,
  defaultCompanionPersonaId: null,
  statusPresets: [],
  gettingStartedDismissed: false,
}

/**
 * Input for updating user preferences (all fields optional for partial updates)
 */
export interface UpdateUserPreferencesInput {
  theme?: Theme
  messageDisplay?: MessageDisplay
  dateFormat?: DateFormat
  timeFormat?: TimeFormat
  timezone?: string
  language?: string
  notificationLevel?: PrefNotificationLevel
  sidebarCollapsed?: boolean
  messageSendMode?: MessageSendMode
  linkPreviewDefault?: LinkPreviewDefault
  labelRemoveOnMove?: LabelRemoveOnMove
  unreadOpenPosition?: UnreadOpenPosition
  scratchpadCustomPrompt?: string | null
  codeBlockCollapseThreshold?: number
  blockquoteCollapseThreshold?: number
  messageCollapseEnabled?: boolean
  messageCollapseAtHeight?: number
  messageCollapseToHeight?: number
  messageCollapseThreshold?: number
  boardCardCollapseEnabled?: boolean
  boardCardCollapseAtHeight?: number
  boardCardCollapseToHeight?: number
  boardCardCollapseThreshold?: number
  boardDefaultLens?: BoardLens
  boardDefaultViewId?: string | null
  voiceTranscriptionModel?: string | null
  voicePolishLevel?: VoicePolishLevel
  voiceSteeringWords?: string[]
  keyboardShortcuts?: KeyboardShortcuts
  accessibility?: Partial<AccessibilityPreferences>
  workSchedule?: WorkSchedule | null
  defaultCompanionPersonaId?: string | null
  statusPresets?: StatusPreset[]
  gettingStartedDismissed?: boolean
}

/**
 * A single preference override stored in the database.
 * Only non-default values are stored.
 */
export interface PreferenceOverride {
  workspaceId: string
  userId: string
  key: string
  value: unknown
  createdAt: string
  updatedAt: string
}

/**
 * Valid top-level preference keys that can be overridden.
 */
export type PreferenceKey = keyof Omit<UserPreferences, "workspaceId" | "userId" | "createdAt" | "updatedAt">

/**
 * Valid nested preference keys (dot notation).
 * e.g., "accessibility.fontSize", "accessibility.reducedMotion"
 */
export type NestedPreferenceKey =
  | PreferenceKey
  | `accessibility.${keyof AccessibilityPreferences}`
  | `keyboardShortcuts.${string}`
