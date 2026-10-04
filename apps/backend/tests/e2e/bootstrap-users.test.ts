import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { userId } from "../../src/lib/id"
import { createTestPool } from "../integration/setup"
import { TestClient, createWorkspace, getWorkspaceBootstrap, loginAs } from "../client"

const testRunId = Math.random().toString(36).substring(7)

describe("workspace bootstrap users", () => {
  let pool: Pool

  beforeAll(() => {
    pool = createTestPool()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should list every user when the workspace holds more than 200", async () => {
    const client = new TestClient()
    await loginAs(client, `bootusers-${testRunId}@test.com`, "Bootstrap Users")
    const workspace = await createWorkspace(client, `Bootstrap Users WS ${testRunId}`)
    const existing = (await getWorkspaceBootstrap(client, workspace.id)).users.map((user) => user.id)
    const seeded = Array.from({ length: 204 }, () => userId())
    await pool.query(
      `INSERT INTO users (id, workspace_id, workos_user_id, email, role, slug, name)
       SELECT t.id, $1, NULL, NULL, 'member', 'seeded-' || t.id, 'Seeded ' || t.id
       FROM unnest($2::text[]) AS t(id)`,
      [workspace.id, seeded]
    )

    const bootstrap = await getWorkspaceBootstrap(client, workspace.id)

    expect(bootstrap.users.map((user) => user.id).sort()).toEqual([...existing, ...seeded].sort())
  })
})
