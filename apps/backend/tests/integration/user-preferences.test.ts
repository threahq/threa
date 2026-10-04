import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import {
  UserPreferencesService,
  UserPreferencesRepository,
  userOverrideRefKey,
} from "../../src/features/user-preferences"
import { workspaceId, userId } from "../../src/lib/id"
import { setupTestDatabase } from "./setup"
import { ANALYTICS_CONSENT_GRANTED, ANALYTICS_CONSENT_KEY, DEFAULT_USER_PREFERENCES } from "@threahq/types"
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
      const overrides = await UserPreferencesRepository.findOverrides(pool, testWorkspaceId, testUserId)
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
      const overrides = await UserPreferencesRepository.findOverrides(pool, testWorkspaceId, testUserId)
      expect(overrides).toHaveLength(1)
      expect(overrides[0]).toMatchObject({ key: "theme", value: "dark" })
    })

    test("should not store values that match defaults", async () => {
      // Update theme to the default value
      await service.updatePreferences(testWorkspaceId, testUserId, {
        theme: "system", // This is the default
      })

      // Verify no rows exist
      const overrides = await UserPreferencesRepository.findOverrides(pool, testWorkspaceId, testUserId)
      expect(overrides).toHaveLength(0)
    })

    test("should delete override when value reverts to default", async () => {
      // First set to non-default
      await service.updatePreferences(testWorkspaceId, testUserId, {
        theme: "dark",
      })

      let overrides = await UserPreferencesRepository.findOverrides(pool, testWorkspaceId, testUserId)
      expect(overrides).toHaveLength(1)

      // Revert to default
      await service.updatePreferences(testWorkspaceId, testUserId, {
        theme: "system",
      })

      overrides = await UserPreferencesRepository.findOverrides(pool, testWorkspaceId, testUserId)
      expect(overrides).toHaveLength(0)
    })

    test("should handle nested accessibility overrides", async () => {
      await service.updatePreferences(testWorkspaceId, testUserId, {
        accessibility: {
          fontSize: "large",
          reducedMotion: true,
        },
      })

      const overrides = await UserPreferencesRepository.findOverrides(pool, testWorkspaceId, testUserId)

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

      const overrides = await UserPreferencesRepository.findOverrides(pool, testWorkspaceId, testUserId)

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

      const overrides = await UserPreferencesRepository.findOverrides(pool, testWorkspaceId, testUserId)

      expect(overrides).toEqual([{ key: "scratchpadCustomPrompt", value: "Be terse in scratchpads." }])
    })

    test("should store a non-null default companion persona override (active persona passes validation)", async () => {
      // Ariadne (a built-in) is always an active persona in every workspace, so it
      // passes write-time validation; the stored id differs from the null default.
      await service.updatePreferences(testWorkspaceId, testUserId, {
        defaultCompanionPersonaId: ARIADNE_AGENT_ID,
      })

      const overrides = await UserPreferencesRepository.findOverrides(pool, testWorkspaceId, testUserId)
      expect(overrides).toEqual([{ key: "defaultCompanionPersonaId", value: ARIADNE_AGENT_ID }])
    })

    test("should delete the default companion persona override when reverted to null", async () => {
      await service.updatePreferences(testWorkspaceId, testUserId, {
        defaultCompanionPersonaId: ARIADNE_AGENT_ID,
      })
      expect(await UserPreferencesRepository.findOverrides(pool, testWorkspaceId, testUserId)).toHaveLength(1)

      await service.updatePreferences(testWorkspaceId, testUserId, {
        defaultCompanionPersonaId: null,
      })
      expect(await UserPreferencesRepository.findOverrides(pool, testWorkspaceId, testUserId)).toHaveLength(0)
    })

    test("should reject a default companion persona id that is not an active workspace persona", async () => {
      await expect(
        service.updatePreferences(testWorkspaceId, testUserId, {
          defaultCompanionPersonaId: "persona_does_not_exist",
        })
      ).rejects.toMatchObject({ status: 400, code: "PERSONA_NOT_AVAILABLE" })

      // Nothing was stored on the rejected write.
      expect(await UserPreferencesRepository.findOverrides(pool, testWorkspaceId, testUserId)).toHaveLength(0)
    })
  })

  describe("keyboard shortcuts", () => {
    test("should store keyboard shortcut overrides", async () => {
      await service.updatePreferences(testWorkspaceId, testUserId, {
        keyboardShortcuts: {
          openQuickSwitcher: "mod+p",
        },
      })

      const overrides = await UserPreferencesRepository.findOverrides(pool, testWorkspaceId, testUserId)

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

      const overrides = await UserPreferencesRepository.findOverrides(pool, testWorkspaceId, testUserId)

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

      const overrides = await UserPreferencesRepository.findOverrides(pool, testWorkspaceId, testUserId)
      expect(overrides).toHaveLength(0)

      const prefs = await service.getPreferences(testWorkspaceId, testUserId)
      expect(prefs.keyboardShortcuts).toEqual({})
    })
  })

  describe("findOverrideForUsers", () => {
    test("should return only the users that have an override for the key when reading a batch", async () => {
      const userA = userId()
      const userB = userId()
      const userC = userId()
      await UserPreferencesRepository.setOverride(pool, testWorkspaceId, userA, "analyticsConsent", "granted")
      await UserPreferencesRepository.setOverride(pool, testWorkspaceId, userB, "analyticsConsent", "denied")

      const result = await UserPreferencesRepository.findOverrideForUsers(
        pool,
        [userA, userB, userC].map((id) => ({ workspaceId: testWorkspaceId, userId: id })),
        "analyticsConsent"
      )

      expect(result).toEqual(
        new Map([
          [userOverrideRefKey(testWorkspaceId, userA), "granted"],
          [userOverrideRefKey(testWorkspaceId, userB), "denied"],
        ])
      )
      expect(await UserPreferencesRepository.findOverrideForUsers(pool, [], "analyticsConsent")).toEqual(new Map())
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

  describe("analytics consent grant", () => {
    const grant = () => service.findAnalyticsConsentGrant(pool, testWorkspaceId, testUserId)
    const setConsent = (analyticsConsent: "granted" | "denied" | "unset") =>
      service.updatePreferences(testWorkspaceId, testUserId, { analyticsConsent })

    test("should keep one grant across no-op and unrelated writes, and hand out a new one after any withdrawal, reset or delete", async () => {
      const seen: Record<string, string | null> = {}
      await setConsent("granted")
      seen.granted = await grant()
      await setConsent("granted")
      seen.regrantedNoOp = await grant()
      await UserPreferencesRepository.setOverride(
        pool,
        testWorkspaceId,
        testUserId,
        ANALYTICS_CONSENT_KEY,
        ANALYTICS_CONSENT_GRANTED
      )
      seen.setOverrideNoOp = await grant()
      await UserPreferencesRepository.bulkSetOverrides(pool, testWorkspaceId, testUserId, [
        { key: ANALYTICS_CONSENT_KEY, value: ANALYTICS_CONSENT_GRANTED },
        { key: "theme", value: "dark" },
      ])
      seen.bulkNoOp = await grant()
      await service.updatePreferences(testWorkspaceId, testUserId, { theme: "light" })
      seen.unrelatedWrite = await grant()

      await setConsent("denied")
      seen.denied = await grant()
      await setConsent("granted")
      seen.afterDenied = await grant()
      await setConsent("unset")
      seen.unset = await grant()
      await setConsent("granted")
      seen.afterUnset = await grant()
      await UserPreferencesRepository.bulkDeleteOverrides(pool, testWorkspaceId, testUserId, [ANALYTICS_CONSENT_KEY])
      await UserPreferencesRepository.setOverride(
        pool,
        testWorkspaceId,
        testUserId,
        ANALYTICS_CONSENT_KEY,
        ANALYTICS_CONSENT_GRANTED
      )
      seen.afterDelete = await grant()
      await UserPreferencesRepository.bulkDeleteOverrides(pool, testWorkspaceId, testUserId, [
        ANALYTICS_CONSENT_KEY,
        "theme",
      ])
      seen.reset = await grant()
      await UserPreferencesRepository.bulkSetOverrides(pool, testWorkspaceId, testUserId, [
        { key: ANALYTICS_CONSENT_KEY, value: ANALYTICS_CONSENT_GRANTED },
      ])
      seen.afterReset = await grant()

      const grants = [seen.granted, seen.afterDenied, seen.afterUnset, seen.afterDelete, seen.afterReset]
      expect({
        seen,
        distinctGrants: new Set(grants).size,
        increasing: grants.every((g, i) => i === 0 || BigInt(g!) > BigInt(grants[i - 1]!)),
      }).toEqual({
        seen: {
          granted: expect.any(String),
          regrantedNoOp: seen.granted,
          setOverrideNoOp: seen.granted,
          bulkNoOp: seen.granted,
          unrelatedWrite: seen.granted,
          denied: null,
          afterDenied: expect.any(String),
          unset: null,
          afterUnset: expect.any(String),
          afterDelete: expect.any(String),
          reset: null,
          afterReset: expect.any(String),
        },
        distinctGrants: 5,
        increasing: true,
      })
    })

    test("should own the generation in the database, whatever a legacy or explicit write sends", async () => {
      const rowGeneration = async () =>
        (
          await pool.query<{ value_generation: string }>(
            "SELECT value_generation FROM user_preference_overrides WHERE user_id = $1 AND key = $2",
            [testUserId, ANALYTICS_CONSENT_KEY]
          )
        ).rows[0]?.value_generation ?? null
      const seen: Record<string, string | null> = {}

      // A replica that predates the column: its statements never name it.
      await pool.query(
        `INSERT INTO user_preference_overrides (workspace_id, user_id, key, value) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (workspace_id, user_id, key) DO UPDATE SET value = $4::jsonb, updated_at = NOW()`,
        [testWorkspaceId, testUserId, ANALYTICS_CONSENT_KEY, JSON.stringify("granted")]
      )
      seen.legacyInsert = await rowGeneration()
      await pool.query("UPDATE user_preference_overrides SET updated_at = NOW() WHERE user_id = $1 AND key = $2", [
        testUserId,
        ANALYTICS_CONSENT_KEY,
      ])
      seen.legacyTouch = await rowGeneration()
      await pool.query(
        "UPDATE user_preference_overrides SET value = $3::jsonb, updated_at = NOW() WHERE user_id = $1 AND key = $2",
        [testUserId, ANALYTICS_CONSENT_KEY, JSON.stringify("denied")]
      )
      seen.legacyChange = await rowGeneration()

      // A writer that tries to pick the number, or to restore an old one.
      await pool.query("UPDATE user_preference_overrides SET value_generation = $3 WHERE user_id = $1 AND key = $2", [
        testUserId,
        ANALYTICS_CONSENT_KEY,
        seen.legacyInsert,
      ])
      seen.explicitUpdate = await rowGeneration()
      await pool.query("DELETE FROM user_preference_overrides WHERE user_id = $1", [testUserId])
      await pool.query(
        "INSERT INTO user_preference_overrides (workspace_id, user_id, key, value, value_generation) VALUES ($1, $2, $3, $4::jsonb, $5)",
        [testWorkspaceId, testUserId, ANALYTICS_CONSENT_KEY, JSON.stringify("granted"), seen.legacyInsert]
      )
      seen.explicitInsert = await rowGeneration()

      expect({
        seen,
        explicitInsertIsNew: ![seen.legacyInsert, seen.legacyChange].includes(seen.explicitInsert),
        grant: await grant(),
      }).toEqual({
        seen: {
          legacyInsert: expect.any(String),
          legacyTouch: seen.legacyInsert,
          legacyChange: expect.not.stringMatching(`^${seen.legacyInsert}$`),
          explicitUpdate: seen.legacyChange,
          explicitInsert: expect.any(String),
        },
        explicitInsertIsNew: true,
        grant: seen.explicitInsert,
      })
    })
  })
})
