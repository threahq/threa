import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { UserPreferencesService, UserPreferencesRepository } from "../../src/features/user-preferences"
import { workspaceId, userId } from "../../src/lib/id"
import { setupTestDatabase } from "./setup"
import { DEFAULT_USER_PREFERENCES } from "@threa/types"
import { ARIADNE_AGENT_ID } from "../../src/features/agents"

describe("User Preferences - Sparse Override Pattern", () => {
  let pool: Pool
  let service: UserPreferencesService
  let testWorkspaceId: string
  let testUserId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new UserPreferencesService(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    // Clean up and generate fresh IDs
    await pool.query("DELETE FROM user_preference_overrides")
    await pool.query("DELETE FROM outbox")
    testWorkspaceId = workspaceId()
    testUserId = userId()
  })

  describe("getPreferences", () => {
    test("should return defaults when no overrides exist", async () => {
      const prefs = await service.getPreferences(testWorkspaceId, testUserId)

      expect(prefs).toMatchObject({
        workspaceId: testWorkspaceId,
        userId: testUserId,
        theme: DEFAULT_USER_PREFERENCES.theme,
        messageDisplay: DEFAULT_USER_PREFERENCES.messageDisplay,
        dateFormat: DEFAULT_USER_PREFERENCES.dateFormat,
        timeFormat: DEFAULT_USER_PREFERENCES.timeFormat,
        notificationLevel: DEFAULT_USER_PREFERENCES.notificationLevel,
        sidebarCollapsed: DEFAULT_USER_PREFERENCES.sidebarCollapsed,
        accessibility: DEFAULT_USER_PREFERENCES.accessibility,
      })

      // Verify no rows in database
      const overrides = await UserPreferencesRepository.findOverrides(pool, testUserId)
      expect(overrides).toHaveLength(0)
    })
  })

  describe("updatePreferences - sparse storage", () => {
    test("should only store overrides that differ from defaults", async () => {
      // Update theme to non-default value
      await service.updatePreferences(testWorkspaceId, testUserId, {
        theme: "dark",
      })

      // Verify only one row exists
      const overrides = await UserPreferencesRepository.findOverrides(pool, testUserId)
      expect(overrides).toHaveLength(1)
      expect(overrides[0]).toMatchObject({ key: "theme", value: "dark" })
    })

    test("should not store values that match defaults", async () => {
      // Update theme to the default value
      await service.updatePreferences(testWorkspaceId, testUserId, {
        theme: "system", // This is the default
      })

      // Verify no rows exist
      const overrides = await UserPreferencesRepository.findOverrides(pool, testUserId)
      expect(overrides).toHaveLength(0)
    })

    test("should delete override when value reverts to default", async () => {
      // First set to non-default
      await service.updatePreferences(testWorkspaceId, testUserId, {
        theme: "dark",
      })

      let overrides = await UserPreferencesRepository.findOverrides(pool, testUserId)
      expect(overrides).toHaveLength(1)

      // Revert to default
      await service.updatePreferences(testWorkspaceId, testUserId, {
        theme: "system",
      })

      overrides = await UserPreferencesRepository.findOverrides(pool, testUserId)
      expect(overrides).toHaveLength(0)
    })

    test("should handle nested accessibility overrides", async () => {
      await service.updatePreferences(testWorkspaceId, testUserId, {
        accessibility: {
          fontSize: "large",
          reducedMotion: true,
        },
      })

      const overrides = await UserPreferencesRepository.findOverrides(pool, testUserId)

      // Should have two separate rows for nested keys
      expect(overrides).toHaveLength(2)
      const keys = overrides.map((o) => o.key).sort()
      expect(keys).toEqual(["accessibility.fontSize", "accessibility.reducedMotion"])
    })

    test("should merge overrides with defaults when fetching", async () => {
      // Set only theme override
      await service.updatePreferences(testWorkspaceId, testUserId, {
        theme: "dark",
      })

      const prefs = await service.getPreferences(testWorkspaceId, testUserId)

      // Theme should be overridden
      expect(prefs.theme).toBe("dark")

      // Other values should be defaults
      expect(prefs.messageDisplay).toBe(DEFAULT_USER_PREFERENCES.messageDisplay)
      expect(prefs.dateFormat).toBe(DEFAULT_USER_PREFERENCES.dateFormat)
      expect(prefs.accessibility).toEqual(DEFAULT_USER_PREFERENCES.accessibility)
    })

    test("should handle multiple overrides correctly", async () => {
      await service.updatePreferences(testWorkspaceId, testUserId, {
        theme: "dark",
        messageDisplay: "compact",
        dateFormat: "DD/MM/YYYY",
        accessibility: {
          fontSize: "large",
        },
      })

      const overrides = await UserPreferencesRepository.findOverrides(pool, testUserId)

      // Should have 4 overrides
      expect(overrides).toHaveLength(4)

      const prefs = await service.getPreferences(testWorkspaceId, testUserId)
      expect(prefs.theme).toBe("dark")
      expect(prefs.messageDisplay).toBe("compact")
      expect(prefs.dateFormat).toBe("DD/MM/YYYY")
      expect(prefs.accessibility.fontSize).toBe("large")
      // Non-overridden accessibility fields should be defaults
      expect(prefs.accessibility.reducedMotion).toBe(false)
      expect(prefs.accessibility.highContrast).toBe(false)
    })

    test("should store scratchpad custom prompt overrides", async () => {
      await service.updatePreferences(testWorkspaceId, testUserId, {
        scratchpadCustomPrompt: "Be terse in scratchpads.",
      })

      const overrides = await UserPreferencesRepository.findOverrides(pool, testUserId)

      expect(overrides).toEqual([{ key: "scratchpadCustomPrompt", value: "Be terse in scratchpads." }])
    })

    test("should store a non-null default companion persona override (active persona passes validation)", async () => {
      // Ariadne (a built-in) is always an active persona in every workspace, so it
      // passes write-time validation; the stored id differs from the null default.
      await service.updatePreferences(testWorkspaceId, testUserId, {
        defaultCompanionPersonaId: ARIADNE_AGENT_ID,
      })

      const overrides = await UserPreferencesRepository.findOverrides(pool, testUserId)
      expect(overrides).toEqual([{ key: "defaultCompanionPersonaId", value: ARIADNE_AGENT_ID }])
    })

    test("should delete the default companion persona override when reverted to null", async () => {
      await service.updatePreferences(testWorkspaceId, testUserId, {
        defaultCompanionPersonaId: ARIADNE_AGENT_ID,
      })
      expect(await UserPreferencesRepository.findOverrides(pool, testUserId)).toHaveLength(1)

      await service.updatePreferences(testWorkspaceId, testUserId, {
        defaultCompanionPersonaId: null,
      })
      expect(await UserPreferencesRepository.findOverrides(pool, testUserId)).toHaveLength(0)
    })

    test("should reject a default companion persona id that is not an active workspace persona", async () => {
      await expect(
        service.updatePreferences(testWorkspaceId, testUserId, {
          defaultCompanionPersonaId: "persona_does_not_exist",
        })
      ).rejects.toMatchObject({ status: 400, code: "PERSONA_NOT_AVAILABLE" })

      // Nothing was stored on the rejected write.
      expect(await UserPreferencesRepository.findOverrides(pool, testUserId)).toHaveLength(0)
    })
  })

  describe("keyboard shortcuts", () => {
    test("should store keyboard shortcut overrides", async () => {
      await service.updatePreferences(testWorkspaceId, testUserId, {
        keyboardShortcuts: {
          openQuickSwitcher: "mod+p",
        },
      })

      const overrides = await UserPreferencesRepository.findOverrides(pool, testUserId)

      expect(overrides).toHaveLength(1)
      expect(overrides[0]).toMatchObject({
        key: "keyboardShortcuts.openQuickSwitcher",
        value: "mod+p",
      })
    })

    test("should delete omitted keyboard shortcut overrides when updating the map", async () => {
      await service.updatePreferences(testWorkspaceId, testUserId, {
        keyboardShortcuts: {
          openQuickSwitcher: "mod+p",
          openSearch: "mod+shift+f",
        },
      })

      await service.updatePreferences(testWorkspaceId, testUserId, {
        keyboardShortcuts: {
          openSearch: "mod+shift+s",
        },
      })

      const overrides = await UserPreferencesRepository.findOverrides(pool, testUserId)

      expect(overrides).toEqual([{ key: "keyboardShortcuts.openSearch", value: "mod+shift+s" }])

      const prefs = await service.getPreferences(testWorkspaceId, testUserId)
      expect(prefs.keyboardShortcuts).toEqual({
        openSearch: "mod+shift+s",
      })
    })

    test("should clear all keyboard shortcut overrides when resetting to an empty map", async () => {
      await service.updatePreferences(testWorkspaceId, testUserId, {
        keyboardShortcuts: {
          openQuickSwitcher: "mod+p",
        },
      })

      await service.updatePreferences(testWorkspaceId, testUserId, {
        keyboardShortcuts: {},
      })

      const overrides = await UserPreferencesRepository.findOverrides(pool, testUserId)
      expect(overrides).toHaveLength(0)

      const prefs = await service.getPreferences(testWorkspaceId, testUserId)
      expect(prefs.keyboardShortcuts).toEqual({})
    })
  })

  describe("outbox events", () => {
    test("should publish outbox event with merged preferences", async () => {
      await service.updatePreferences(testWorkspaceId, testUserId, {
        theme: "dark",
      })

      const result = await pool.query(
        `SELECT payload FROM outbox WHERE event_type = 'user_preferences:updated' ORDER BY id DESC LIMIT 1`
      )

      expect(result.rows).toHaveLength(1)
      const payload = result.rows[0].payload

      // Payload should contain full merged preferences, not just overrides
      expect(payload.preferences.theme).toBe("dark")
      expect(payload.preferences.messageDisplay).toBe(DEFAULT_USER_PREFERENCES.messageDisplay)
    })
  })
})
