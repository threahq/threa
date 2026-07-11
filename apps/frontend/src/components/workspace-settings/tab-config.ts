/** URL query param that drives the workspace settings dialog. */
export const WS_SETTINGS_PARAM = "ws-settings"

export const WORKSPACE_SETTINGS_TABS = [
  "general",
  "schedule",
  "statuses",
  "dictation",
  "users",
  "personas",
  "integrations",
  "bots",
  "api-keys",
  "feature-flags",
] as const
export type WorkspaceSettingsTab = (typeof WORKSPACE_SETTINGS_TABS)[number]

export const WORKSPACE_SETTINGS_TAB_CONFIG: Record<WorkspaceSettingsTab, { label: string; description: string }> = {
  general: { label: "General", description: "Workspace identity and region" },
  schedule: { label: "Working hours", description: "Default working week and shifts" },
  statuses: { label: "Statuses", description: "Default status presets for members" },
  dictation: { label: "Dictation", description: "Shared voice steering words" },
  users: { label: "Users", description: "Members and pending invites" },
  personas: { label: "Personas", description: "Edit the built-in AI companions" },
  integrations: { label: "Integrations", description: "Shared third-party connections" },
  bots: { label: "Bots", description: "Workspace automation accounts" },
  "api-keys": { label: "API Keys", description: "Create and revoke access keys" },
  "feature-flags": { label: "Feature flags", description: "Rollout flags set on your account" },
}
