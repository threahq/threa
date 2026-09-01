import { Pool } from "pg"
import { withTransaction } from "../../db"
import { WorkspaceSettingsRepository } from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import { assertAssignablePersona } from "../agents"
import { type WorkspaceSettings, type UpdateWorkspaceSettingsInput, DEFAULT_WORKSPACE_SETTINGS } from "@threa/types"
import type { ModelRegistry } from "@threa/agent-runtime"
import { HttpError } from "../../lib/errors"

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
  const simpleKeys = [
    "defaultWorkSchedule",
    "userStatusPresets",
    "memoLanguage",
    "voiceSteeringWords",
    "maxPendingFollowUps",
    "defaultCompanionPersonaId",
    "billingTimezone",
    "subagentModels",
  ] as const
  for (const key of simpleKeys) {
    if (updates[key] !== undefined) {
      pairs.push({ key, value: updates[key] })
    }
  }
  return pairs
}

export class WorkspaceSettingsService {
  constructor(
    private pool: Pool,
    private modelRegistry: ModelRegistry
  ) {}

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
    await assertAssignablePersona(this.pool, updates.defaultCompanionPersonaId, workspaceId)
    this.assertDelegableModels(updates.subagentModels)
    return withTransaction(this.pool, async (client) => {
      for (const { key, value } of flattenUpdates(updates)) {
        if (matchesDefault(key, value)) {
          await WorkspaceSettingsRepository.deleteOverride(client, workspaceId, key)
        } else {
          await WorkspaceSettingsRepository.setOverride(client, workspaceId, key, value)
        }
      }

      const overrides = await WorkspaceSettingsRepository.findOverrides(client, workspaceId)
      const settings = mergeOverrides(workspaceId, overrides)

      // Broadcast to the workspace room so every member's bootstrap cache (and
      // thus schedule-aware presets) picks up the new default without waiting
      // for a reconnect. Written in the same transaction as the override (INV-7).
      await OutboxRepository.insert(client, "workspace_settings:updated", { workspaceId, settings })

      return settings
    })
  }

  /**
   * The delegable set is checked against the model registry on write as well as
   * on every tool call: an id that isn't a chat model in `models.yaml` can
   * never be delegated to, so storing it would be a setting that silently does
   * nothing.
   */
  private assertDelegableModels(models: string[] | undefined): void {
    if (!models) return
    const unknown = models.filter((model) => !this.modelRegistry.isChatModel(model))
    if (unknown.length > 0) {
      throw new HttpError(`Unknown or non-chat model: ${unknown.join(", ")}`, {
        status: 400,
        code: "UNKNOWN_SUBAGENT_MODEL",
      })
    }
  }
}
