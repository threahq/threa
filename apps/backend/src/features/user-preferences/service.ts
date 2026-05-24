import { Pool } from "pg"
import { withTransaction } from "../../db"
import { UserPreferencesRepository } from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import {
  type UserPreferences,
  type UpdateUserPreferencesInput,
  type AccessibilityPreferences,
  DEFAULT_USER_PREFERENCES,
  DEFAULT_ACCESSIBILITY,
} from "@threa/types"

/**
 * Merge overrides onto defaults to produce full preferences.
 */
function mergeOverrides(
  workspaceId: string,
  userId: string,
  overrides: Array<{ key: string; value: unknown }>
): UserPreferences {
  // Start with defaults
  const result: UserPreferences = {
    workspaceId,
    userId,
    ...structuredClone(DEFAULT_USER_PREFERENCES),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  // Apply each override
  for (const { key, value } of overrides) {
    if (key.startsWith("accessibility.")) {
      const accessibilityKey = key.slice("accessibility.".length) as keyof AccessibilityPreferences
      ;(result.accessibility as unknown as Record<string, unknown>)[accessibilityKey] = value
    } else if (key.startsWith("keyboardShortcuts.")) {
      const shortcutKey = key.slice("keyboardShortcuts.".length)
      result.keyboardShortcuts[shortcutKey] = value as string
    } else {
      ;(result as unknown as Record<string, unknown>)[key] = value
    }
  }

  return result
}

/**
 * Get the default value for a preference key.
 */
function getDefaultValue(key: string): unknown {
  if (key.startsWith("accessibility.")) {
    const accessibilityKey = key.slice("accessibility.".length) as keyof AccessibilityPreferences
    return DEFAULT_ACCESSIBILITY[accessibilityKey]
  }
  if (key.startsWith("keyboardShortcuts.")) {
    return undefined // No default for specific shortcuts
  }
  return (DEFAULT_USER_PREFERENCES as Record<string, unknown>)[key]
}

/**
 * Check if a value matches the default (should not be stored).
 */
function matchesDefault(key: string, value: unknown): boolean {
  const defaultValue = getDefaultValue(key)
  return JSON.stringify(value) === JSON.stringify(defaultValue)
}

/**
 * Flatten an UpdateUserPreferencesInput into key-value pairs.
 */
function flattenUpdates(updates: UpdateUserPreferencesInput): Array<{ key: string; value: unknown }> {
  const pairs: Array<{ key: string; value: unknown }> = []

  // Top-level simple fields
  const simpleKeys = [
    "theme",
    "messageDisplay",
    "dateFormat",
    "timeFormat",
    "timezone",
    "language",
    "notificationLevel",
    "sidebarCollapsed",
    "messageSendMode",
    "scratchpadCustomPrompt",
    "codeBlockCollapseThreshold",
    "blockquoteCollapseThreshold",
    "voiceTranscriptionModel",
    "voicePolishEnabled",
  ] as const

  for (const key of simpleKeys) {
    if (updates[key] !== undefined) {
      pairs.push({ key, value: updates[key] })
    }
  }

  // Accessibility fields (flatten to accessibility.X)
  if (updates.accessibility) {
    for (const [subKey, value] of Object.entries(updates.accessibility)) {
      if (value !== undefined) {
        pairs.push({ key: `accessibility.${subKey}`, value })
      }
    }
  }

  // Keyboard shortcuts (flatten to keyboardShortcuts.X)
  if (updates.keyboardShortcuts) {
    for (const [actionId, binding] of Object.entries(updates.keyboardShortcuts)) {
      pairs.push({ key: `keyboardShortcuts.${actionId}`, value: binding })
    }
  }

  return pairs
}

export class UserPreferencesService {
  constructor(private pool: Pool) {}

  /**
   * Get user preferences for a user, merging overrides with defaults.
   */
  async getPreferences(workspaceId: string, userId: string): Promise<UserPreferences> {
    // Single query, INV-30
    const overrides = await UserPreferencesRepository.findOverrides(this.pool, userId)
    return mergeOverrides(workspaceId, userId, overrides)
  }

  /**
   * Update user preferences and broadcast to all user's devices via outbox.
   * Only stores overrides that differ from defaults.
   */
  async updatePreferences(
    workspaceId: string,
    userId: string,
    updates: UpdateUserPreferencesInput
  ): Promise<UserPreferences> {
    return withTransaction(this.pool, async (client) => {
      const currentOverrides =
        updates.keyboardShortcuts !== undefined ? await UserPreferencesRepository.findOverrides(client, userId) : null
      const pairs = flattenUpdates(updates)

      // Separate into overrides to set vs keys to delete (match default)
      const toSet: Array<{ key: string; value: unknown }> = []
      const toDelete: string[] = []

      for (const { key, value } of pairs) {
        if (matchesDefault(key, value)) {
          toDelete.push(key)
        } else {
          toSet.push({ key, value })
        }
      }

      if (currentOverrides) {
        const nextShortcutKeys = new Set(
          Object.keys(updates.keyboardShortcuts ?? {}).map((actionId) => `keyboardShortcuts.${actionId}`)
        )

        for (const { key } of currentOverrides) {
          if (!key.startsWith("keyboardShortcuts.")) continue
          if (nextShortcutKeys.has(key)) continue
          toDelete.push(key)
        }
      }

      // Apply changes
      if (toSet.length > 0) {
        await UserPreferencesRepository.bulkSetOverrides(client, userId, toSet)
      }
      if (toDelete.length > 0) {
        await UserPreferencesRepository.bulkDeleteOverrides(client, userId, toDelete)
      }

      // Fetch current state and merge with defaults
      const overrides = await UserPreferencesRepository.findOverrides(client, userId)
      const preferences = mergeOverrides(workspaceId, userId, overrides)

      // Publish outbox event for real-time sync across all user's devices
      await OutboxRepository.insert(client, "user_preferences:updated", {
        workspaceId,
        authorId: userId,
        preferences,
      })

      return preferences
    })
  }
}
