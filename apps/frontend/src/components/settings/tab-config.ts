import type { SettingsTab } from "@threa/types"

export interface SettingsTabConfig {
  label: string
  description: string
  /** Extra match terms for the palette's per-tab settings commands. */
  keywords: string[]
}

/**
 * Single source of truth for the user-settings tabs: the settings dialog nav
 * renders from it and the command palette generates one "Settings: X" command
 * per tab from it, so the two surfaces never drift (INV-33).
 */
export const SETTINGS_TAB_CONFIG: Record<SettingsTab, SettingsTabConfig> = {
  profile: {
    label: "Profile",
    description: "Identity and account details",
    keywords: ["avatar", "photo", "name", "pronouns", "email", "phone", "github"],
  },
  ai: {
    label: "AI",
    description: "Scratchpad guidance and behavior",
    keywords: ["scratchpad", "prompt", "guidance", "companion", "ariadne", "instructions"],
  },
  dictation: {
    label: "Dictation",
    description: "Voice model, polish, and steering words",
    keywords: ["voice", "dictation", "transcription", "polish", "steering", "speech", "mic"],
  },
  calls: {
    label: "Calls",
    description: "Self-view mirror and default layout",
    keywords: ["call", "video", "camera", "mirror", "self-view", "layout", "speaker", "grid"],
  },
  appearance: {
    label: "Appearance",
    description: "Theme and message density",
    keywords: ["theme", "dark", "light", "density", "compact", "code", "wrap"],
  },
  datetime: {
    label: "Date & Time",
    description: "Timezone and formatting",
    keywords: ["timezone", "clock", "date format", "24h", "12h"],
  },
  schedule: {
    label: "Working hours",
    description: "Working week and shifts",
    keywords: ["schedule", "workday", "availability", "work week"],
  },
  notifications: {
    label: "Notifications",
    description: "Alerts and push behavior",
    keywords: ["push", "alerts", "mute", "mentions", "enable notifications"],
  },
  keyboard: {
    label: "Composer",
    description: "Sending, attachments, and shortcuts",
    keywords: ["keyboard", "shortcuts", "hotkeys", "bindings", "enter", "send", "attachments", "files", "mobile"],
  },
  diagnostics: {
    label: "Diagnostics",
    description: "Performance data sharing",
    keywords: ["performance", "diagnostics", "telemetry", "slow", "lag", "freeze", "timing"],
  },
  accessibility: {
    label: "Accessibility",
    description: "Motion, contrast, fonts, and composer layout",
    keywords: ["font", "contrast", "motion", "a11y", "dyslexic", "left-handed", "handedness", "reach", "send"],
  },
}
