/**
 * Device-timezone refresh (socket heartbeat → users.timezone).
 *
 * The conditional single-statement update is what makes concurrent reporters
 * safe (INV-20): a write only happens when the value actually changed, so the
 * outbox event upstream fires only on real changes.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTestTransaction, addTestMember } from "./setup"
import { WorkspaceRepository, UserRepository } from "../../src/features/workspaces"
import { userId, workspaceId } from "../../src/lib/id"

describe("UserRepository.updateTimezoneIfChanged", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("writes when the timezone changed, no-ops when it matches", async () => {
    await withTestTransaction(pool, async (client) => {
      const workosUserId = userId()
      const wsId = workspaceId()
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "TZ Refresh Workspace",
        slug: `tz-ws-${wsId}`,
        createdBy: workosUserId,
      })
      const member = await addTestMember(client, wsId, workosUserId)

      const updated = await UserRepository.updateTimezoneIfChanged(client, wsId, member.id, "Europe/Stockholm")
      expect(updated).toMatchObject({ id: member.id, timezone: "Europe/Stockholm" })

      // Same value again → no row updated, caller skips the outbox event.
      const unchanged = await UserRepository.updateTimezoneIfChanged(client, wsId, member.id, "Europe/Stockholm")
      expect(unchanged).toBeNull()

      const reread = await UserRepository.findById(client, wsId, member.id)
      expect(reread?.timezone).toBe("Europe/Stockholm")
    })
  })

  test("returns null for a user outside the workspace", async () => {
    await withTestTransaction(pool, async (client) => {
      const workosUserId = userId()
      const wsId = workspaceId()
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "TZ Refresh Workspace 2",
        slug: `tz-ws-${wsId}`,
        createdBy: workosUserId,
      })

      const result = await UserRepository.updateTimezoneIfChanged(client, wsId, userId(), "Europe/Stockholm")
      expect(result).toBeNull()
    })
  })
})
