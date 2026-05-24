// =============================================================================
// User Preferences Types
// Workspace-scoped preferences that sync across devices
// =============================================================================

// Theme
export const THEME_OPTIONS = ["light", "dark", "system"] as const
export type Theme = (typeof THEME_OPTIONS)[number]

export const Themes = {
  LIGHT: "light",
  DARK: "dark",
  SYSTEM: "system",
} as const satisfies Record<string, Theme>

// Message display density
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

// Time format
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

// Font size for accessibility
export const FONT_SIZE_OPTIONS = ["small", "medium", "large"] as const
export type FontSize = (typeof FONT_SIZE_OPTIONS)[number]

export const FontSizes = {
  SMALL: "small",
  MEDIUM: "medium",
  LARGE: "large",
} as const satisfies Record<string, FontSize>

// Font family for accessibility
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

// Settings tab options (for URL-driven settings dialog)
export const SETTINGS_TAB_OPTIONS = [
  "profile",
  "ai",
  "appearance",
  "datetime",
  "notifications",
  "keyboard",
  "accessibility",
] as const
export type SettingsTab = (typeof SETTINGS_TAB_OPTIONS)[number]

// Alias for convenience
export const SETTINGS_TABS = SETTINGS_TAB_OPTIONS

// =============================================================================
// Domain Types
// =============================================================================

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
  scratchpadCustomPrompt: string | null
  codeBlockCollapseThreshold: number
  blockquoteCollapseThreshold: number
  /**
   * Preferred voice dictation model id (e.g. "elevenlabs:scribe-v2-realtime",
   * "deepgram:nova-3"). When null, the backend falls back to the configured
   * default. The string is validated server-side against the model registry.
   */
  voiceTranscriptionModel: string | null
  keyboardShortcuts: KeyboardShortcuts
  accessibility: AccessibilityPreferences
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
  scratchpadCustomPrompt: null,
  codeBlockCollapseThreshold: DEFAULT_CODE_BLOCK_COLLAPSE_THRESHOLD,
  blockquoteCollapseThreshold: DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD,
  voiceTranscriptionModel: null,
  keyboardShortcuts: {},
  accessibility: DEFAULT_ACCESSIBILITY,
}

// =============================================================================
// API Types
// =============================================================================

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
  scratchpadCustomPrompt?: string | null
  codeBlockCollapseThreshold?: number
  blockquoteCollapseThreshold?: number
  voiceTranscriptionModel?: string | null
  keyboardShortcuts?: KeyboardShortcuts
  accessibility?: Partial<AccessibilityPreferences>
}

// =============================================================================
// Sparse Override Types
// =============================================================================

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
