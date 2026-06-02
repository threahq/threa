import { Pool } from "pg"
import { withTransaction } from "../../db"
import { WorkspaceSettingsRepository } from "./repository"
import { type WorkspaceSettings, type UpdateWorkspaceSettingsInput, DEFAULT_WORKSPACE_SETTINGS } from "@threa/types"

/** Merge sparse overrides onto code defaults to produce full settings. */
function mergeOverrides(workspaceId: string, overrides: Array<{ key: string; value: unknown }>): WorkspaceSettings {
  const result: WorkspaceSettings = {
    workspaceId,
    ...structuredClone(DEFAULT_WORKSPACE_SETTINGS),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  for (const { key, value } of overrides) {
    ;(result as unknown as Record<string, unknown>)[key] = value
  }
  return result
}

function getDefaultValue(key: string): unknown {
  return (DEFAULT_WORKSPACE_SETTINGS as Record<string, unknown>)[key]
}

function matchesDefault(key: string, value: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(getDefaultValue(key))
}

function flattenUpdates(updates: UpdateWorkspaceSettingsInput): Array<{ key: string; value: unknown }> {
  const pairs: Array<{ key: string; value: unknown }> = []
  const simpleKeys = ["defaultWorkSchedule"] as const
  for (const key of simpleKeys) {
    if (updates[key] !== undefined) {
      pairs.push({ key, value: updates[key] })
    }
  }
  return pairs
}

export class WorkspaceSettingsService {
  constructor(private pool: Pool) {}

  /** Get workspace settings, merging overrides with defaults. */
  async getSettings(workspaceId: string): Promise<WorkspaceSettings> {
    // Single query, INV-30
    const overrides = await WorkspaceSettingsRepository.findOverrides(this.pool, workspaceId)
    return mergeOverrides(workspaceId, overrides)
  }

  /**
   * Update workspace settings. Only values differing from defaults are stored;
   * setting a value back to the default clears the override.
   */
  async updateSettings(workspaceId: string, updates: UpdateWorkspaceSettingsInput): Promise<WorkspaceSettings> {
    return withTransaction(this.pool, async (client) => {
      for (const { key, value } of flattenUpdates(updates)) {
        if (matchesDefault(key, value)) {
          await WorkspaceSettingsRepository.deleteOverride(client, workspaceId, key)
        } else {
          await WorkspaceSettingsRepository.setOverride(client, workspaceId, key, value)
        }
      }

      const overrides = await WorkspaceSettingsRepository.findOverrides(client, workspaceId)
      return mergeOverrides(workspaceId, overrides)
    })
  }
}
