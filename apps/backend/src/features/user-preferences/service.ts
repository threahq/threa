import { Pool } from "pg"
import { withTransaction, type Querier } from "../../db"
import { UserPreferencesRepository } from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import { assertAssignablePersona } from "../agents"
import { toShortcode } from "../emoji"
import { UserDeviceContextRepository } from "../device-context"
import { ReadStateRepository, releaseInboxHold } from "../streams"
import { HttpError } from "../../lib/errors"
import {
  type UserPreferences,
  type UpdateUserPreferencesInput,
  type AccessibilityPreferences,
  DEFAULT_USER_PREFERENCES,
  DEFAULT_ACCESSIBILITY,
  ANALYTICS_CONSENT_KEY,
  ANALYTICS_CONSENT_GRANTED,
} from "@threahq/types"

function mergeOverrides(
  workspaceId: string,
  userId: string,
  overrides: Array<{ key: string; value: unknown }>
): UserPreferences {
  const result: UserPreferences = {
    workspaceId,
    userId,
    ...structuredClone(DEFAULT_USER_PREFERENCES),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

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

/** Defaults are not stored as overrides; this gates that. */
function matchesDefault(key: string, value: unknown): boolean {
  const defaultValue = getDefaultValue(key)
  return JSON.stringify(value) === JSON.stringify(defaultValue)
}

function flattenUpdates(updates: UpdateUserPreferencesInput): Array<{ key: string; value: unknown }> {
  const pairs: Array<{ key: string; value: unknown }> = []

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
    "mobileInlineAttachments",
    "linkPreviewDefault",
    "labelRemoveOnMove",
    "unreadOpenPosition",
    "inboxClearMode",
    "pushActions",
    "pushReminderMinutes",
    "pushQuickReaction",
    "scratchpadCustomPrompt",
    "codeBlockCollapseThreshold",
    "blockquoteCollapseThreshold",
    "codeBlockWrap",
    "codeBlockWrapOverrides",
    "messageCollapseEnabled",
    "messageCollapseAtHeight",
    "messageCollapseToHeight",
    "messageCollapseThreshold",
    "boardCardCollapseEnabled",
    "boardCardCollapseAtHeight",
    "boardCardCollapseToHeight",
    "boardCardCollapseThreshold",
    "boardFullTailCount",
    "boardLedgerRows",
    "boardLeadLineLength",
    "boardMassBadge",
    "boardDefaultLens",
    "boardDefaultViewId",
    "voiceTranscriptionModel",
    "voicePolishLevel",
    "voiceSteeringWords",
    "workSchedule",
    "defaultCompanionPersonaId",
    "subagentModels",
    "statusPresets",
    "gettingStartedDismissed",
    "performanceDiagnosticsOptIn",
    "analyticsConsent",
    "sessionReplayOptIn",
    "shareDeviceWithAgents",
  ] as const

  // Replay rides on analytics consent: withdrawing consent withdraws replay
  // with it, so re-granting consent later cannot silently resume recording.
  const withdrawsConsent = updates.analyticsConsent !== undefined && updates.analyticsConsent !== "granted"

  for (const key of simpleKeys) {
    if (updates[key] === undefined) continue
    if (key === "sessionReplayOptIn" && withdrawsConsent) continue
    pairs.push({ key, value: updates[key] })
  }

  if (withdrawsConsent) {
    pairs.push({ key: "sessionReplayOptIn", value: false })
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
   * The user's current analytics consent grant: its value generation, which
   * changes on any withdrawal, reset or re-grant, or null when consent is not
   * granted (the default is "unset"). Inside a transaction the grant stays
   * share-locked until it ends, so a change to it commits either before the
   * read (and is seen) or after the caller's writes.
   */
  async findAnalyticsConsentGrant(db: Querier, userId: string): Promise<string | null> {
    return UserPreferencesRepository.findOverrideGeneration(
      db,
      userId,
      ANALYTICS_CONSENT_KEY,
      ANALYTICS_CONSENT_GRANTED
    )
  }

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
    await assertAssignablePersona(this.pool, updates.defaultCompanionPersonaId, workspaceId, { callerUserId: userId })
    // Same acceptance as the reactions endpoint, so a saved quick reaction can never 400 later.
    if (updates.pushQuickReaction !== undefined && toShortcode(updates.pushQuickReaction) === null) {
      throw new HttpError("Invalid emoji", { status: 400, code: "INVALID_EMOJI" })
    }
    return withTransaction(this.pool, async (client) => {
      const currentOverrides =
        updates.keyboardShortcuts !== undefined ? await UserPreferencesRepository.findOverrides(client, userId) : null
      const pairs = flattenUpdates(updates)

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

      // Held until commit, so a device report in flight either lands before
      // the delete below or sees the opt-out and writes nothing.
      const sharingOff = updates.shareDeviceWithAgents === false
      if (sharingOff) await UserDeviceContextRepository.lockUser(client, workspaceId, userId)

      if (toSet.length > 0) {
        await UserPreferencesRepository.bulkSetOverrides(client, workspaceId, userId, toSet)
      }
      if (toDelete.length > 0) {
        await UserPreferencesRepository.bulkDeleteOverrides(client, userId, toDelete)
      }

      if (sharingOff) await UserDeviceContextRepository.delete(client, workspaceId, userId)

      if (updates.inboxClearMode === "read") {
        const held = await ReadStateRepository.listInboxHeldStreamIds(client, workspaceId, userId)
        await releaseInboxHold(client, workspaceId, userId, held)
      }

      const overrides = await UserPreferencesRepository.findOverrides(client, userId)
      const preferences = mergeOverrides(workspaceId, userId, overrides)

      // Outbox event drives real-time sync across all the user's devices
      await OutboxRepository.insert(client, "user_preferences:updated", {
        workspaceId,
        authorId: userId,
        preferences,
      })

      return preferences
    })
  }
}
