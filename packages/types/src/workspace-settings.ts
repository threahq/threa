// =============================================================================
// Workspace Settings
// Workspace-scoped configuration owned by admins. Currently the default working
// schedule that every member inherits unless they set a personal override.
// Stored sparsely (only non-default keys persisted) like user preferences.
// =============================================================================

import { type WorkSchedule, DEFAULT_WORK_SCHEDULE } from "./work-schedule"
import { type StatusPreset, SYSTEM_DEFAULT_STATUSES } from "./user-status"

/** Full workspace settings (wire format). */
export interface WorkspaceSettings {
  workspaceId: string
  /**
   * The workspace-wide default working week + hours. Members inherit this when
   * they have no personal `workSchedule` override. Falls back to Mon–Fri 09:00.
   */
  defaultWorkSchedule: WorkSchedule
  /**
   * The status presets offered to members in the status picker. Defaults to the
   * system presets; admins replace the whole list. Per-user custom presets are
   * additive on top of this (UserPreferences.statusPresets).
   */
  userStatusPresets: StatusPreset[]
  createdAt: string
  updatedAt: string
}

/** Defaults applied when a workspace has stored no overrides. */
export const DEFAULT_WORKSPACE_SETTINGS: Omit<WorkspaceSettings, "workspaceId" | "createdAt" | "updatedAt"> = {
  defaultWorkSchedule: DEFAULT_WORK_SCHEDULE,
  userStatusPresets: SYSTEM_DEFAULT_STATUSES,
}

/** Partial update — only provided fields are changed. */
export interface UpdateWorkspaceSettingsInput {
  defaultWorkSchedule?: WorkSchedule
  userStatusPresets?: StatusPreset[]
}

/** Valid top-level settings keys that can be overridden. */
export type WorkspaceSettingKey = keyof Omit<WorkspaceSettings, "workspaceId" | "createdAt" | "updatedAt">
