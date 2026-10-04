import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { ANALYTICS_CONSENT_KEY } from "@threahq/types"
import { UserPreferencesRepository, userOverrideRefKey } from "../../src/features/user-preferences"
import { userId, workspaceId } from "../../src/lib/id"
import { setupTestDatabase } from "./setup"

describe("User preference overrides workspace scope (INV-8)", () => {
  let pool: Pool
  let wsA: string
  let wsB: string
  let user: string

  async function addOverride(wid: string, uid: string, key: string, value: unknown) {
    await pool.query(
      `INSERT INTO user_preference_overrides (workspace_id, user_id, key, value) VALUES ($1, $2, $3, $4::jsonb)`,
      [wid, uid, key, JSON.stringify(value)]
    )
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(() => {
    wsA = workspaceId()
    wsB = workspaceId()
    user = userId()
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
