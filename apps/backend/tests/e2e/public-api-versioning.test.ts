/**
 * E2E tests for public API header versioning (Phase 1).
 *
 * Verifies the `Threa-Version` echo header, header-override-beats-pin
 * precedence, the 400 on an unknown version, and that freshly minted keys
 * carry the epoch pin in the database.
 *
 * Run with: bun test --preload ./tests/setup.ts tests/e2e/public-api-versioning.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { TestClient, createWorkspace, loginAs } from "../client"
import { createTestPool } from "../integration/setup"
import { CURRENT_API_VERSION } from "../../src/features/public-api/versions"

const testRunId = Math.random().toString(36).substring(7)
const baseUrl = () => process.env.TEST_BASE_URL || "http://localhost:3001"

interface Ctx {
  workspaceId: string
  botKey: string
  botKeyId: string
  userKeyId: string
}

async function createBotKey(client: TestClient, workspaceId: string, botId: string, name: string, scopes: string[]) {
  const res = await client.post<{ value: string; id?: string }>(`/api/workspaces/${workspaceId}/bots/${botId}/keys`, {
    name,
    scopes,
  })
  return (res.data as { value: string }).value
}

let pool: Pool

async function setup(): Promise<Ctx> {
  const client = new TestClient()
  await loginAs(client, `ver-${testRunId}@test.com`, `VerUser ${testRunId}`)
  const workspace = await createWorkspace(client, `Ver WS ${testRunId}`)

  const botRes = await client.post(`/api/workspaces/${workspace.id}/bots`, {
    type: "shared",
    name: `Ver Bot ${testRunId}`,
    slug: `ver-bot-${testRunId}`,
  })
  const botId = (botRes.data as { data: { id: string } }).data.id
  const botKey = await createBotKey(client, workspace.id, botId, "ver", ["messages:read"])

  const userKeyRes = await client.post<{ key: { id: string }; value: string }>(
    `/api/workspaces/${workspace.id}/user-api-keys`,
    { name: `ver-user-${testRunId}`, scopes: ["messages:search"] }
  )
  const userKeyId = (userKeyRes.data as { key: { id: string } }).key.id

  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM bot_api_keys WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [workspace.id]
  )

  return { workspaceId: workspace.id, botKey, botKeyId: rows[0].id, userKeyId }
}

describe("Public API header versioning", () => {
  let ctx: Ctx

  beforeAll(async () => {
    pool = createTestPool()
    ctx = await setup()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("echoes the resolved version and defaults to the key pin when no header is sent", async () => {
    const res = await fetch(`${baseUrl()}/api/v1/workspaces/${ctx.workspaceId}/me`, {
      headers: { Authorization: `Bearer ${ctx.botKey}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("Threa-Version")).toBe(CURRENT_API_VERSION)
  })

  test("a valid header override is accepted and echoed", async () => {
    const res = await fetch(`${baseUrl()}/api/v1/workspaces/${ctx.workspaceId}/me`, {
      headers: { Authorization: `Bearer ${ctx.botKey}`, "Threa-Version": CURRENT_API_VERSION },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("Threa-Version")).toBe(CURRENT_API_VERSION)
  })

  test("an unknown version header is rejected with 400 INVALID_API_VERSION", async () => {
    const res = await fetch(`${baseUrl()}/api/v1/workspaces/${ctx.workspaceId}/me`, {
      headers: { Authorization: `Bearer ${ctx.botKey}`, "Threa-Version": "2099-01-01" },
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe("INVALID_API_VERSION")
  })

  test("a freshly minted bot key row carries the epoch pin", async () => {
    const { rows } = await pool.query<{ api_version: string }>(`SELECT api_version FROM bot_api_keys WHERE id = $1`, [
      ctx.botKeyId,
    ])
    expect(rows[0].api_version).toBe(CURRENT_API_VERSION)
  })

  test("a freshly minted user key row carries the epoch pin", async () => {
    const { rows } = await pool.query<{ api_version: string }>(`SELECT api_version FROM user_api_keys WHERE id = $1`, [
      ctx.userKeyId,
    ])
    expect(rows[0].api_version).toBe(CURRENT_API_VERSION)
  })
})
