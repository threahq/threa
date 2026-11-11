import type { LucideIcon } from "lucide-react"
import {
  Bell,
  BookOpenText,
  Bot,
  BrainCircuit,
  Building2,
  CalendarClock,
  FlaskConical,
  KeyRound,
  Keyboard,
  Mic,
  Palette,
  PanelLeft,
  Plug,
  Share2,
  ShieldCheck,
  Sparkles,
  SlidersHorizontal,
  UserRound,
  Users,
} from "lucide-react"
import {
  StreamTypes,
  WORKSPACE_PERMISSION_SCOPES,
  type MessageSendMode,
  type NotificationLevel,
  type SettingsTab,
  type StreamType,
  type WorkspacePermissionSlug,
} from "@threahq/types"
import {
  SHORTCUT_ACTIONS,
  getEffectiveKeyBinding,
  isMac,
  occupiedBindings,
  parseKeyBinding,
} from "@/lib/keyboard-shortcuts"
import { WORD_MATCH, withinTypoBudget, wordMatchQuality } from "@/lib/fuzzy"
import type { StreamSettingsTab } from "@/contexts/settings-context"
import { streamHasMembers } from "@/components/stream-settings/use-stream-members"
import { streamFallbackLabel } from "@/lib/streams"

/**
 * The one owner of what settings exist, where they live and what they are
 * called. The settings window renders its nav, page headers, section titles,
 * row labels and descriptions from here; in-window search, the overview and the
 * command palette search the same entries, so a setting can't be findable under
 * one name and shown under another.
 */

export type SettingsGroup = "you" | "workspace"

export interface SettingsPageConfig {
  label: string
  group: SettingsGroup
  icon: LucideIcon
  /** What the page holds, for the overview: it reads beside the page's current values. */
  covers: string
  /** Extra terms that find the page itself. */
  keywords: string[]
  /** Only workspace admins get the page; it is marked so wherever it is listed. */
  admins?: true
  /** A workspace page's edits need one of these; a viewer with none sees it marked view only. */
  editableWith?: readonly WorkspacePermissionSlug[]
}

export const SETTINGS_PAGE_CONFIG: Record<SettingsTab, SettingsPageConfig> = {
  profile: {
    label: "Profile",
    group: "you",
    icon: UserRound,
    covers: "Photo, name, status, pronouns, contact",
    keywords: ["account", "me"],
  },
  notifications: {
    label: "Notifications",
    group: "you",
    icon: Bell,
    covers: "Push, pause, delivery, quiet hours",
    keywords: ["alerts", "push", "do not disturb", "quiet"],
  },
  appearance: {
    label: "Appearance",
    group: "you",
    icon: Palette,
    covers: "Theme, text size, font, motion, contrast",
    keywords: ["accessibility", "a11y", "look", "display", "visual"],
  },
  messages: {
    label: "Reading",
    group: "you",
    icon: BookOpenText,
    covers: "Unreads, link previews, long content",
    keywords: ["messages", "timeline"],
  },
  inbox: {
    label: "Sidebar & board",
    group: "you",
    icon: PanelLeft,
    covers: "Inbox clearing, labels, board",
    keywords: ["inbox", "streams", "labels", "settle", "board", "cards", "kanban"],
  },
  keyboard: {
    label: "Keyboard & composer",
    group: "you",
    icon: Keyboard,
    covers: "Send key, send button, shortcuts",
    keywords: ["shortcuts", "hotkeys", "keybindings", "composer", "typing"],
  },
  datetime: {
    label: "Time & schedule",
    group: "you",
    icon: CalendarClock,
    covers: "Time zone, clock, date format, working hours",
    keywords: ["date", "clock", "calendar", "schedule", "hours", "work week"],
  },
  ai: {
    label: "Your AI",
    group: "you",
    icon: Sparkles,
    covers: "Default agent for new scratchpads, your agents, instructions",
    keywords: ["ariadne", "agents", "assistant", "companion"],
  },
  voice: {
    label: "Voice & calls",
    group: "you",
    icon: Mic,
    covers: "Dictation, your words, call video and layout",
    keywords: ["audio", "microphone", "video", "speech"],
  },
  privacy: {
    label: "Privacy & security",
    group: "you",
    icon: ShieldCheck,
    covers: "Encrypted scratchpads, usage data, device sharing",
    keywords: ["security", "e2ee", "telemetry", "tracking"],
  },
  developer: {
    label: "API keys & bots",
    group: "you",
    icon: KeyRound,
    covers: "Personal API keys, your bots",
    keywords: ["developer", "api", "automation", "integrations", "token"],
  },
  "early-access": {
    label: "Early access",
    group: "you",
    icon: FlaskConical,
    covers: "Features turned on for you early",
    keywords: ["beta", "experiments", "feature flags"],
  },
  members: {
    label: "Members",
    group: "workspace",
    icon: Users,
    covers: "People, invitations, guest direct messages",
    keywords: ["people", "team", "users"],
    editableWith: [WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE],
  },
  workspace: {
    label: "Workspace details",
    group: "workspace",
    icon: Building2,
    covers: "Name, data region, time zone",
    keywords: ["workspace", "organization"],
    editableWith: [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN],
  },
  "workspace-defaults": {
    label: "Defaults & presets",
    group: "workspace",
    icon: SlidersHorizontal,
    covers: "Working hours, statuses, dictation words",
    keywords: ["defaults", "member defaults", "workspace defaults", "shared with members", "presets", "fallback"],
    editableWith: [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN],
  },
  "workspace-ai": {
    label: "Workspace AI",
    group: "workspace",
    icon: BrainCircuit,
    covers: "Agents, models, sandbox, spend limits",
    keywords: ["ai agents", "personas", "ariadne", "assistant", "companions"],
    admins: true,
  },
  integrations: {
    label: "Integrations",
    group: "workspace",
    icon: Plug,
    covers: "GitHub, Linear",
    keywords: ["connect", "apps"],
    editableWith: [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN],
  },
  bots: {
    label: "Shared bots",
    group: "workspace",
    icon: Bot,
    covers: "Bots everyone here can use",
    keywords: ["bots", "automation", "workspace bots", "webhook"],
    editableWith: [WORKSPACE_PERMISSION_SCOPES.BOTS_MANAGE, WORKSPACE_PERMISSION_SCOPES.BOTS_CREATE_SHARED],
  },
}

export const SETTINGS_GROUP_LABELS: Record<SettingsGroup, string> = {
  you: "You",
  workspace: "Workspace",
}

export interface SettingsSectionConfig {
  tab: SettingsTab
  title: string
}

/** Sections in the order their page renders them. */
export const SETTINGS_SECTIONS = {
  identity: { tab: "profile", title: "Identity" },
  contact: { tab: "profile", title: "Contact details" },
  "notify-when": { tab: "notifications", title: "When to notify" },
  "notify-device": { tab: "notifications", title: "Delivery" },
  "notify-quiet": { tab: "notifications", title: "Quiet hours" },
  theme: { tab: "appearance", title: "Theme & density" },
  text: { tab: "appearance", title: "Font & size" },
  comfort: { tab: "appearance", title: "Motion & contrast" },
  opening: { tab: "messages", title: "Opening streams" },
  "link-previews": { tab: "messages", title: "Link previews" },
  "long-messages": { tab: "messages", title: "Long messages" },
  "code-blocks": { tab: "messages", title: "Code blocks" },
  "block-quotes": { tab: "messages", title: "Quotes" },
  "inbox-settling": { tab: "inbox", title: "Inbox" },
  labels: { tab: "inbox", title: "Labels" },
  board: { tab: "inbox", title: "Board" },
  sending: { tab: "keyboard", title: "Sending" },
  composer: { tab: "keyboard", title: "Composer" },
  shortcuts: { tab: "keyboard", title: "Shortcuts" },
  "shortcuts-navigation": { tab: "keyboard", title: "Navigation shortcuts" },
  "shortcuts-view": { tab: "keyboard", title: "View shortcuts" },
  "shortcuts-editing": { tab: "keyboard", title: "Editing shortcuts" },
  "time-format": { tab: "datetime", title: "Time zone & format" },
  "working-hours": { tab: "datetime", title: "Working hours" },
  "ai-agents": { tab: "ai", title: "Agents" },
  instructions: { tab: "ai", title: "Your instructions" },
  dictation: { tab: "voice", title: "Dictation" },
  calls: { tab: "voice", title: "Calls" },
  encryption: { tab: "privacy", title: "Encrypted scratchpads" },
  "data-sharing": { tab: "privacy", title: "Data sharing" },
  "dev-flags": { tab: "early-access", title: "Features" },
  "dev-keys": { tab: "developer", title: "API keys" },
  "dev-bots": { tab: "developer", title: "Your bots" },
  "workspace-people": { tab: "members", title: "People" },
  "workspace-invitations": { tab: "members", title: "Invitations" },
  "workspace-access": { tab: "members", title: "Access" },
  "workspace-identity": { tab: "workspace", title: "Details" },
  "defaults-time": { tab: "workspace-defaults", title: "Working hours" },
  "defaults-status": { tab: "workspace-defaults", title: "Statuses" },
  "defaults-voice": { tab: "workspace-defaults", title: "Dictation words" },
  "workspace-agents": { tab: "workspace-ai", title: "Agents" },
  "workspace-assistant": { tab: "workspace-ai", title: "Agent behavior" },
  "ai-spend": { tab: "workspace-ai", title: "Spend" },
  "workspace-integrations": { tab: "integrations", title: "Connected services" },
  "workspace-bots": { tab: "bots", title: "Workspace bots" },
} as const satisfies Record<string, SettingsSectionConfig>

export type SettingsSectionId = keyof typeof SETTINGS_SECTIONS

export type SettingAppliesOn = "phones" | "keyboards" | "desktop"

export interface SettingDef {
  section: SettingsSectionId
  label: string
  description?: string
  /**
   * Hidden search terms: synonyms, and the symptom a user would describe
   * ("only the first link shows a preview") when they don't know the name.
   */
  keywords?: string[]
  /** Kept on this device only, not synced with the account. */
  device?: boolean
  /**
   * Only changes anything on these devices; the row is marked so elsewhere it
   * doesn't read as broken. "keyboards": only with a hardware keyboard, marked
   * on touch-only devices. "desktop": only in the desktop layout, marked while
   * this device uses the phone layout.
   */
  appliesOn?: SettingAppliesOn
}

export const SETTINGS = {
  avatar: { section: "identity", label: "Photo", keywords: ["avatar", "picture", "image", "profile picture"] },
  "display-name": { section: "identity", label: "Display name", keywords: ["name", "nickname", "rename myself"] },
  status: {
    section: "identity",
    label: "Status",
    description: "What others see next to your name, such as “In a meeting”.",
    keywords: ["away", "busy", "emoji", "presence"],
  },
  pronouns: { section: "identity", label: "Pronouns", keywords: ["she", "he", "they"] },
  bio: { section: "identity", label: "Description", keywords: ["bio", "about me", "title", "role"] },
  email: {
    section: "contact",
    label: "Email",
    description: "Your sign-in address. It can't be changed here.",
    keywords: ["address", "login"],
  },
  phone: { section: "contact", label: "Phone", keywords: ["number", "mobile"] },
  github: { section: "contact", label: "GitHub username", keywords: ["handle", "profile link"] },

  "notification-level": {
    section: "notify-when",
    label: "Push notifications",
    description: "Which notifications from your streams also reach your devices as a push.",
    keywords: [
      "notify me about",
      "mentions",
      "all messages",
      "everything",
      "nothing",
      "notified for every message",
      "push all",
      "push mentions",
      "no push",
      "too many notifications",
      "channel notifications",
    ],
  },
  pause: {
    section: "notify-when",
    label: "Pause notifications",
    description: "Silence everything for a while.",
    keywords: ["snooze", "do not disturb", "dnd", "mute", "stop notifications"],
  },
  "push-device": {
    section: "notify-device",
    label: "Push on this device",
    description: "Get notified even when Threa isn't open.",
    keywords: ["enable notifications", "browser notifications", "phone", "stop push", "this device"],
  },
  "push-buttons": {
    section: "notify-device",
    label: "Notification buttons",
    description: "Quick actions on a notification.",
    keywords: ["remind me", "quick reaction", "snooze", "chrome"],
  },
  "working-hours": {
    section: "working-hours",
    label: "Your working hours",
    description:
      "Reminders like “Tomorrow morning” start when your day does. Until you set your own, the workspace's apply.",
    keywords: ["schedule", "work week", "shifts", "availability", "workday", "office hours"],
  },
  "quiet-hours": {
    section: "notify-quiet",
    label: "Quiet outside working hours",
    description: "No pushes outside your working hours. Activity still shows up in Threa.",
    keywords: ["do not disturb", "dnd", "mute at night", "after hours", "weekend", "focus", "quiet notifications"],
  },

  theme: { section: "theme", label: "Theme", keywords: ["dark mode", "light mode", "colors", "night"] },
  density: {
    section: "theme",
    label: "Message density",
    keywords: ["compact", "comfortable", "spacing", "dense"],
  },
  "font-size": {
    section: "text",
    label: "Text size",
    keywords: ["font size", "bigger text", "larger", "zoom", "smaller text"],
  },
  "font-family": {
    section: "text",
    label: "Font",
    keywords: ["typeface", "dyslexia", "dyslexic", "opendyslexic", "monospace"],
  },
  "reduce-motion": {
    section: "comfort",
    label: "Reduce motion",
    description: "Turn off animations and transitions.",
    keywords: ["animation", "vestibular"],
  },
  "high-contrast": {
    section: "comfort",
    label: "High contrast",
    description: "Stronger secondary text, borders, controls and focus rings.",
    keywords: ["contrast", "visibility", "low vision"],
  },

  "link-preview-count": {
    section: "link-previews",
    label: "Previews to expand",
    description: "How many link previews open in each message. Links after that show collapsed.",
    keywords: [
      "only the first link shows a preview",
      "link preview settings",
      "preview missing",
      "expand previews",
      "collapse previews",
      "unfurl",
      "embeds",
    ],
  },
  "link-preview-types": {
    section: "link-previews",
    label: "By link type",
    description: "Give images, videos, GitHub, Linear, websites or PDFs their own count.",
    keywords: ["images", "videos", "github", "linear", "pdf", "websites", "unfurl"],
  },
  "message-collapse": {
    section: "long-messages",
    label: "Collapse long messages",
    description: "Start long messages collapsed behind “Show more”.",
    keywords: ["fold long messages", "show more", "show less", "truncated", "cut off", "fold", "long message settings"],
  },
  "message-collapse-at": {
    section: "long-messages",
    label: "Collapse messages taller than",
    keywords: ["show more", "height", "long message", "fold"],
  },
  "message-collapse-to": {
    section: "long-messages",
    label: "Collapsed message height",
    description: "How much of a collapsed message shows above “Show more”.",
    keywords: ["show more", "height", "fold"],
  },
  "code-collapse": {
    section: "code-blocks",
    label: "Collapse long code blocks",
    description: "Start long code blocks collapsed. Expand one any time.",
    keywords: ["code collapsed", "code block hidden", "snippet", "fold"],
  },
  "code-collapse-at": {
    section: "code-blocks",
    label: "Collapse code blocks longer than",
    keywords: ["code block", "snippet", "lines", "length", "fold"],
  },
  "code-wrap": {
    section: "code-blocks",
    label: "Long lines",
    keywords: ["wrap", "scroll horizontally", "line wrapping", "overflow"],
  },
  "code-wrap-languages": {
    section: "code-blocks",
    label: "Per language",
    description: "Wrap or scroll lines differently for specific languages.",
    keywords: ["markdown", "json", "python", "wrap"],
  },
  "quote-collapse": {
    section: "block-quotes",
    label: "Collapse long quotes",
    description: "Start long quotes and quote replies collapsed. Expand one any time.",
    keywords: ["blockquote", "quote reply", "collapsed quote", "fold"],
  },
  "quote-collapse-at": {
    section: "block-quotes",
    label: "Collapse quotes longer than",
    keywords: ["blockquote", "quote reply", "lines", "length", "fold"],
  },

  "unread-landing": {
    section: "opening",
    label: "When there are unreads",
    description: "Where a stream with messages you haven't read opens.",
    keywords: [
      "open streams with unreads",
      "opens at the bottom",
      "first unread",
      "latest message",
      "jump",
      "scroll position",
      "where I left off",
    ],
  },
  settling: {
    section: "inbox-settling",
    label: "Remove from Inbox",
    description: "What takes a stream out of your Inbox.",
    keywords: ["settle", "disappeared from inbox", "inbox cleared", "stays in inbox", "done"],
  },
  "label-move": {
    section: "labels",
    label: "When you drag a labeled stream",
    description: "Moving a stream into a custom section or under another label can drop the label it had.",
    keywords: ["label removed", "label disappeared", "drag", "sidebar section", "remove label"],
  },
  "board-home": {
    section: "board",
    label: "Default view",
    description: "Where Board opens. Every view also has its own link.",
    keywords: ["board opens on", "board default", "lens", "saved view", "all", "mine"],
  },
  "board-card-collapse": {
    section: "board",
    label: "Collapse tall cards",
    description: "Start tall cards collapsed behind “Show more”.",
    keywords: ["board card", "fold", "height"],
  },
  "board-card-collapse-at": {
    section: "board",
    label: "Collapse cards taller than",
    keywords: ["board card", "height", "tall"],
  },
  "board-card-collapse-to": {
    section: "board",
    label: "Collapsed card height",
    description: "Also the height of a card you collapse by hand.",
    keywords: ["board card", "height", "folded"],
  },
  "board-full-tail": {
    section: "board",
    label: "Newest messages in full",
    description: "Older messages on a card shrink to one line each.",
    keywords: ["ledger", "board card"],
  },
  "board-ledger-rows": {
    section: "board",
    label: "One-line messages per card",
    description: "Beyond this, older messages collapse into one row at the top of the card.",
    keywords: ["ledger rows", "board card"],
  },
  "board-lead-line": {
    section: "board",
    label: "One-line message length",
    description: "Characters kept of each one-line message.",
    keywords: ["ledger", "truncate", "board card"],
  },
  "board-head-badge": {
    section: "board",
    label: "Badge on collapsed messages",
    description: "What the top row of a card shows about the messages collapsed into it.",
    keywords: ["ledger", "unread count", "badge"],
  },

  "send-key": {
    section: "sending",
    label: "Enter key",
    appliesOn: "keyboards",
    keywords: ["send", "newline", "new line", "shift enter", "cmd enter", "ctrl enter", "line break"],
  },
  "send-side": {
    section: "sending",
    label: "Send button side",
    keywords: ["left-handed", "left handed", "handedness", "reach", "thumb", "send button on the left"],
  },
  "file-insert": {
    section: "composer",
    label: "Insert files at the cursor",
    description: "Picked files land where you're typing instead of in the tray above.",
    keywords: ["attachments", "images inline", "mobile", "upload"],
    appliesOn: "phones",
  },
  emoticons: {
    section: "composer",
    label: "Turn emoticons into emoji",
    description: ":) becomes 🙂 when you finish the word. Backspace right after brings the text back.",
    keywords: ["emoticon", "smiley", "text face", ":)", ":p", ":D", "<3", "auto convert", "autocorrect"],
  },
  shortcuts: {
    section: "shortcuts",
    label: "Key bindings",
    description: "Select a shortcut, then press the new keys. If another shortcut has them, you pick which keeps them.",
    appliesOn: "keyboards",
    keywords: ["keyboard shortcuts", "hotkeys", "keybindings", "rebind", "remap", "change shortcut"],
  },

  timezone: {
    section: "time-format",
    label: "Time zone",
    description: "Shown to others and used by agents and reminders. Times on screen follow this device.",
    keywords: ["timezone", "tz", "location", "utc", "wrong time"],
  },
  "time-format": { section: "time-format", label: "Clock", keywords: ["24-hour", "24h", "12-hour", "12h", "am pm"] },
  "date-format": { section: "time-format", label: "Date format", keywords: ["dd/mm", "mm/dd", "iso", "date order"] },

  "ai-instructions": {
    section: "instructions",
    label: "Instructions for your scratchpads",
    description:
      "Every agent follows these in your scratchpads and their threads. Channels and DMs set their own agent and brief.",
    keywords: ["prompt", "custom instructions", "system prompt", "why does the agent behave", "personality", "tone"],
  },
  "default-companion": {
    section: "ai-agents",
    label: "Your default agent",
    description: "New scratchpads start with this agent. Existing ones keep theirs.",
    keywords: ["default companion", "companion", "persona", "ariadne", "who answers"],
  },
  "subagent-models": {
    section: "ai-agents",
    label: "Your subagent models",
    description:
      "Models your agents may start helpers on, from the ones the workspace allows. The agent that replies keeps its own model.",
    keywords: ["model", "llm", "subagent", "helper", "which model"],
  },
  "my-personas": {
    section: "ai-agents",
    label: "Your agents",
    description: "Agents only you can use.",
    keywords: ["personas", "custom agent", "fork", "new agent"],
  },

  "dictation-model": {
    section: "dictation",
    label: "Transcription model",
    keywords: ["voice", "speech to text", "dictation", "language", "mic"],
  },
  "dictation-polish": {
    section: "dictation",
    label: "Clean up dictated text",
    description: "How thoroughly dictated text is tidied before it reaches the composer.",
    keywords: ["polish", "punctuation", "filler words", "voice", "show original"],
  },
  "steering-words": {
    section: "dictation",
    label: "Your dictation words",
    description: "Names and jargon dictation keeps getting wrong. They add to the workspace's words.",
    keywords: ["vocabulary", "spelling", "misheard", "steering words", "custom words"],
  },
  "call-mirror": {
    section: "calls",
    label: "Mirror my video",
    description: "Flips how you see yourself. Others always see you unflipped.",
    keywords: ["self-view", "mirrored", "flipped", "camera", "selfie"],
    device: true,
  },
  "call-layout": {
    section: "calls",
    label: "Default layout",
    description: "How tiles are arranged when a call starts. You can switch mid-call.",
    keywords: ["speaker", "grid", "gallery"],
    device: true,
  },
  "call-desktop-video": {
    section: "calls",
    label: "Desktop video",
    description: "Where calls open when this device uses the desktop layout.",
    keywords: ["picture in picture", "pip", "window", "pane"],
    device: true,
    appliesOn: "desktop",
  },

  encryption: {
    section: "encryption",
    label: "End-to-end encryption",
    description:
      "Only devices you unlock can read encrypted scratchpads: their messages, names, drafts and attachments. Threa's servers can't, and agents only when you invite them.",
    keywords: [
      "e2ee",
      "encrypted",
      "passphrase",
      "recovery",
      "secure",
      "private",
      "keys",
      "lock",
      "devices",
      "encrypted scratchpad",
    ],
  },
  "encryption-keep-unlocked": {
    section: "encryption",
    label: "Keep me unlocked on this device",
    description: "Skips the passphrase next time here. Leave off on shared or public computers.",
    keywords: ["trust", "remember", "stay unlocked", "passphrase", "e2ee"],
    device: true,
  },
  "encryption-unlock-method": {
    section: "encryption",
    label: "Unlock method on this device",
    description: "A PIN or biometrics instead of unlocking automatically.",
    keywords: ["pin", "biometric", "biometrics", "fingerprint", "face", "touch id", "quick unlock", "e2ee"],
    device: true,
  },
  "crash-reports": {
    section: "data-sharing",
    label: "Crash reports and usage data",
    description: "Errors and which features you use. Never message content.",
    keywords: ["analytics", "telemetry", "posthog", "tracking", "opt out"],
  },
  "session-recording": {
    section: "data-sharing",
    label: "Record my sessions",
    description: "Where you click or tap and how the screen responds. Text and images are masked.",
    keywords: ["session replay", "recording", "screen"],
  },
  "device-sharing": {
    section: "data-sharing",
    label: "Share device and open docs with agents",
    description: "Your layout and system, never your location. Off deletes what agents had.",
    keywords: [
      "agents see my device",
      "tell agents which device",
      "phone or desktop",
      "open documents",
      "location",
      "context",
      "operating system",
    ],
  },
  diagnostics: {
    section: "data-sharing",
    label: "Performance diagnostics",
    description:
      "Response times and dropped connections, never message content. Kept on this device for seven days, and sent with your usage data while that is on.",
    keywords: ["slow", "lag", "freeze", "performance", "timing", "connection"],
  },

  "personal-api-keys": {
    section: "dev-keys",
    label: "Personal API keys",
    description: "Keys that act as you, with your permissions and stream access.",
    keywords: ["token", "script", "cli", "access key", "automation"],
  },
  "my-bots": {
    section: "dev-bots",
    label: "Personal bots",
    description: "Bots that act for you. Only you manage them.",
    keywords: ["bot", "automation", "webhook", "personal bot"],
  },
  "feature-flags": {
    section: "dev-flags",
    label: "Turned on for you",
    description: "Features you get before everyone else.",
    keywords: ["beta", "experiments", "rollout", "feature flags"],
  },

  "workspace-name": {
    section: "workspace-identity",
    label: "Workspace name",
    keywords: ["rename workspace", "title"],
  },
  "workspace-region": {
    section: "workspace-identity",
    label: "Data region",
    description: "Where messages and files are stored. Set at creation; it can't be changed.",
    keywords: ["location", "eu", "us", "residency", "gdpr"],
  },
  "workspace-timezone": {
    section: "workspace-identity",
    label: "AI spend reset time zone",
    description: "Monthly AI spend limits reset at midnight on the 1st in this time zone.",
    keywords: ["workspace time zone", "billing", "timezone", "budget reset", "when limits reset"],
  },
  "workspace-created": {
    section: "workspace-identity",
    label: "Created",
    keywords: ["creation date", "when created", "workspace age"],
  },
  "spend-limits": {
    section: "ai-spend",
    label: "Budget and limits",
    description: "The workspace's monthly AI budget, each member's limit and the off switch.",
    keywords: [
      "spend limits",
      "budget",
      "ai cost",
      "cost",
      "usage",
      "spending",
      "monthly limit",
      "cap",
      "allowance",
      "quota",
      "turn off ai",
    ],
  },
  members: {
    section: "workspace-people",
    label: "Members",
    keywords: ["people", "who's here", "users", "roles", "remove member", "admin"],
  },
  invites: {
    section: "workspace-invitations",
    label: "Invite people",
    description: "By email or with a join link.",
    keywords: ["invite", "teammate", "add people", "join link", "onboard"],
  },
  "guest-dms": {
    section: "workspace-access",
    label: "Guest direct messages",
    description: "Who guests can message directly. A DM this no longer allows turns read-only.",
    keywords: ["guests", "dm", "external", "who can message"],
  },
  "default-working-hours": {
    section: "defaults-time",
    label: "Default working hours",
    description:
      "Members who haven't set their own hours get these. “Tomorrow morning” and “Next week” snap to the start of work.",
    keywords: ["schedule", "work week", "office hours"],
  },
  "status-presets": {
    section: "defaults-status",
    label: "Status presets",
    description: "Statuses everyone can pick with one tap, next to their own.",
    keywords: ["status", "away", "lunch", "presets"],
  },
  "shared-steering-words": {
    section: "defaults-voice",
    label: "Workspace dictation words",
    description: "Dictation knows these for everyone, on top of each member's own words.",
    keywords: ["vocabulary", "jargon", "steering words", "names"],
  },
  "workspace-personas": {
    section: "workspace-agents",
    label: "Workspace agents",
    description: "Built-in agents let you change tools, model and style. Agents you create are fully editable.",
    keywords: ["personas", "ariadne", "model", "tools", "style", "prompt", "new agent"],
  },
  "workspace-default-companion": {
    section: "workspace-assistant",
    label: "Workspace default agent",
    description: "New scratchpads start with this agent unless a member picked their own. Existing ones keep theirs.",
    keywords: ["default companion", "companion", "persona", "workspace default"],
  },
  "follow-up-limit": {
    section: "workspace-assistant",
    label: "Follow-up limit",
    description: "Pending follow-ups an agent may hold in one stream before it stops scheduling more.",
    keywords: ["follow ups", "scheduled", "reminders", "agent"],
  },
  "workspace-subagent-models": {
    section: "workspace-assistant",
    label: "Workspace subagent models",
    description:
      "Models agents may hand work to, billed to the workspace's AI budget at these rates. Members can narrow the list for themselves.",
    keywords: ["model", "allowlist", "subagent", "helper"],
  },
  "sandbox-internet": {
    section: "workspace-assistant",
    label: "Sandbox internet access",
    description:
      "Sandbox commands can reach the internet in conversations that allow web access, so copied files could leave. Changing it resets sandboxes and deletes their files.",
    keywords: ["sandbox", "network", "internet", "code execution", "web access"],
  },
  "github-integration": {
    section: "workspace-integrations",
    label: "GitHub",
    description: "Rich previews for GitHub links.",
    keywords: ["integrations", "connect", "repositories", "pull requests", "commits", "git"],
  },
  "linear-integration": {
    section: "workspace-integrations",
    label: "Linear",
    description: "Rich previews for Linear links.",
    keywords: ["integrations", "connect", "issues", "tickets", "projects"],
  },
  "workspace-bots": {
    section: "workspace-bots",
    label: "Bots",
    description: "Automation accounts anyone here can use.",
    keywords: ["bot", "webhook", "automation", "api"],
  },
} as const satisfies Record<string, SettingDef>

export type SettingId = keyof typeof SETTINGS

/** What a settings row shows: a setting of the settings window or of a stream's own window. */
export type SettingRowDef = Pick<SettingDef, "label" | "description" | "device" | "appliesOn">

export function settingDef(id: AnySettingId): SettingRowDef {
  return Object.hasOwn(SETTINGS, id) ? SETTINGS[id as SettingId] : STREAM_SETTINGS[id as StreamSettingId]
}

export function sectionsOfTab(tab: SettingsTab): SettingsSectionId[] {
  return (Object.keys(SETTINGS_SECTIONS) as SettingsSectionId[]).filter((id) => SETTINGS_SECTIONS[id].tab === tab)
}

export function settingsOfSection(section: SettingsSectionId): SettingId[] {
  return (Object.keys(SETTINGS) as SettingId[]).filter((id) => SETTINGS[id].section === section)
}

export function tabOfSetting(id: string): SettingsTab | null {
  if (Object.hasOwn(SETTINGS, id)) return SETTINGS_SECTIONS[SETTINGS[id as SettingId].section].tab
  if (id.startsWith(SHORTCUT_ANCHOR_PREFIX)) return "keyboard"
  return null
}

/** Where a setting lives, as it reads in the window's nav: "You › API keys & bots". */
export function settingPageTrail(id: SettingId): string {
  const page = SETTINGS_PAGE_CONFIG[SETTINGS_SECTIONS[SETTINGS[id].section].tab]
  return `${SETTINGS_GROUP_LABELS[page.group]} › ${page.label}`
}

/** DOM id of a setting's row, the target of `?setting=` deep links. */
export function settingAnchorId(id: string): string {
  return `setting-${id}`
}

/** DOM id of a section's heading, the target of the page's section jumps. */
export function settingsSectionHeadingId(section: SettingsSectionId | StreamSettingsSectionId): string {
  return `settings-section-${section}`
}

/**
 * A personal setting and the workspace setting it falls back to or adds to.
 * Each row links to its twin, so either one leads to the other.
 */
const SETTING_TWINS = [
  ["working-hours", "default-working-hours"],
  ["status", "status-presets"],
  ["default-companion", "workspace-default-companion"],
  ["subagent-models", "workspace-subagent-models"],
  ["steering-words", "shared-steering-words"],
  ["my-bots", "workspace-bots"],
] as const satisfies readonly (readonly [SettingId, SettingId])[]

/** A setting that only takes effect through another one, so its row links there. */
const SETTING_DEPENDS_ON: Partial<Record<AnySettingId, SettingId>> = {
  "quiet-hours": "working-hours",
  "stream-bots": "workspace-bots",
}

/** The setting a row links to: its twin, or the one it depends on. */
export function relatedSetting(id: string): SettingId | null {
  for (const [personal, workspace] of SETTING_TWINS) {
    if (personal === id) return workspace
    if (workspace === id) return personal
  }
  return SETTING_DEPENDS_ON[id as AnySettingId] ?? null
}

/** Shortcut rows are anchored per action, so search can land on "Bold" itself. */
export const SHORTCUT_ANCHOR_PREFIX = "shortcut-"

/** How a choice reads, wherever a setting's current value is shown. */
export const SETTING_CHOICE_LABELS = {
  theme: { light: "Light", dark: "Dark", system: "Match system" },
  density: { comfortable: "Comfortable", compact: "Compact" },
  "notification-level": { all: "Push all", mentions: "Push mentions", none: "No push" },
  "send-key": { enter: "Send message", cmdEnter: "Start a new line" },
  "send-side": { right: "Send on the right", left: "Send on the left" },
  "time-format": { "24h": "24-hour", "12h": "12-hour" },
  "font-size": { small: "Small text", medium: "Medium text", large: "Large text" },
  "font-family": { system: "Default font", monospace: "Monospace", dyslexic: "OpenDyslexic" },
  "unread-landing": { latest: "Opens at the latest", marker: "Opens at your first unread" },
  settling: {
    interaction: "Leaves Inbox when you reply or react",
    manual: "Leaves Inbox only when you settle it",
    read: "Leaves Inbox as soon as you read it",
  },
  "label-move": { ask: "Asks each time", always: "Removes the old label", never: "Keeps the old label" },
  "board-head-badge": { count: "Unread count", off: "No badge" },
  "code-wrap": { scroll: "Long lines scroll", wrap: "Long lines wrap" },
  "dictation-polish": { none: "No cleanup", minor: "Light cleanup", opinionated: "Full cleanup" },
  "call-mirror": { auto: "Mirror automatically", on: "Always mirrored", off: "Never mirrored" },
  "call-layout": { speaker: "Speaker", grid: "Grid" },
  "call-desktop-video": {
    keep_last: "Where you left it",
    floating: "Floating square",
    sidebar: "Sidebar",
    fullscreen: "Fullscreen",
  },
  "stream-replies": { on: "On", off: "Quiet" },
  /** What device sharing gives agents (`UserDeviceContextRepository`); location is never shared. */
  "device-sharing": { on: "Layout, system and open docs", off: "Not shared" },
  "stream-notifications": {
    default: "Default",
    everything: "Everything",
    activity: "Activity",
    mentions: "Mentions only",
    muted: "Muted",
  },
} as const

/** What the other chord does, beside each Enter key choice. */
export const SEND_KEY_CHOICE_DESCRIPTIONS: Record<MessageSendMode, string> = {
  enter: "Shift+Enter starts a new line.",
  cmdEnter: `${isMac() ? "⌘" : "Ctrl"}+Enter sends.`,
}

// --- This stream ---------------------------------------------------------

export const STREAM_SETTINGS_PAGE_CONFIG: Record<StreamSettingsTab, { label: string; icon: LucideIcon }> = {
  general: { label: "General", icon: SlidersHorizontal },
  companion: { label: "Agent", icon: Sparkles },
  members: { label: "Stream members", icon: Users },
  connect: { label: "Sharing", icon: Share2 },
}

interface StreamSettingsSectionConfig {
  tab: StreamSettingsTab
  title: string
}

export const STREAM_SETTINGS_SECTIONS = {
  "stream-notify": { tab: "general", title: "Your notifications" },
  "stream-details": { tab: "general", title: "Details" },
  "stream-memory": { tab: "general", title: "Memory" },
  "stream-archive": { tab: "general", title: "Archiving" },
  "stream-agent": { tab: "companion", title: "Replies" },
  "stream-agent-sees": { tab: "companion", title: "What shapes replies" },
  "stream-context": { tab: "companion", title: "Context" },
  "stream-tools": { tab: "companion", title: "Tools" },
  "stream-people": { tab: "members", title: "People" },
  "stream-sharing": { tab: "connect", title: "Sharing" },
} as const satisfies Record<string, StreamSettingsSectionConfig>

export type StreamSettingsSectionId = keyof typeof STREAM_SETTINGS_SECTIONS

type StreamNotifyChoice = keyof (typeof SETTING_CHOICE_LABELS)["stream-notifications"]

export function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

/** The stream level that follows its type's default: "Channel default". */
export function streamNotifyDefaultChoice(type: StreamType): { label: string } {
  return { label: `${upperFirst(streamFallbackLabel(type, "noun"))} default` }
}

/**
 * How a stream's level reads as a value; the default one also names the level
 * it inherits ("Thread default · Muted" under a muted channel), so it reads
 * apart from picking that level itself.
 */
export function streamNotifyLabel(
  choice: StreamNotifyChoice,
  type: StreamType,
  inheritedLevel: NotificationLevel
): string {
  const labels = SETTING_CHOICE_LABELS["stream-notifications"]
  if (choice !== "default") return labels[choice]
  return `${streamNotifyDefaultChoice(type).label} · ${lowerFirst(labels[inheritedLevel])}`
}

/** A section of either window, for `SettingsSection`. */
export function sectionTitle(id: SettingsSectionId | StreamSettingsSectionId): string {
  return Object.hasOwn(SETTINGS_SECTIONS, id)
    ? SETTINGS_SECTIONS[id as SettingsSectionId].title
    : STREAM_SETTINGS_SECTIONS[id as StreamSettingsSectionId].title
}

export interface StreamSettingDef {
  section: StreamSettingsSectionId
  label: string
  description?: string
  keywords?: string[]
  /** Stream types that have this setting; every type when unset. */
  types?: readonly StreamType[]
}

const CONVERSATION_TYPES = [StreamTypes.CHANNEL, StreamTypes.SCRATCHPAD, StreamTypes.DM] as const

/**
 * Settings of one stream, shown in its own settings window. The settings
 * window's search offers them only while a stream is in view.
 */
export const STREAM_SETTINGS = {
  "stream-notifications": {
    section: "stream-notify",
    label: "Notify me about",
    description: "Which messages here notify you.",
    keywords: [
      "notifications for this stream",
      "mute",
      "mute channel",
      "unmute",
      "channel notifications",
      "notify",
      "too many notifications",
      "why am I notified",
      "push for every message",
      "why do I get pushes",
    ],
    types: [
      StreamTypes.CHANNEL,
      StreamTypes.SCRATCHPAD,
      StreamTypes.DM,
      StreamTypes.THREAD,
      StreamTypes.SYSTEM,
      StreamTypes.ASIDE,
    ],
  },
  "stream-name": {
    section: "stream-details",
    label: "Stream name",
    keywords: ["rename", "rename channel", "slug", "title"],
    types: [StreamTypes.CHANNEL, StreamTypes.SCRATCHPAD, StreamTypes.THREAD, StreamTypes.DM],
  },
  "stream-description": {
    section: "stream-details",
    label: "Description",
    keywords: ["topic", "purpose", "about"],
    types: CONVERSATION_TYPES,
  },
  "stream-visibility": {
    section: "stream-details",
    label: "Visibility",
    description: "Who can find and read it.",
    keywords: ["public", "private", "who can see", "access", "guests"],
    types: [
      StreamTypes.CHANNEL,
      StreamTypes.DOC,
      StreamTypes.SCRATCHPAD,
      StreamTypes.DM,
      StreamTypes.THREAD,
      StreamTypes.SYSTEM,
    ],
  },
  "stream-memory": {
    section: "stream-memory",
    label: "Automatic memory",
    description: "Save knowledge from this stream's conversations. Turn it off where memories would be noise.",
    keywords: ["memory", "memos", "knowledge", "extract", "remember"],
    types: CONVERSATION_TYPES,
  },
  "stream-archive": {
    section: "stream-archive",
    label: "Archive",
    description: "Hide it from the sidebar. You can unarchive it later.",
    keywords: ["unarchive", "hide", "close channel", "delete"],
    types: [StreamTypes.CHANNEL, StreamTypes.SCRATCHPAD, StreamTypes.THREAD],
  },
  "stream-replies": {
    section: "stream-agent",
    label: "Agent replies",
    keywords: ["companion mode", "quiet", "stop ai", "ai replies", "mute agent", "assistant"],
  },
  "stream-agent": {
    section: "stream-agent",
    label: "Agent",
    keywords: ["companion", "persona", "ariadne", "assistant", "which agent", "who answers"],
  },
  "stream-agent-context": {
    section: "stream-agent-sees",
    label: "Agent context",
    description: "The agent, its model, instructions, brief and tools that shape replies here.",
    keywords: [
      "which model",
      "why does the agent answer",
      "agent instructions",
      "agent context",
      "what the agent knows",
    ],
  },
  "stream-brief": {
    section: "stream-context",
    label: "Brief",
    description: "Standing context the agent reads on every turn: goals, decisions and preferences.",
    keywords: ["instructions", "context", "prompt"],
  },
  "stream-tools": {
    section: "stream-tools",
    label: "Restrict tool access",
    description: "Limit the agent to the tool groups you pick. It can always reply.",
    keywords: ["agent tools", "web", "sandbox", "internet", "tools"],
    types: [StreamTypes.SCRATCHPAD],
  },
  "stream-members": {
    section: "stream-people",
    label: "Members",
    keywords: ["add people", "invite", "remove member", "who's here"],
  },
  "stream-bots": {
    section: "stream-people",
    label: "Bots",
    description: "Bots added here can post in this stream.",
    keywords: ["bot access", "automation", "add bot"],
  },
  "stream-connect": {
    section: "stream-sharing",
    label: "Share with another workspace",
    keywords: ["connect", "shared channel", "external", "slack connect"],
  },
} as const satisfies Record<string, StreamSettingDef>

export type StreamSettingId = keyof typeof STREAM_SETTINGS
export type AnySettingId = SettingId | StreamSettingId

/** A stream page's sections that hold a setting this stream type has. */
export function streamSectionsOfTab(tab: StreamSettingsTab, type: StreamType): StreamSettingsSectionId[] {
  const defs: StreamSettingDef[] = Object.values(STREAM_SETTINGS)
  return (Object.keys(STREAM_SETTINGS_SECTIONS) as StreamSettingsSectionId[]).filter(
    (section) =>
      STREAM_SETTINGS_SECTIONS[section].tab === tab &&
      defs.some((def) => def.section === section && (!def.types || def.types.includes(type)))
  )
}

const AGENT_TAB_TYPES: readonly string[] = [
  StreamTypes.CHANNEL,
  StreamTypes.SCRATCHPAD,
  StreamTypes.DM,
  StreamTypes.THREAD,
]

/** The stream settings tabs a stream has. */
export function streamSettingsTabs(
  stream: { type: StreamType; parentStreamId: string | null },
  canConnect: boolean
): StreamSettingsTab[] {
  const tabs: StreamSettingsTab[] = ["general"]
  if (AGENT_TAB_TYPES.includes(stream.type)) tabs.push("companion")
  if (streamHasMembers(stream)) tabs.push("members")
  if (stream.type === StreamTypes.CHANNEL && canConnect) tabs.push("connect")
  return tabs
}

/** Whether a stream has the page, and on it the setting, a link names. */
export function streamOffersSetting(
  stream: { type: StreamType; parentStreamId: string | null },
  tab: StreamSettingsTab,
  setting: string | null,
  canConnect: boolean
): boolean {
  if (!streamSettingsTabs(stream, canConnect).includes(tab)) return false
  const def: StreamSettingDef | undefined =
    setting && Object.hasOwn(STREAM_SETTINGS, setting) ? STREAM_SETTINGS[setting as StreamSettingId] : undefined
  return !def?.types || def.types.includes(stream.type)
}

// --- Search --------------------------------------------------------------

export interface SettingsVisibility {
  tabs: readonly SettingsTab[]
  /** Settings not shown to this viewer, such as rollout-gated ones. */
  hidden: ReadonlySet<string>
}

export interface SettingsSearchContext {
  /** The viewer's rebound shortcuts, so a chord finds what it is bound to now as well as by default. */
  shortcutBindings?: Readonly<Record<string, string>>
  /** The stream the window was opened from; its settings join the results, named by `name`. */
  stream?: { type: StreamType; tabs: readonly StreamSettingsTab[]; name?: string }
  /**
   * Without `stream`, the stream pages the viewer's streams can have: their
   * settings join the results, each asking which stream when opened.
   */
  anyStreamTabs?: readonly StreamSettingsTab[]
}

export type SettingSearchTarget =
  | { kind: "settings"; tab: SettingsTab; anchor: string }
  | { kind: "stream"; tab: StreamSettingsTab; anchor: string }

export interface SettingSearchResult {
  /** Unique across scopes: a setting id, a shortcut anchor or a stream setting id. */
  id: string
  target: SettingSearchTarget
  scope: SettingsGroup | "stream"
  label: string
  description?: string
  /** Where it lives below its scope: page then section. */
  path: readonly string[]
  device?: boolean
  appliesOn?: SettingAppliesOn
  /** A stream setting found with no stream in view: opening it asks which stream. */
  needsStream?: true
  /** The stream a stream setting belongs to, as its trail names it: "#design". */
  streamName?: string
  /** Not a match itself: a sibling in the best match's section, shown apart. */
  related?: true
  /** Not a match itself: the shortcut now bound to a key chord the query names, shown apart. */
  keysInUse?: true
}

export const SEARCH_SCOPE_LABELS: Record<SettingSearchResult["scope"], string> = {
  ...SETTINGS_GROUP_LABELS,
  stream: "This stream",
}

/** Where a result lives, as one line: "You › Reading › Link previews", "#design › General › Your notifications". */
export function settingResultTrail(result: SettingSearchResult): string {
  const scope = result.needsStream ? "Any stream" : (result.streamName ?? SEARCH_SCOPE_LABELS[result.scope])
  return [scope, ...result.path].join(" › ")
}

type Field = "label" | "keywords" | "place" | "description"

/** Keywords are the label's synonyms, so a hit in either names the setting equally. */
const FIELD_WEIGHT: Record<Field, number> = { label: 3, keywords: 3, place: 1.5, description: 1 }
const FIELDS = Object.keys(FIELD_WEIGHT) as Field[]

interface Chord {
  mod: boolean
  shift: boolean
  alt: boolean
  key: string
}

interface SearchEntry {
  result: SettingSearchResult
  /** The section it sits in; a best match's section siblings follow it in the results. */
  section: string
  /** Where it renders: pages in nav order, then sections, then rows. Equal matches keep this order. */
  order: number
  labelText: string
  keywordTexts: string[]
  words: Record<Field, string[]>
  /** The label and each keyword as words: a query holding all of one names the entry outright. */
  phrases: string[][]
  /** Shortcut entries: the action whose bindings a chord matches. */
  actionId?: string
  defaultChords?: Chord[]
  types?: readonly StreamType[]
}

function normalize(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "")
}

/** Letters and digits of any script; punctuation and spacing separate words. */
function words(text: string): string[] {
  return normalize(text).match(/[\p{L}\p{N}]+/gu) ?? []
}

function uniqueWords(texts: readonly string[]): string[] {
  return [...new Set(texts.flatMap(words))]
}

function bindingChord(binding: string): Chord {
  const parsed = parseKeyBinding(binding)
  return { mod: parsed.mod || parsed.ctrl, shift: parsed.shift, alt: parsed.alt, key: parsed.key }
}

/** Control and Command are one modifier here, as in `shortcutChord`. */
const MODIFIER_ALIASES: Record<string, keyof Omit<Chord, "key">> = {
  cmd: "mod",
  command: "mod",
  meta: "mod",
  mod: "mod",
  ctrl: "mod",
  control: "mod",
  "⌘": "mod",
  "⌃": "mod",
  shift: "shift",
  "⇧": "shift",
  alt: "alt",
  opt: "alt",
  option: "alt",
  "⌥": "alt",
}

/** "cmd+b", "ctrl+shift+f", "⌘b" or "⌥⇧t" as a chord; null for anything else. */
function parseChord(piece: string): Chord | null {
  const parts = piece
    .replace(/[⌘⌃⌥⇧]/g, (symbol) => `${symbol}+`)
    .split("+")
    .filter(Boolean)
  if (parts.length < 2) return null
  const key = parts[parts.length - 1]
  if (Object.hasOwn(MODIFIER_ALIASES, key)) return null
  const chord: Chord = { mod: false, shift: false, alt: false, key }
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(MODIFIER_ALIASES, part)) return null
    chord[MODIFIER_ALIASES[part]] = true
  }
  return chord
}

function sameChord(a: Chord, b: Chord): boolean {
  return a.key === b.key && a.mod === b.mod && a.shift === b.shift && a.alt === b.alt
}

const PAGE_ORDER: readonly string[] = [
  ...Object.keys(SETTINGS_PAGE_CONFIG),
  ...Object.keys(STREAM_SETTINGS_PAGE_CONFIG).map((tab) => `stream:${tab}`),
]
const SECTION_ORDER: readonly string[] = [...Object.keys(SETTINGS_SECTIONS), ...Object.keys(STREAM_SETTINGS_SECTIONS)]

function renderOrder(target: SettingSearchTarget, section: string, row: number): number {
  const page = PAGE_ORDER.indexOf(target.kind === "stream" ? `stream:${target.tab}` : target.tab)
  return (page * 1000 + SECTION_ORDER.indexOf(section)) * 1000 + row
}

function searchEntry(
  result: SettingSearchResult,
  section: string,
  row: number,
  keywords: readonly string[],
  place: readonly string[],
  extra?: Pick<SearchEntry, "actionId" | "defaultChords" | "types">
): SearchEntry {
  return {
    result,
    section,
    order: renderOrder(result.target, section, row),
    labelText: normalize(result.label),
    keywordTexts: keywords.map(normalize),
    phrases: [result.label, ...keywords].map(words),
    words: {
      label: uniqueWords([result.label]),
      keywords: uniqueWords(keywords),
      place: uniqueWords(place),
      description: uniqueWords(result.description ? [result.description] : []),
    },
    ...extra,
  }
}

const SETTING_ENTRIES: SearchEntry[] = (Object.keys(SETTINGS) as SettingId[]).map((id, row) => {
  const def: SettingDef = SETTINGS[id]
  const section = SETTINGS_SECTIONS[def.section]
  const page = SETTINGS_PAGE_CONFIG[section.tab]
  return searchEntry(
    {
      id,
      target: { kind: "settings", tab: section.tab, anchor: id },
      scope: page.group,
      label: def.label,
      description: def.description,
      path: [page.label, section.title],
      device: def.device,
      appliesOn: def.appliesOn,
    },
    def.section,
    row,
    def.keywords ?? [],
    [page.label, section.title, SETTINGS_GROUP_LABELS[page.group], ...page.keywords]
  )
})

const SHORTCUT_ENTRIES: SearchEntry[] = SHORTCUT_ACTIONS.map((action, row) => {
  const page = SETTINGS_PAGE_CONFIG.keyboard
  const anchor = `${SHORTCUT_ANCHOR_PREFIX}${action.id}`
  const defaults = [action.defaultKey, action.installedKey].filter((binding): binding is string => !!binding)
  return searchEntry(
    {
      id: anchor,
      target: { kind: "settings", tab: "keyboard", anchor },
      scope: "you",
      label: `${action.label} shortcut`,
      description: action.description,
      path: [page.label, SETTINGS_SECTIONS.shortcuts.title],
    },
    "shortcuts",
    row,
    [],
    // Every shortcut shares these, so they say where it is, not which one it is.
    [page.label, SETTINGS_SECTIONS.shortcuts.title, "keyboard shortcut", "hotkey", "keybinding", "rebind", "change"],
    { actionId: action.id, defaultChords: defaults.map(bindingChord) }
  )
})

const STREAM_ENTRIES: SearchEntry[] = (Object.keys(STREAM_SETTINGS) as StreamSettingId[]).map((id, row) => {
  const def: StreamSettingDef = STREAM_SETTINGS[id]
  const section = STREAM_SETTINGS_SECTIONS[def.section]
  const tabLabel = STREAM_SETTINGS_PAGE_CONFIG[section.tab].label
  return searchEntry(
    {
      id,
      target: { kind: "stream", tab: section.tab, anchor: id },
      scope: "stream",
      label: def.label,
      description: def.description,
      path: [tabLabel, section.title],
    },
    def.section,
    row,
    def.keywords ?? [],
    ["this stream", "stream", "channel", tabLabel, section.title],
    { types: def.types }
  )
})

const ANY_STREAM_ENTRIES: SearchEntry[] = STREAM_ENTRIES.map((entry) => ({
  ...entry,
  result: { ...entry.result, needsStream: true },
}))

/**
 * How directly the whole query names the entry, above any word count: the
 * exact label first, then a label it starts, an exact keyword, and so on.
 */
function phraseTier(entry: SearchEntry, phrase: string): number {
  if (entry.labelText === phrase) return 6
  if (entry.labelText.startsWith(phrase)) return 5
  if (entry.keywordTexts.includes(phrase)) return 4
  if (entry.labelText.includes(phrase)) return 3
  if (entry.keywordTexts.some((keyword) => keyword.startsWith(phrase))) return 2
  if (entry.keywordTexts.some((keyword) => keyword.includes(phrase))) return 1
  return 0
}

interface ParsedQuery {
  phrase: string
  words: string[]
  /** Words that must mostly match; the rest only add weight (see `parseQuery`). */
  meaningful: ReadonlySet<string>
  chords: Chord[]
}

/**
 * Splits a query into words and key chords. Words of three or more characters
 * carry the match; shorter ones ("my", "to", "a") occur in most sentences of
 * most languages and only add weight, unless the query has nothing longer.
 */
function parseQuery(query: string): ParsedQuery | null {
  const phrase = normalize(query.trim()).replace(/\s+/g, " ")
  if (!phrase) return null
  const queryWords: string[] = []
  const chords: Chord[] = []
  for (const piece of phrase.split(" ")) {
    const chord = parseChord(piece)
    if (chord) chords.push(chord)
    else queryWords.push(...words(piece))
  }
  const long = queryWords.filter((word) => word.length >= 3)
  return { phrase, words: queryWords, meaningful: new Set(long.length > 0 ? long : queryWords), chords }
}

interface EntryScore {
  /** Meaningful words and chords that hit. */
  matched: number
  /** Of those, the ones that hit the entry's own label, keywords or chord rather than its page or description. */
  direct: number
  score: number
}

function scoreEntry(entry: SearchEntry, query: ParsedQuery, context: SettingsSearchContext): EntryScore | null {
  let matched = 0
  let direct = 0
  let weight = 0
  let strong = false
  for (const word of query.words) {
    let best = 0
    let own = false
    for (const field of FIELDS) {
      const quality = wordMatchQuality(word, entry.words[field])
      if (quality === 0) continue
      if (field !== "description" && quality >= WORD_MATCH.typo) strong = true
      if (field === "label" || field === "keywords") own = true
      best = Math.max(best, quality * FIELD_WEIGHT[field])
    }
    if (best === 0) continue
    const meaningful = query.meaningful.has(word)
    if (meaningful) matched++
    if (meaningful && own) direct++
    weight += meaningful ? best : best / 4
  }
  if (entry.defaultChords && query.chords.length > 0) {
    const custom = entry.actionId ? context.shortcutBindings?.[entry.actionId] : undefined
    const bound = custom && custom !== "none" ? [...entry.defaultChords, bindingChord(custom)] : entry.defaultChords
    for (const chord of query.chords) {
      if (!bound.some((candidate) => sameChord(candidate, chord))) continue
      matched++
      direct++
      weight += FIELD_WEIGHT.label
      strong = true
    }
  }
  if (!strong || matched * 2 < requiredHits(query)) return null
  return { matched, direct, score: phraseTier(entry, query.phrase) * 10_000 + matched * 100 + direct * 10 + weight }
}

function requiredHits(query: ParsedQuery): number {
  return query.meaningful.size + query.chords.length
}

/**
 * The meaningful query words that name the entry outright: every word of its
 * label, or of one of its keywords, is in the query ("display name", "avatar").
 */
function namedWords(entry: SearchEntry, query: ParsedQuery): string[] {
  const named = new Set<string>()
  for (const phrase of entry.phrases) {
    const hits = phrase.map((word) =>
      query.words.find((queryWord) => queryWord === word || withinTypoBudget(queryWord, word))
    )
    if (phrase.length === 0 || hits.some((hit) => hit === undefined)) continue
    for (const hit of hits) if (hit && query.meaningful.has(hit)) named.add(hit)
  }
  return [...named]
}

/**
 * The parts of a query that asks for several settings at once ("change my
 * avatar and display name"): entries it names outright, most words first, when
 * together they name at least half its meaningful words. No single part holds
 * half the words, so the per-entry rule alone finds nothing; the shared
 * threshold still turns away a sentence that only brushes one keyword.
 */
function namedParts(candidates: readonly SearchEntry[], query: ParsedQuery): SearchEntry[] {
  if (query.chords.length > 0) return []
  const named = candidates.flatMap((entry) => {
    const words = namedWords(entry, query)
    return words.length > 0 ? [{ entry, words }] : []
  })
  const covered = new Set(named.flatMap(({ words }) => words))
  if (covered.size * 2 < query.meaningful.size) return []
  return named.sort((a, b) => b.words.length - a.words.length).map(({ entry }) => entry)
}

/** The shortcuts bound now to a chord the query names, in the order it names them. */
function chordOwners(
  candidates: readonly SearchEntry[],
  query: ParsedQuery,
  context: SettingsSearchContext
): SearchEntry[] {
  return query.chords.flatMap((chord) =>
    candidates.filter((entry) => {
      if (!entry.actionId) return false
      const binding = getEffectiveKeyBinding(entry.actionId, context.shortcutBindings)
      return (
        !!binding && occupiedBindings(entry.actionId, binding).some((bound) => sameChord(bindingChord(bound), chord))
      )
    })
  )
}

/**
 * Settings matching a free-text query, best first. Language-neutral: word
 * lengths, never stop words. A hit only in a description can't qualify an
 * entry, and the strongest tier present (every word; every word in the
 * entry's own label or keywords; else the most words named) drops weaker
 * ones, so a symptom sentence answers with its setting rather than with others
 * sharing its filler words. `related` marks a one-word query's section
 * siblings and, once one setting matches every word, the parts of a query
 * naming several; `keysInUse` marks what a searched chord is bound to now.
 */
export function searchSettings(
  query: string,
  visibility: SettingsVisibility,
  context: SettingsSearchContext = {}
): SettingSearchResult[] {
  const parsed = parseQuery(query)
  if (!parsed) return []
  const { stream, anyStreamTabs } = context
  const candidates = [
    ...SETTING_ENTRIES.filter(
      ({ result }) =>
        result.target.kind === "settings" &&
        visibility.tabs.includes(result.target.tab) &&
        !visibility.hidden.has(result.id)
    ),
    ...(visibility.tabs.includes("keyboard") ? SHORTCUT_ENTRIES : []),
    ...(stream
      ? STREAM_ENTRIES.filter(
          ({ result, types }) =>
            result.target.kind === "stream" &&
            stream.tabs.includes(result.target.tab) &&
            (!types || types.includes(stream.type))
        )
      : ANY_STREAM_ENTRIES.filter(
          ({ result }) => result.target.kind === "stream" && !!anyStreamTabs?.includes(result.target.tab)
        )),
  ]
  const scored = candidates
    .flatMap((candidate) => {
      const score = scoreEntry(candidate, parsed, context)
      return score ? [{ entry: candidate, ...score }] : []
    })
    .sort((a, b) => b.score - a.score || a.entry.order - b.entry.order)
  const required = requiredHits(parsed)
  const complete = scored.some(({ matched }) => matched === required)
  const named = scored.some(({ direct }) => direct === required)
  const topDirect = Math.max(0, ...scored.map(({ direct }) => direct))
  const best = scored
    .filter(({ matched, direct }) => {
      if (named) return direct === required
      if (complete) return matched === required
      return direct === topDirect
    })
    .map(({ entry }) => entry)
  const shown = new Set<SearchEntry>(best)
  const take = (entries: readonly SearchEntry[]) =>
    entries.filter((entry) => {
      if (shown.has(entry)) return false
      shown.add(entry)
      return true
    })
  const parts = take(namedParts(candidates, parsed))
  const owners = take(chordOwners(candidates, parsed, context))
  const section = best[0]?.section
  const siblings =
    required === 1 ? take(scored.filter(({ entry }) => entry.section === section).map(({ entry }) => entry)) : []
  const withStream = (result: SettingSearchResult): SettingSearchResult =>
    result.target.kind === "stream" && stream?.name ? { ...result, streamName: stream.name } : result
  const direct = complete ? best : [...best, ...parts]
  const related = complete ? [...parts, ...siblings] : siblings
  return [
    ...direct.map(({ result }) => withStream(result)),
    ...owners.map(({ result }): SettingSearchResult => ({ ...result, keysInUse: true })),
    ...related.map(({ result }): SettingSearchResult => ({ ...withStream(result), related: true })),
  ]
}
