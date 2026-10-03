import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { ANALYTICS_CONSENT_GRANTED, ANALYTICS_CONSENT_KEY, DEFAULT_USER_PREFERENCES } from "@threahq/types"
import { resolveInboxClearMode } from "../../src/features/streams"
import {
  UserPreferencesRepository,
  UserPreferencesService,
  userOverrideRefKey,
} from "../../src/features/user-preferences"
import { userId, workspaceId } from "../../src/lib/id"
import { setupTestDatabase } from "./setup"

describe("User preference overrides workspace scope (INV-8)", () => {
  let pool: Pool
  let service: UserPreferencesService
  let wsA: string
  let wsB: string
  let user: string

  async function addOverride(wid: string, uid: string, key: string, value: unknown) {
    await pool.query(
      `INSERT INTO user_preference_overrides (workspace_id, user_id, key, value) VALUES ($1, $2, $3, $4::jsonb)`,
      [wid, uid, key, JSON.stringify(value)]
    )
  }

  async function storedOverrides(uid: string) {
    const result = await pool.query(
      `SELECT workspace_id, key FROM user_preference_overrides WHERE user_id = $1 ORDER BY key`,
      [uid]
    )
    return result.rows
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new UserPreferencesService(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(() => {
    wsA = workspaceId()
    wsB = workspaceId()
    user = userId()
  })

  test("should read only the requested workspace's overrides when one user id holds overrides in two workspaces", async () => {
    await addOverride(wsA, user, "theme", "dark")
    await addOverride(wsB, user, "messageDisplay", "compact")

    expect({
      inA: await UserPreferencesRepository.findOverrides(pool, wsA, user),
      inB: await UserPreferencesRepository.findOverrides(pool, wsB, user),
    }).toEqual({
      inA: [{ key: "theme", value: "dark" }],
      inB: [{ key: "messageDisplay", value: "compact" }],
    })
  })

  test("should not surface another workspace's override in the merged preferences when the user id matches", async () => {
    await addOverride(wsB, user, "theme", "dark")

    const prefs = await service.getPreferences(wsA, user)

    expect({ workspaceId: prefs.workspaceId, theme: prefs.theme }).toEqual({
      workspaceId: wsA,
      theme: DEFAULT_USER_PREFERENCES.theme,
    })
  })

  test("should not find another workspace's override when reading one key for the same user id", async () => {
    await addOverride(wsB, user, "messageDisplay", "compact")

    expect({
      inA: await UserPreferencesRepository.findOverride(pool, wsA, user, "messageDisplay"),
      inB: await UserPreferencesRepository.findOverride(pool, wsB, user, "messageDisplay"),
    }).toEqual({ inA: null, inB: { key: "messageDisplay", value: "compact" } })
  })

  test("should fall back to the default clear mode when the override is stored in another workspace", async () => {
    await addOverride(wsB, user, "inboxClearMode", "manual")

    expect({
      inA: await resolveInboxClearMode(pool, wsA, user),
      inB: await resolveInboxClearMode(pool, wsB, user),
    }).toEqual({ inA: DEFAULT_USER_PREFERENCES.inboxClearMode, inB: "manual" })
  })

  test("should hand out a consent generation only in the workspace that holds the grant", async () => {
    await addOverride(wsB, user, ANALYTICS_CONSENT_KEY, ANALYTICS_CONSENT_GRANTED)
    const repoGeneration = (wid: string) =>
      UserPreferencesRepository.findOverrideGeneration(
        pool,
        wid,
        user,
        ANALYTICS_CONSENT_KEY,
        ANALYTICS_CONSENT_GRANTED
      )

    expect({
      repoInA: await repoGeneration(wsA),
      serviceInA: await service.findAnalyticsConsentGrant(pool, wsA, user),
      repoInB: await repoGeneration(wsB),
      serviceInB: await service.findAnalyticsConsentGrant(pool, wsB, user),
    }).toEqual({
      repoInA: null,
      serviceInA: null,
      repoInB: expect.any(String),
      serviceInB: expect.any(String),
    })
  })

  test("should leave another workspace's overrides when deleting keys for the same user id", async () => {
    await addOverride(wsA, user, "theme", "dark")
    await addOverride(wsB, user, "messageDisplay", "compact")

    await UserPreferencesRepository.bulkDeleteOverrides(pool, wsA, user, ["theme", "messageDisplay"])

    expect(await storedOverrides(user)).toEqual([{ workspace_id: wsB, key: "messageDisplay" }])
  })

  test("should pair each user with its own workspace when reading consent for a batch", async () => {
    const other = userId()
    await addOverride(wsA, user, ANALYTICS_CONSENT_KEY, "granted")
    await addOverride(wsB, other, ANALYTICS_CONSENT_KEY, "denied")

    const read = (refs: Array<[string, string]>) =>
      UserPreferencesRepository.findOverrideForUsers(
        pool,
        refs.map(([wid, uid]) => ({ workspaceId: wid, userId: uid })),
        ANALYTICS_CONSENT_KEY
      )

    expect({
      ownPairs: await read([
        [wsA, user],
        [wsB, other],
      ]),
      userInWrongWorkspace: await read([[wsB, user]]),
      crossedPairs: await read([
        [wsA, other],
        [wsB, user],
      ]),
    }).toEqual({
      ownPairs: new Map([
        [userOverrideRefKey(wsA, user), "granted"],
        [userOverrideRefKey(wsB, other), "denied"],
      ]),
      userInWrongWorkspace: new Map(),
      crossedPairs: new Map(),
    })
  })
})
