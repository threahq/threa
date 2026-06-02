// =============================================================================
// Workspace Settings
// Workspace-scoped configuration owned by admins. Currently the default working
// schedule that every member inherits unless they set a personal override.
// Stored sparsely (only non-default keys persisted) like user preferences.
// =============================================================================

import { type WorkSchedule, DEFAULT_WORK_SCHEDULE } from "./work-schedule"

/** Full workspace settings (wire format). */
export interface WorkspaceSettings {
  workspaceId: string
  /**
   * The workspace-wide default working week + hours. Members inherit this when
   * they have no personal `workSchedule` override. Falls back to Mon–Fri 09:00.
   */
  defaultWorkSchedule: WorkSchedule
  createdAt: string
  updatedAt: string
}

/** Defaults applied when a workspace has stored no overrides. */
export const DEFAULT_WORKSPACE_SETTINGS: Omit<WorkspaceSettings, "workspaceId" | "createdAt" | "updatedAt"> = {
  defaultWorkSchedule: DEFAULT_WORK_SCHEDULE,
}

/** Partial update — only provided fields are changed. */
export interface UpdateWorkspaceSettingsInput {
  defaultWorkSchedule?: WorkSchedule
}

/** Valid top-level settings keys that can be overridden. */
export type WorkspaceSettingKey = keyof Omit<WorkspaceSettings, "workspaceId" | "createdAt" | "updatedAt">
