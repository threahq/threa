/**
 * Renaming a workspace against the real server and schema: only admins may, the name follows the
 * creation rule, the new name persists with its broadcast event, and the control-plane mirror
 * pushes the current name rather than the one an older event carried.
 *
 * Run: bun test --preload ./tests/setup.ts tests/integration/workspace-rename.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { WORKSPACE_NAME_MAX_LENGTH, type Workspace } from "@threahq/types"
import { WorkspaceNameSyncHandler } from "../../src/features/workspaces"
import type { ControlPlaneClient } from "../../src/lib/control-plane-client"
import type { OutboxEvent } from "../../src/lib/outbox"
import { TestClient, createWorkspace, joinWorkspace, loginAs } from "../client"
import { createTestServerPool } from "./setup"

const runId = Math.random().toString(36).slice(2, 8)
let personCount = 0

describe("workspace rename", () => {
  let pool: Pool

  beforeAll(() => {
    pool = createTestServerPool()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function person(label: string) {
    personCount += 1
    const client = new TestClient()
    await loginAs(client, `${label}-${personCount}-${runId}@test.com`, `${label} ${personCount}`)
    return client
  }

  async function newWorkspace() {
    const owner = await person("owner")
    const workspace = await createWorkspace(owner, `Rename ${runId}`)
    return { owner, workspaceId: workspace.id }
  }

  function rename(client: TestClient, workspaceId: string, body: unknown) {
    return client.patch<{ workspace?: Workspace; code?: string }>(`/api/workspaces/${workspaceId}`, body)
  }

  async function storedName(workspaceId: string): Promise<string> {
    const result = await pool.query<{ name: string }>("SELECT name FROM workspaces WHERE id = $1", [workspaceId])
    return result.rows[0].name
  }

  async function nameEvents(workspaceId: string): Promise<unknown[]> {
    const result = await pool.query<{ payload: unknown }>(
      "SELECT payload FROM outbox WHERE event_type = 'workspace:name_updated' AND payload->>'workspaceId' = $1 ORDER BY id",
      [workspaceId]
    )
    return result.rows.map((row) => row.payload)
  }

  test("an admin's rename persists trimmed and emits the broadcast event", async () => {
    const { owner, workspaceId } = await newWorkspace()

    const { status, data } = await rename(owner, workspaceId, { name: "  Acme Research  " })
    const { data: fetched } = await owner.get<{ workspace: Workspace }>(`/api/workspaces/${workspaceId}`)

    expect({
      status,
      returned: data.workspace?.name,
      fetched: fetched.workspace.name,
      stored: await storedName(workspaceId),
      events: await nameEvents(workspaceId),
    }).toEqual({
      status: 200,
      returned: "Acme Research",
      fetched: "Acme Research",
      stored: "Acme Research",
      events: [{ workspaceId, name: "Acme Research" }],
    })
  })

  test("a member who is not an admin is refused and the name stays", async () => {
    const { workspaceId } = await newWorkspace()
    const member = await person("member")
    await joinWorkspace(member, workspaceId, "member")

    const { status } = await rename(member, workspaceId, { name: "Taken over" })

    expect({ status, stored: await storedName(workspaceId), events: await nameEvents(workspaceId) }).toEqual({
      status: 403,
      stored: `Rename ${runId}`,
      events: [],
    })
  })

  test("a signed-out request is refused", async () => {
    const { workspaceId } = await newWorkspace()

    const { status } = await rename(new TestClient(), workspaceId, { name: "Anonymous" })

    expect(status).toBe(401)
  })

  test("names outside the creation rule are rejected without a write", async () => {
    const { owner, workspaceId } = await newWorkspace()

    const statuses = await Promise.all(
      [
        { name: "   " },
        { name: "x".repeat(WORKSPACE_NAME_MAX_LENGTH + 1) },
        { name: "Fine", slug: "not-allowed" },
        {},
      ].map(async (body) => (await rename(owner, workspaceId, body)).status)
    )

    expect({ statuses, stored: await storedName(workspaceId), events: await nameEvents(workspaceId) }).toEqual({
      statuses: [400, 400, 400, 400],
      stored: `Rename ${runId}`,
      events: [],
    })
  })

  test("the control-plane mirror pushes the current name, even for an older event", async () => {
    const { owner, workspaceId } = await newWorkspace()
    await rename(owner, workspaceId, { name: "First" })
    await rename(owner, workspaceId, { name: "Second" })

    const pushed: unknown[] = []
    const controlPlaneClient = {
      async syncWorkspaceName(params: unknown) {
        pushed.push(params)
      },
    } as unknown as ControlPlaneClient
    const handler = new WorkspaceNameSyncHandler(pool, controlPlaneClient)
    const staleEvent = {
      id: 1n,
      eventType: "workspace:name_updated",
      payload: { workspaceId, name: "First" },
      createdAt: new Date(),
    } as unknown as OutboxEvent
    await (handler as unknown as { processEvent(event: OutboxEvent): Promise<void> }).processEvent(staleEvent)

    expect(pushed).toEqual([{ workspaceId, name: "Second" }])
  })
})
