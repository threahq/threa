import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { addTestMember, setupTestDatabase } from "./setup"
import { SavedMessagesService } from "../../src/features/saved-messages"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { savedMessageId, userId, workspaceId } from "../../src/lib/id"

describe("Saved reminder lookups workspace scope (INV-8)", () => {
  let pool: Pool
  let service: SavedMessagesService

  let wsA: string
  let memberA: string

  async function seedWorkspace(label: string) {
    const id = workspaceId()
    await WorkspaceRepository.insert(pool, {
      id,
      name: `Saved scope ${label}`,
      slug: `saved-scope-${label}-${id}`,
      createdBy: userId(),
    })
    return id
  }

  async function seedMember(wid: string) {
    return (await addTestMember(pool, wid, userId())).id
  }

  async function seedSaved(wid: string, user: string) {
    const id = savedMessageId()
    await pool.query(
      `INSERT INTO saved_messages (id, workspace_id, user_id, title, status, remind_at)
       VALUES ($1, $2, $3, 'scope fixture', 'saved', NOW())`,
      [id, wid, user]
    )
    return id
  }

  async function storedSaved(id: string) {
    const result = await pool.query(
      `SELECT workspace_id, user_id, status, reminder_sent_at, updated_at FROM saved_messages WHERE id = $1`,
      [id]
    )
    return result.rows[0]
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new SavedMessagesService({ pool })

    wsA = await seedWorkspace("a")
    memberA = await seedMember(wsA)
  }, 60_000)

  afterAll(async () => {
    await pool.end()
  })

  test("should not fire another user's reminder in the same workspace when the worker's service call names a different user", async () => {
    const otherUsers = await seedSaved(wsA, await seedMember(wsA))
    const before = await storedSaved(otherUsers)

    const result = await service.markReminderFired({ workspaceId: wsA, userId: memberA, savedId: otherUsers })

    expect({ result, stored: await storedSaved(otherUsers) }).toEqual({ result: { fired: false }, stored: before })
  })

  test("should fire the workspace's own reminder when the worker's service call names its workspace and user", async () => {
    const own = await seedSaved(wsA, memberA)

    const result = await service.markReminderFired({ workspaceId: wsA, userId: memberA, savedId: own })

    expect({ result, sent: (await storedSaved(own)).reminder_sent_at !== null }).toEqual({
      result: { fired: true },
      sent: true,
    })
  })
})
