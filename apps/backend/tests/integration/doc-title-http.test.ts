import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { getTestDatabaseTarget } from "../test-database"
import { TestClient, createChannel, createWorkspace, joinWorkspace, loginAs } from "../client"

const runId = Math.random().toString(36).slice(2, 8)

describe("doc title over HTTP", () => {
  let pool: Pool
  let workspaceId: string
  let docId: string
  const owner = new TestClient()
  const outsider = new TestClient()

  beforeAll(async () => {
    pool = new Pool({ connectionString: getTestDatabaseTarget().connectionUrl })
    await loginAs(owner, `doc-title-owner-${runId}@test.com`, "Owner")
    workspaceId = (await createWorkspace(owner, `Doc title ${runId}`)).id
    const host = await createChannel(owner, workspaceId, `docs-${runId}`)
    const created = await owner.post<{ stream: { id: string } }>(`/api/workspaces/${workspaceId}/streams`, {
      type: "doc",
      parentStreamId: host.id,
    })
    expect(created.status).toBe(201)
    docId = created.data.stream.id
    await loginAs(outsider, `doc-title-outsider-${runId}@test.com`, "Outsider")
    await joinWorkspace(outsider, workspaceId, "member")
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should rename a doc for a host member and refuse the settings a doc inherits from its host", async () => {
    const renamed = await owner.patch<{ stream: { displayName: string; displayNameSource: string } }>(
      `/api/workspaces/${workspaceId}/streams/${docId}`,
      { displayName: "Launch plan" }
    )
    const slug = await owner.patch(`/api/workspaces/${workspaceId}/streams/${docId}`, {
      slug: "launch-plan",
    })
    const description = await owner.patch<{ code: string }>(`/api/workspaces/${workspaceId}/streams/${docId}`, {
      description: "Plans",
    })
    const hijack = await outsider.patch(`/api/workspaces/${workspaceId}/streams/${docId}`, { displayName: "Hijacked" })
    const row = await pool.query("SELECT display_name FROM streams WHERE workspace_id = $1 AND id = $2", [
      workspaceId,
      docId,
    ])
    expect({
      renamed: { status: renamed.status, stream: renamed.data.stream },
      slug: slug.status,
      description: { status: description.status, code: description.data.code },
      hijack: hijack.status,
      stored: row.rows[0],
    }).toMatchObject({
      renamed: { status: 200, stream: { displayName: "Launch plan", displayNameSource: "explicit" } },
      slug: 400,
      description: { status: 400, code: "DOC_HAS_NO_DESCRIPTION" },
      hijack: 404,
      stored: { display_name: "Launch plan" },
    })
  })

  test("should create a doc with the title it is given as an explicit name", async () => {
    const host = await createChannel(owner, workspaceId, `titled-${runId}`)
    const created = await owner.post<{ stream: { id: string; displayName: string; displayNameSource: string } }>(
      `/api/workspaces/${workspaceId}/streams`,
      { type: "doc", parentStreamId: host.id, displayName: "Q4 findings" }
    )
    const row = await pool.query("SELECT display_name FROM streams WHERE workspace_id = $1 AND id = $2", [
      workspaceId,
      created.data.stream.id,
    ])
    expect({ status: created.status, stream: created.data.stream, stored: row.rows[0] }).toMatchObject({
      status: 201,
      stream: { displayName: "Q4 findings", displayNameSource: "explicit" },
      stored: { display_name: "Q4 findings" },
    })
  })
})
