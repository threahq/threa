import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import type { OrgWorkspaceEnsureRequest, OrgWorkspacePerson } from "@threahq/types"
import {
  PeoplePurposes,
  UserRepository,
  WorkspaceRepository,
  WorkspaceService,
  type AvatarService,
} from "../../src/features/workspaces"
import type { QueueManager } from "../../src/lib/queue"
import { userId, workspaceId } from "../../src/lib/id"
import { TestClient } from "../client"
import { setupTestDatabase } from "./setup"

describe("org workspace ensure endpoint", () => {
  let pool: Pool
  const client = new TestClient()
  const workspaces: string[] = []
  const run = crypto.randomUUID().slice(0, 8)

  function identity(externalUserId: string) {
    return { provider: "slack", externalTeamId: `T${run}`, externalUserId }
  }

  function request(people: OrgWorkspacePerson[], id = workspaces.at(-1)!): OrgWorkspaceEnsureRequest {
    return { workspaceId: id, name: "Acme", slug: `acme-${id}`, tier: "connect", people }
  }

  function newWorkspace(): string {
    const id = workspaceId()
    workspaces.push(id)
    return id
  }

  async function ensure(body: unknown) {
    const { status, data } = await client.internalRequest("POST", "/internal/org-workspaces", body)
    return { status, data }
  }

  async function people(id: string) {
    const users = await UserRepository.listByWorkspace(pool, id, {
      viewer: { kind: "workspace" },
      purpose: PeoplePurposes.VISIBLE,
    })
    return users
      .map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        workosUserId: user.workosUserId,
        role: user.role,
        setupCompleted: user.setupCompleted,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async function identities(id: string) {
    const result = await pool.query<{ external_user_id: string; user_id: string }>(
      `SELECT external_user_id, user_id FROM user_external_identities WHERE workspace_id = $1 ORDER BY external_user_id`,
      [id]
    )
    return result.rows
  }

  /** Resolves once `count` backends are blocked on a lock while running a statement like `pattern`. */
  async function untilBlocked(count: number, pattern: string) {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline; await Bun.sleep(20)) {
      const { rows } = await pool.query<{ blocked: number }>(
        `SELECT count(*)::int AS blocked FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
        [pattern]
      )
      if (rows[0].blocked >= count) return
    }
    throw new Error(`Expected ${count} backends blocked on ${pattern}`)
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    for (const table of ["user_external_identities", "stream_members", "streams", "users"]) {
      await pool.query(`DELETE FROM ${table} WHERE workspace_id = ANY($1)`, [workspaces])
    }
    await pool.query("DELETE FROM workspaces WHERE id = ANY($1)", [workspaces])
    await pool.end()
  })

  test("should hold one unclaimed user per person when two ensures with overlapping people race", async () => {
    const id = newWorkspace()
    const ada = { name: "Ada", email: `ada-${run}@acme.example`, externalIdentity: null }
    const bea = { name: "Bea", email: null, externalIdentity: identity("U_BEA") }
    const cy = { name: "Cy", email: `cy-${run}@acme.example`, externalIdentity: identity("U_CY") }
    const dee = { name: "Dee", email: null, externalIdentity: identity("U_DEE") }

    // A new workspace's PK insert alone would serialize the race; an existing one leaves it to the row lock.
    // Holding that lock until both ensures wait on it makes them overlap.
    await ensure(request([ada]))
    const blocker = await pool.connect()
    let responses
    try {
      await blocker.query("BEGIN")
      await blocker.query("SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE", [id])
      const racing = Promise.all([
        ensure(request([ada, bea, cy])),
        ensure(request([bea, { ...cy, email: cy.email.toUpperCase() }, dee])),
      ])
      await untilBlocked(2, "%FROM workspaces WHERE id%FOR UPDATE%")
      await blocker.query("COMMIT")
      responses = await racing
    } finally {
      blocker.release()
    }
    const workspace = await WorkspaceRepository.findById(pool, id)
    const users = await people(id)
    const idOf: Record<string, string> = Object.fromEntries(users.map((user) => [user.name, user.id]))

    const unclaimed = { workosUserId: null, role: "member" as const, setupCompleted: false }
    expect({
      responses,
      workspace: { createdBy: workspace?.createdBy, tier: workspace?.tier },
      users,
      identities: await identities(id),
    }).toEqual({
      responses: [
        { status: 200, data: { workspaceId: id } },
        { status: 200, data: { workspaceId: id } },
      ],
      workspace: { createdBy: null, tier: "connect" },
      users: [
        { id: expect.any(String), name: "Ada", email: ada.email, ...unclaimed },
        { id: expect.any(String), name: "Bea", email: null, ...unclaimed },
        { id: expect.any(String), name: "Cy", email: cy.email, ...unclaimed },
        { id: expect.any(String), name: "Dee", email: null, ...unclaimed },
      ],
      identities: [
        { external_user_id: "U_BEA", user_id: idOf.Bea },
        { external_user_id: "U_CY", user_id: idOf.Cy },
        { external_user_id: "U_DEE", user_id: idOf.Dee },
      ],
    })
  })

  test("should link the identity to the existing user when an email matches", async () => {
    const id = newWorkspace()
    await ensure(request([]))
    const existing = userId()
    await UserRepository.insert(pool, {
      id: existing,
      workspaceId: id,
      workosUserId: "workos_eve",
      email: `eve-${run}@acme.example`,
      name: "Eve",
      role: "admin",
      slug: "eve",
    })

    const response = await ensure(
      request([{ name: "Eve Slack", email: `EVE-${run}@Acme.example`, externalIdentity: identity("U_EVE") }])
    )

    expect({
      response,
      users: (await people(id)).map((user) => user.id),
      identities: await identities(id),
    }).toEqual({
      response: { status: 200, data: { workspaceId: id } },
      users: [existing],
      identities: [{ external_user_id: "U_EVE", user_id: existing }],
    })
  })

  test("should keep the identity's user when a later ensure sends that identity with another email", async () => {
    const id = newWorkspace()
    const cy = { name: "Cy", email: `cy-${run}@acme.example`, externalIdentity: identity("U_CY") }
    await ensure(request([cy]))
    const before = await people(id)

    await ensure(request([{ ...cy, email: `cy-new-${run}@acme.example` }]))

    expect({ users: await people(id), identities: await identities(id) }).toEqual({
      users: before,
      identities: [{ external_user_id: "U_CY", user_id: before[0]?.id }],
    })
  })

  test("should create the person again when a later ensure names a removed user's identity", async () => {
    const id = newWorkspace()
    const bea = { name: "Bea", email: null, externalIdentity: identity("U_BEA") }
    await ensure(request([bea]))
    const [removed] = await people(id)
    await new WorkspaceService(pool, {} as AvatarService, {} as QueueManager).removeUser(id, removed.id)

    const response = await ensure(request([bea]))
    const users = await people(id)

    expect({ response, users, identities: await identities(id) }).toEqual({
      response: { status: 200, data: { workspaceId: id } },
      users: [{ ...removed, id: expect.not.stringMatching(removed.id) }],
      identities: [{ external_user_id: "U_BEA", user_id: users[0]?.id }],
    })
  })

  test("should leave no identity behind when a removal waits on an ensure that links the removed user", async () => {
    const id = newWorkspace()
    const dee = { name: "Dee", email: `dee-${run}@acme.example`, externalIdentity: null }
    await ensure(request([dee]))
    const [removed] = await people(id)
    const blocker = await pool.connect()
    try {
      await blocker.query("BEGIN")
      await blocker.query("SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE", [id])
      const linking = ensure(request([{ ...dee, externalIdentity: identity("U_DEE") }]))
      await untilBlocked(1, "%FROM workspaces WHERE id%FOR UPDATE%")
      const removal = new WorkspaceService(pool, {} as AvatarService, {} as QueueManager).removeUser(id, removed.id)
      await untilBlocked(2, "%FROM workspaces WHERE id%FOR UPDATE%")
      await blocker.query("COMMIT")
      await Promise.all([linking, removal])
    } finally {
      blocker.release()
    }

    expect({ users: await people(id), identities: await identities(id) }).toEqual({ users: [], identities: [] })
  })

  test("should reject the request without writing when it has an unknown field or a person with neither email nor identity", async () => {
    const id = newWorkspace()
    const ada = { name: "Ada", email: `ada-${run}@acme.example`, externalIdentity: null }

    const responses = [
      await ensure({ ...request([ada]), extra: true }),
      await ensure(request([{ ...ada, email: null }])),
    ]

    expect({
      statuses: responses.map((response) => response.status),
      codes: responses.map((response) => (response.data as { code?: string }).code),
      workspace: await WorkspaceRepository.findById(pool, id),
    }).toEqual({ statuses: [400, 400], codes: ["VALIDATION_ERROR", "VALIDATION_ERROR"], workspace: null })
  })
})
