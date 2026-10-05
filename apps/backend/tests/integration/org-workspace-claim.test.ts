import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import type { OrgWorkspaceClaimRequest, OrgWorkspacePerson } from "@threahq/types"
import { AISpendGate } from "../../src/features/ai-usage"
import { InvitationService } from "../../src/features/invitations"
import {
  PeoplePurposes,
  UserRepository,
  WorkspaceRepository,
  WorkspaceService,
  type AvatarService,
} from "../../src/features/workspaces"
import type { QueueManager } from "../../src/lib/queue"
import { workspaceId } from "../../src/lib/id"
import { TestClient } from "../client"
import { setupTestDatabase } from "./setup"

describe("org workspace claim", () => {
  let pool: Pool
  let workspaceService: WorkspaceService
  let invitations: InvitationService
  const client = new TestClient()
  const workspaces: string[] = []
  const run = crypto.randomUUID().slice(0, 8)
  const unclaimed = { workosUserId: null, role: "member" as const, setupCompleted: false }

  function person(name: string): OrgWorkspacePerson {
    return { name, email: `${name.toLowerCase()}-${run}@acme.example`, externalIdentity: null }
  }

  async function seed(people: OrgWorkspacePerson[]) {
    const id = workspaceId()
    workspaces.push(id)
    const { status } = await client.internalRequest("POST", "/internal/org-workspaces", {
      workspaceId: id,
      name: "Acme",
      slug: `acme-${id}`,
      tier: "connect",
      people,
    })
    expect(status).toBe(200)
    return id
  }

  async function claim(body: OrgWorkspaceClaimRequest) {
    const { status, data } = await client.internalRequest("POST", "/internal/org-workspaces/claim", body)
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

  async function userUpdates(userId: string) {
    const result = await pool.query<{ workosUserId: string; role: string }>(
      `SELECT payload->'user'->>'workosUserId' AS "workosUserId", payload->'user'->>'role' AS role
       FROM outbox WHERE event_type = 'workspace_user:updated' AND payload->'user'->>'id' = $1 ORDER BY id`,
      [userId]
    )
    return result.rows
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    workspaceService = new WorkspaceService(pool, {} as AvatarService, {} as QueueManager)
    invitations = new InvitationService(pool, workspaceService)
  })

  afterAll(async () => {
    for (const table of ["workspace_invitations", "user_external_identities", "stream_members", "streams", "users"]) {
      await pool.query(`DELETE FROM ${table} WHERE workspace_id = ANY($1)`, [workspaces])
    }
    await pool.query("DELETE FROM workspaces WHERE id = ANY($1)", [workspaces])
    await pool.end()
  })

  test("should bind the unclaimed user by email and make them owner when the first claim arrives", async () => {
    const ada = person("Ada")
    const id = await seed([ada, person("Bea")])
    const [adaRow, beaRow] = await people(id)
    const gate = new AISpendGate({ pool })
    const before = await gate.admit({ workspaceId: id, functionId: "message-embedding" })

    const response = await claim({
      workspaceId: id,
      workosUserId: `wos_ada_${run}`,
      email: ada.email!.toUpperCase(),
      name: "Ada Claimed",
      role: "owner",
    })
    const workspace = await WorkspaceRepository.findById(pool, id)

    expect({
      before,
      response,
      createdBy: workspace?.createdBy,
      users: await people(id),
      after: await gate.admit({ workspaceId: id, functionId: "message-embedding" }),
    }).toEqual({
      before: { allowed: false, reason: "workspace_unclaimed" },
      response: { status: 200, data: { workspaceId: id } },
      createdBy: adaRow!.id,
      users: [
        { ...adaRow, workosUserId: `wos_ada_${run}`, role: "owner" },
        { ...beaRow, ...unclaimed },
      ],
      after: { allowed: true },
    })
  })

  test("should bind a member without touching the creator when a later claim arrives", async () => {
    const ada = person("Ada")
    const bea = person("Bea")
    const id = await seed([ada, bea])
    const [adaRow, beaRow] = await people(id)
    await claim({ workspaceId: id, workosUserId: `wos_ada2_${run}`, email: ada.email!, name: "Ada", role: "owner" })

    const response = await claim({
      workspaceId: id,
      workosUserId: `wos_bea2_${run}`,
      email: bea.email!,
      name: "Bea",
      role: "member",
    })
    const repeat = await claim({
      workspaceId: id,
      workosUserId: `wos_bea2_${run}`,
      email: bea.email!,
      name: "Bea",
      role: "member",
    })
    const workspace = await WorkspaceRepository.findById(pool, id)

    expect({ response, repeat, createdBy: workspace?.createdBy, users: await people(id) }).toEqual({
      response: { status: 200, data: { workspaceId: id } },
      repeat: { status: 200, data: { workspaceId: id } },
      createdBy: adaRow!.id,
      users: [
        { ...adaRow, workosUserId: `wos_ada2_${run}`, role: "owner" },
        { ...beaRow, workosUserId: `wos_bea2_${run}`, role: "member" },
      ],
    })
  })

  test("should promote the user self-heal already bound when the owner claim arrives after it", async () => {
    const cy = person("Cy")
    const id = await seed([cy])
    const [cyRow] = await people(id)

    const healed = await workspaceService.ensureUserProvisioned({
      workspaceId: id,
      workosUserId: `wos_cy_${run}`,
      email: cy.email!,
      emailVerified: true,
      name: "Cy Healed",
      role: "member",
    })
    const afterHeal = await people(id)
    const response = await claim({
      workspaceId: id,
      workosUserId: `wos_cy_${run}`,
      email: cy.email!,
      name: "Cy",
      role: "owner",
    })
    const workspace = await WorkspaceRepository.findById(pool, id)

    expect({
      healedId: healed.id,
      afterHeal,
      response,
      createdBy: workspace?.createdBy,
      users: await people(id),
    }).toEqual({
      healedId: cyRow!.id,
      afterHeal: [{ ...cyRow, workosUserId: `wos_cy_${run}`, role: "member" }],
      response: { status: 200, data: { workspaceId: id } },
      createdBy: cyRow!.id,
      users: [{ ...cyRow, workosUserId: `wos_cy_${run}`, role: "owner" }],
    })
  })

  test("should invite an unclaimed person and bind their row when they accept", async () => {
    const owner = person("Owner")
    const dee = person("Dee")
    const id = await seed([owner, dee])
    await claim({
      workspaceId: id,
      workosUserId: `wos_owner_${run}`,
      email: owner.email!,
      name: "Owner",
      role: "owner",
    })
    const [deeRow, ownerRow] = await people(id)

    const sent = await invitations.sendInvitations({
      workspaceId: id,
      invitedBy: ownerRow!.id,
      emails: [dee.email!, owner.email!],
      role: "admin",
    })
    const accepted = await invitations.acceptInvitation(sent.sent[0]!.id, {
      workosUserId: `wos_dee_${run}`,
      email: dee.email!,
      emailVerified: true,
      name: "Dee Accepted",
    })

    expect({
      sent: sent.sent.map((invitation) => invitation.email),
      skipped: sent.skipped,
      accepted,
      users: await people(id),
      deeUpdates: await userUpdates(deeRow!.id),
    }).toEqual({
      sent: [dee.email],
      skipped: [{ email: owner.email, reason: "already_user" }],
      accepted: id,
      users: [
        { ...deeRow, workosUserId: `wos_dee_${run}`, role: "admin" },
        { ...ownerRow, workosUserId: `wos_owner_${run}`, role: "owner" },
      ],
      deeUpdates: [{ workosUserId: `wos_dee_${run}`, role: "admin" }],
    })
  })

  test("should provision a fresh row instead of binding when self-heal sees an unverified email", async () => {
    const eve = person("Eve")
    const id = await seed([eve])
    const [eveRow] = await people(id)

    const healed = await workspaceService.ensureUserProvisioned({
      workspaceId: id,
      workosUserId: `wos_eve_${run}`,
      email: eve.email!,
      emailVerified: false,
      name: "Eve Unverified",
      role: "member",
    })

    expect({ boundUnclaimed: healed.id === eveRow!.id, users: await people(id) }).toEqual({
      boundUnclaimed: false,
      users: [
        eveRow,
        {
          id: healed.id,
          name: "Eve Unverified",
          email: eve.email,
          workosUserId: `wos_eve_${run}`,
          role: "member",
          setupCompleted: false,
        },
      ],
    })
  })

  test("should provision a fresh row instead of binding when an accept carries no verified email", async () => {
    const owner = person("Owner")
    const fay = person("Fay")
    const id = await seed([owner, fay])
    await claim({
      workspaceId: id,
      workosUserId: `wos_owner3_${run}`,
      email: owner.email!,
      name: "Owner",
      role: "owner",
    })
    const [fayRow, ownerRow] = await people(id)
    const sent = await invitations.sendInvitations({
      workspaceId: id,
      invitedBy: ownerRow!.id,
      emails: [fay.email!],
      role: "admin",
    })

    const response = await client.internalRequest("POST", `/internal/invitations/${sent.sent[0]!.id}/accept`, {
      workosUserId: `wos_fay_${run}`,
      email: fay.email!,
      name: "Fay Unverified",
    })
    const users = await people(id)

    expect({ status: response.status, users }).toEqual({
      status: 200,
      users: [
        fayRow,
        {
          id: expect.any(String),
          name: "Fay Unverified",
          email: fay.email,
          workosUserId: `wos_fay_${run}`,
          role: "admin",
          setupCompleted: false,
        },
        ownerRow,
      ],
    })
  })
})
