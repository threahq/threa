/**
 * `bots.reads_as_owner` round-trips through the real schema (INV-68) and the
 * personal-only shape invariant holds at the write boundary: a shared bot can
 * never carry TRUE (create refuses; a hand-written row fails loudly at read).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { BotRepository } from "../../src/features/public-api"
import { userId, workspaceId, botId } from "../../src/lib/id"

describe("bots.reads_as_owner", () => {
  let pool: Pool
  let testWorkspaceId: string
  let ownerId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testWorkspaceId = workspaceId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Reads As Owner",
        slug: `reads-as-owner-${testWorkspaceId}`,
        createdBy: userId(),
      })
      ownerId = (await addTestMember(client, testWorkspaceId, userId())).id
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should round-trip the flag through create, findById, and update for a personal bot", async () => {
    const id = botId()
    const created = await BotRepository.create(pool, {
      id,
      workspaceId: testWorkspaceId,
      type: "personal",
      ownerUserId: ownerId,
      readsAsOwner: true,
      slug: `rao-${id.slice(-8)}`,
      name: "Owner Reader",
    })
    expect(created).toMatchObject({ type: "personal", ownerUserId: ownerId, readsAsOwner: true })

    const found = await BotRepository.findById(pool, testWorkspaceId, id)
    expect(found?.readsAsOwner).toBe(true)

    const disabled = await BotRepository.update(pool, id, testWorkspaceId, { readsAsOwner: false })
    expect(disabled?.readsAsOwner).toBe(false)

    const reenabled = await BotRepository.update(pool, id, testWorkspaceId, { readsAsOwner: true })
    expect(reenabled?.readsAsOwner).toBe(true)
  })

  test("should default to false when create omits the flag", async () => {
    const id = botId()
    const created = await BotRepository.create(pool, {
      id,
      workspaceId: testWorkspaceId,
      type: "personal",
      ownerUserId: ownerId,
      slug: `rao-def-${id.slice(-8)}`,
      name: "Default Off",
    })
    expect(created.readsAsOwner).toBe(false)
  })

  test("should refuse readsAsOwner on a shared bot at create and at read", async () => {
    const id = botId()
    expect(
      BotRepository.create(pool, {
        id,
        workspaceId: testWorkspaceId,
        type: "shared",
        ownerUserId: null,
        readsAsOwner: true,
        slug: `rao-shared-${id.slice(-8)}`,
        name: "Shared Bot",
      })
    ).rejects.toThrow("cannot have readsAsOwner=true")

    // A writer that bypassed the repo contract fails loudly at the next read
    // instead of silently widening a shared bot's reach.
    const rogueId = botId()
    await pool.query(
      `INSERT INTO bots (id, workspace_id, type, owner_user_id, reads_as_owner, traits, slug, name)
       VALUES ($1, $2, 'shared', NULL, TRUE, '{}', $3, 'Rogue Shared')`,
      [rogueId, testWorkspaceId, `rao-rogue-${rogueId.slice(-8)}`]
    )
    expect(BotRepository.findById(pool, testWorkspaceId, rogueId)).rejects.toThrow("reads_as_owner=true")
  })
})
