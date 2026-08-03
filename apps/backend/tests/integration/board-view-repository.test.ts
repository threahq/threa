import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { withTransaction, addTestMember, setupTestDatabase } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { BoardViewRepository } from "../../src/features/board-views"
import { sql } from "../../src/db"
import { userId, workspaceId, boardViewId } from "../../src/lib/id"

describe("BoardViewRepository", () => {
  let pool: Pool
  let testUserId: string
  let testWorkspaceId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testUserId = userId()
    testWorkspaceId = workspaceId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Test Workspace",
        slug: `test-ws-${testWorkspaceId}`,
        createdBy: testUserId,
      })
      testUserId = (await addTestMember(client, testWorkspaceId, testUserId)).id
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("degrades a retired stored base_lens to 'all' on read", async () => {
    const id = boardViewId()
    await pool.query(sql`
      INSERT INTO board_views
        (id, workspace_id, user_id, name, base_lens, scope_stream_ids, scope_stream_types,
         scope_label_ids, exclude_stream_ids, exclude_stream_types, exclude_label_ids, sort_order)
      VALUES (${id}, ${testWorkspaceId}, ${testUserId}, 'Legacy view', 'decisions',
        '{}'::text[], '{}'::text[], '{}'::text[], '{}'::text[], '{}'::text[], '{}'::text[], 0)
    `)

    const views = await BoardViewRepository.listForUser(pool, testWorkspaceId, testUserId)

    expect(views.find((v) => v.id === id)?.baseLens).toBe("all")
  })

  test("keeps a live lens unchanged", async () => {
    const view = await BoardViewRepository.create(pool, {
      workspaceId: testWorkspaceId,
      userId: testUserId,
      name: "Mine",
      baseLens: "mine",
      scopeStreamIds: [],
      scopeStreamTypes: [],
      scopeLabelIds: [],
      excludeStreamIds: [],
      excludeStreamTypes: [],
      excludeLabelIds: [],
    })

    expect(view.baseLens).toBe("mine")
  })
})
