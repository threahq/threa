/**
 * HTTP capture integration: the audit middleware writes access_log rows on
 * response finish. Boots the real server (setup.ts preload) and reads rows back
 * from threa_test. Rows are fire-and-forget on `res.on("finish")`, so every
 * assertion polls briefly for the row to land.
 *
 * Run: bun test --preload ./tests/setup.ts tests/integration/access-log-http.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import {
  TestClient,
  loginAs,
  createWorkspace,
  createScratchpad,
  sendMessage,
  getUserId,
  joinWorkspace,
} from "../client"

interface AccessLogDbRow {
  workspace_id: string | null
  actor_type: string
  actor_id: string
  operation: string
  access_kind: string
  outcome: string
  subjects: { type: string; id?: string }[] | null
  request_id: string | null
}

const testRunId = Math.random().toString(36).slice(2, 8)
const email = (name: string) => `${name}-${testRunId}@test.com`

describe("access-log HTTP capture", () => {
  let pool: Pool

  beforeAll(() => {
    pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL || "postgresql://threa:threa@localhost:5454/threa_test",
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  async function pollRow(
    where: string,
    params: unknown[],
    predicate: (rows: AccessLogDbRow[]) => boolean = (rows) => rows.length > 0
  ): Promise<AccessLogDbRow[]> {
    for (let attempt = 0; attempt < 40; attempt++) {
      const { rows } = await pool.query<AccessLogDbRow>(
        `SELECT workspace_id, actor_type, actor_id, operation, access_kind, outcome, subjects, request_id
         FROM access_log WHERE ${where} ORDER BY occurred_at DESC`,
        params
      )
      if (predicate(rows)) return rows
      await new Promise((r) => setTimeout(r, 50))
    }
    return []
  }

  test("annotated read (stream bootstrap) records actor/workspace/operation/kind/outcome/subjects", async () => {
    const client = new TestClient()
    const user = await loginAs(client, email("reader"), "Reader")
    const ws = await createWorkspace(client, "Reader WS")
    const stream = await createScratchpad(client, ws.id)
    const userId = await getUserId(client, ws.id, user.id)

    const { status } = await client.get(`/api/workspaces/${ws.id}/streams/${stream.id}/bootstrap`)
    expect(status).toBe(200)

    const rows = await pollRow("workspace_id = $1 AND operation = 'streams.bootstrap' AND actor_id = $2", [
      ws.id,
      userId,
    ])
    expect(rows.length).toBeGreaterThan(0)
    const row = rows[0]
    expect(row).toMatchObject({
      workspace_id: ws.id,
      actor_type: "user",
      actor_id: userId,
      operation: "streams.bootstrap",
      access_kind: "read",
      outcome: "success",
    })
    // request_id (pino genReqId) is populated.
    expect(row.request_id).toBeTruthy()
    // Subjects carry the stream ref (a range read), never content.
    expect(row.subjects).toEqual(expect.arrayContaining([expect.objectContaining({ type: "stream", id: stream.id })]))
  })

  test("access-hiding 404 records outcome 'denied'", async () => {
    const client = new TestClient()
    const user = await loginAs(client, email("denied"), "Denied")
    const ws = await createWorkspace(client, "Denied WS")
    const userId = await getUserId(client, ws.id, user.id)

    const { status } = await client.get(`/api/workspaces/${ws.id}/streams/stream_does_not_exist/bootstrap`)
    expect(status).toBe(404)

    const rows = await pollRow(
      "workspace_id = $1 AND operation = 'streams.bootstrap' AND actor_id = $2 AND outcome = 'denied'",
      [ws.id, userId]
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].access_kind).toBe("read")
  })

  test("mutation records access_kind 'write'", async () => {
    const client = new TestClient()
    const user = await loginAs(client, email("writer"), "Writer")
    const ws = await createWorkspace(client, "Writer WS")
    const stream = await createScratchpad(client, ws.id)
    const userId = await getUserId(client, ws.id, user.id)

    await sendMessage(client, ws.id, stream.id, "hello audit")

    const rows = await pollRow("workspace_id = $1 AND operation = 'messages.create' AND actor_id = $2", [ws.id, userId])
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toMatchObject({ access_kind: "write", outcome: "success", actor_type: "user" })
  })

  test("workspace-less auth surface (/api/auth/me) records a row with null workspace, WorkOS actor", async () => {
    const client = new TestClient()
    const user = await loginAs(client, email("mereader"), "MeReader")

    const { status } = await client.get("/api/auth/me")
    expect(status).toBe(200)

    const rows = await pollRow("operation = 'auth.me' AND actor_id = $1", [user.id])
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toMatchObject({
      workspace_id: null,
      actor_type: "user",
      actor_id: user.id,
      operation: "auth.me",
      access_kind: "read",
      outcome: "success",
    })
  })

  test("unauthenticated hit on an annotated route writes no success row", async () => {
    const owner = new TestClient()
    const ownerUser = await loginAs(owner, email("owner"), "Owner")
    const ws = await createWorkspace(owner, "Unauth WS")
    const ownerId = await getUserId(owner, ws.id, ownerUser.id)

    const anon = new TestClient()
    const { status } = await anon.get(`/api/workspaces/${ws.id}/bootstrap`)
    expect(status).toBe(401)

    // Control: an authed hit on the same operation DOES record — proving the
    // pipeline works for this op, so the absence below is meaningful rather
    // than vacuous.
    const ownerRes = await owner.get(`/api/workspaces/${ws.id}/bootstrap`)
    expect(ownerRes.status).toBe(200)
    const ownerRows = await pollRow("workspace_id = $1 AND operation = 'workspace.bootstrap' AND actor_id = $2", [
      ws.id,
      ownerId,
    ])
    expect(ownerRows.length).toBeGreaterThan(0)

    // `auth` short-circuits before the audit middleware registers its finish
    // hook, so the unauthenticated hit itself produced no row: every row for
    // this op belongs to the owner.
    const { rows } = await pool.query<AccessLogDbRow>(
      "SELECT actor_id, outcome FROM access_log WHERE workspace_id = $1 AND operation = 'workspace.bootstrap'",
      [ws.id]
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.actor_id === ownerId && r.outcome === "success")).toBe(true)
  })

  test("cross-workspace probe (workspaceUser 403) records a boundary denial row", async () => {
    const owner = new TestClient()
    await loginAs(owner, email("target-owner"), "Target Owner")
    const targetWs = await createWorkspace(owner, "Target WS")

    const outsiderClient = new TestClient()
    const outsider = await loginAs(outsiderClient, email("outsider"), "Outsider")
    await createWorkspace(outsiderClient, "Outsider WS")

    const { status } = await outsiderClient.get(`/api/workspaces/${targetWs.id}/streams`)
    expect(status).toBe(403)

    // workspaceUser denied before the route-level audit ran; the boundary
    // backstop must have recorded the probe, attributed to the WorkOS user.
    const rows = await pollRow(
      "workspace_id = $1 AND operation = 'auth.boundary_denied' AND actor_id = $2 AND outcome = 'denied'",
      [targetWs.id, outsider.id]
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].subjects).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "workspace", id: targetWs.id })])
    )
  })

  test("bad public-API key records a boundary denial row", async () => {
    const owner = new TestClient()
    await loginAs(owner, email("api-owner"), "Api Owner")
    const ws = await createWorkspace(owner, "Api WS")

    const anon = new TestClient()
    const { status } = await anon.request("GET", `/api/v1/workspaces/${ws.id}/streams`, undefined, {
      Authorization: "Bearer threa_uk_bogus_key_value",
    })
    expect(status).toBe(401)

    const rows = await pollRow(
      "workspace_id = $1 AND operation = 'auth.boundary_denied' AND actor_id = 'unknown' AND outcome = 'denied'",
      [ws.id]
    )
    expect(rows.length).toBeGreaterThan(0)
  })

  test("permission-guard 403 records outcome 'denied' (audit runs before requireX guards)", async () => {
    const owner = new TestClient()
    await loginAs(owner, email("guard-owner"), "Guard Owner")
    const ws = await createWorkspace(owner, "Guard WS")

    const memberClient = new TestClient()
    const member = await loginAs(memberClient, email("guard-member"), "Guard Member")
    await joinWorkspace(memberClient, ws.id)
    const memberId = await getUserId(memberClient, ws.id, member.id)

    const { status } = await memberClient.patch(`/api/workspaces/${ws.id}/workspace-settings`, {
      defaultCompanionPersonaId: null,
    })
    expect(status).toBe(403)

    const rows = await pollRow(
      "workspace_id = $1 AND operation = 'workspace_settings.update' AND actor_id = $2 AND outcome = 'denied'",
      [ws.id, memberId]
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].access_kind).toBe("write")
  })
})
