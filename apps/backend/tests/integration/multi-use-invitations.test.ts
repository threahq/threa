import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { InvitationRepository } from "../../src/features/invitations/repository"
import { hashInvitationToken, InvitationService } from "../../src/features/invitations/service"
import { InvitationShadowSyncHandler } from "../../src/features/invitations/shadow-sync-outbox-handler"
import type { ControlPlaneClient } from "../../src/lib/control-plane-client"
import type { OutboxEvent } from "../../src/lib/outbox"
import { UserRepository, WorkspaceRepository, WorkspaceService } from "../../src/features/workspaces"
import { invitationId, userId, workspaceId } from "../../src/lib/id"
import { setupIsolatedTestDatabase } from "./setup"

interface Fixture {
  pool: Pool
  cleanup: () => Promise<void>
  workspaceId: string
  inviterId: string
  service: InvitationService
}

async function createFixture(): Promise<Fixture> {
  const isolated = await setupIsolatedTestDatabase("multi_use_invites")
  const workspace = workspaceId()
  const inviter = userId()
  await WorkspaceRepository.insert(isolated.pool, {
    id: workspace,
    name: "Invite test workspace",
    slug: `invite-${workspace}`,
    createdBy: inviter,
  })
  await UserRepository.insert(isolated.pool, {
    id: inviter,
    workspaceId: workspace,
    workosUserId: `workos_${inviter}`,
    email: `${inviter.toLowerCase()}@example.com`,
    name: "Invite admin",
    role: "admin",
    slug: `invite-admin-${inviter}`,
  })
  return {
    pool: isolated.pool,
    cleanup: isolated.cleanup,
    workspaceId: workspace,
    inviterId: inviter,
    service: new InvitationService(isolated.pool, new WorkspaceService(isolated.pool, {} as never, {} as never)),
  }
}

async function claim(fixture: Fixture, token: string, email: string): Promise<string> {
  const result = await fixture.service.claimLinkByToken(token, email)
  if (!result.invitationId) throw new Error(`claim did not create a child for ${email}`)
  return result.invitationId
}

class TestShadowSyncHandler extends InvitationShadowSyncHandler {
  process(event: OutboxEvent) {
    return this.processEvent(event)
  }
}

function identity(index: number) {
  return {
    workosUserId: `workos_joiner_${index}`,
    email: `joiner-${index}@example.com`,
    name: `Joiner ${index}`,
  }
}

describe("multi-use invitation lifecycle", () => {
  let fixture: Fixture

  beforeAll(
    async () => {
      fixture = await createFixture()
    },
    { timeout: 120_000 }
  )

  afterAll(async () => {
    if (fixture) await fixture.cleanup()
  })

  test("should preserve the existing email invitation acceptance path", async () => {
    const email = "email-invite@example.com"
    const sent = await fixture.service.sendInvitations({
      workspaceId: fixture.workspaceId,
      invitedBy: fixture.inviterId,
      emails: [email],
      role: "member",
    })

    await expect(
      fixture.service.acceptInvitation(sent.sent[0].id, {
        workosUserId: "workos_email_invite",
        email,
        name: "Email Invite",
      })
    ).resolves.toBe(fixture.workspaceId)
    expect(await InvitationRepository.findById(fixture.pool, sent.sent[0].id)).toMatchObject({
      kind: "email",
      status: "accepted",
      maxUses: null,
      useCount: 0,
    })
  })

  test("should allow exactly two successful concurrent joins when maxUses is two", async () => {
    const created = await fixture.service.createLink({
      workspaceId: fixture.workspaceId,
      invitedBy: fixture.inviterId,
      role: "member",
      note: null,
      maxUses: 2,
      expiresAt: null,
    })
    const identities = [identity(1), identity(2), identity(3)]
    const children = await Promise.all(identities.map((candidate) => claim(fixture, created.token, candidate.email)))
    const results = await Promise.allSettled(
      children.map((childId, index) => fixture.service.acceptInvitation(childId, identities[index]))
    )

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect((await InvitationRepository.findById(fixture.pool, created.invitation.id))?.useCount).toBe(2)
  })

  test("should allow multiple unlimited joins and preserve completed-join replay", async () => {
    const created = await fixture.service.createLink({
      workspaceId: fixture.workspaceId,
      invitedBy: fixture.inviterId,
      role: "member",
      note: null,
      maxUses: null,
      expiresAt: null,
    })
    const candidates = [identity(10), identity(11), identity(12)]
    const children = await Promise.all(candidates.map((candidate) => claim(fixture, created.token, candidate.email)))
    await Promise.all(children.map((childId, index) => fixture.service.acceptInvitation(childId, candidates[index])))
    const joinedRoles = await fixture.pool.query<{ role: string }>(
      "SELECT role FROM users WHERE workspace_id = $1 AND workos_user_id = ANY($2) ORDER BY role",
      [fixture.workspaceId, candidates.map((candidate) => candidate.workosUserId)]
    )
    expect(joinedRoles.rows).toEqual([{ role: "member" }, { role: "member" }, { role: "member" }])
    await fixture.service.revokeInvitation(created.invitation.id, fixture.workspaceId)

    await expect(fixture.service.acceptInvitation(children[0], candidates[0])).resolves.toBe(fixture.workspaceId)
    expect((await InvitationRepository.findById(fixture.pool, created.invitation.id))?.useCount).toBe(3)
  })

  test("should not count wrong-email, duplicate, or existing-member paths", async () => {
    const created = await fixture.service.createLink({
      workspaceId: fixture.workspaceId,
      invitedBy: fixture.inviterId,
      role: "member",
      note: null,
      maxUses: 3,
      expiresAt: null,
    })
    const candidate = identity(20)
    const childId = await claim(fixture, created.token, candidate.email)

    await expect(
      fixture.service.acceptInvitation(childId, { ...candidate, email: "wrong@example.com" })
    ).rejects.toMatchObject({ code: "INVITATION_EMAIL_MISMATCH" })
    expect((await InvitationRepository.findById(fixture.pool, created.invitation.id))?.useCount).toBe(0)

    await fixture.service.acceptInvitation(childId, candidate)
    await fixture.service.acceptInvitation(childId, candidate)
    expect((await InvitationRepository.findById(fixture.pool, created.invitation.id))?.useCount).toBe(1)

    const existingEmail = `${fixture.inviterId.toLowerCase()}@example.com`
    await expect(fixture.service.claimLinkByToken(created.token, existingEmail)).resolves.toEqual({
      alreadyMember: { workspaceId: fixture.workspaceId },
    })
    expect((await InvitationRepository.findById(fixture.pool, created.invitation.id))?.useCount).toBe(1)
  })

  test("should emit a fresh claim for a removed user whose durable user row remains", async () => {
    const removedUserId = userId()
    const email = "removed-rejoin@example.com"
    await UserRepository.insert(fixture.pool, {
      id: removedUserId,
      workspaceId: fixture.workspaceId,
      workosUserId: "workos_removed_rejoin",
      email,
      name: "Removed Rejoin",
      role: "member",
      slug: `removed-${removedUserId}`,
    })
    await fixture.pool.query("DELETE FROM workspace_user_permissions WHERE workspace_id = $1 AND workos_user_id = $2", [
      fixture.workspaceId,
      "workos_removed_rejoin",
    ])
    const created = await fixture.service.createLink({
      workspaceId: fixture.workspaceId,
      invitedBy: fixture.inviterId,
      role: "member",
      note: null,
      maxUses: 2,
      expiresAt: null,
    })

    await expect(fixture.service.claimLinkByToken(created.token, email)).resolves.toEqual({
      alreadyMember: { workspaceId: fixture.workspaceId },
    })
    const child = await InvitationRepository.findLinkChild(fixture.pool, created.invitation.id, email)
    expect(child).toMatchObject({ email, status: "pending", parentLinkId: created.invitation.id })
    const event = await fixture.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox
       WHERE event_type = 'invitation:link-claimed' AND payload->>'invitationId' = $1`,
      [child?.id]
    )
    expect(event.rows[0]?.payload).toMatchObject({ invitationId: child?.id, email })
  })

  test("should count one join when the same user accepts children from two links concurrently", async () => {
    const first = await fixture.service.createLink({
      workspaceId: fixture.workspaceId,
      invitedBy: fixture.inviterId,
      role: "member",
      note: null,
      maxUses: 2,
      expiresAt: null,
    })
    const second = await fixture.service.createLink({
      workspaceId: fixture.workspaceId,
      invitedBy: fixture.inviterId,
      role: "member",
      note: null,
      maxUses: 2,
      expiresAt: null,
    })
    const candidate = identity(30)
    const [firstChild, secondChild] = await Promise.all([
      claim(fixture, first.token, candidate.email),
      claim(fixture, second.token, candidate.email),
    ])

    await Promise.all([
      fixture.service.acceptInvitation(firstChild, candidate),
      fixture.service.acceptInvitation(secondChild, candidate),
    ])
    const [firstRoot, secondRoot] = await Promise.all([
      InvitationRepository.findById(fixture.pool, first.invitation.id),
      InvitationRepository.findById(fixture.pool, second.invitation.id),
    ])
    expect((firstRoot?.useCount ?? 0) + (secondRoot?.useCount ?? 0)).toBe(1)
  })

  test("should preserve legacy roots, revive expiry, block revoked links, and apply parent extension to children", async () => {
    const claimedToken = "legacy-claimed-token"
    const claimedId = invitationId()
    await fixture.pool.query(
      `INSERT INTO workspace_invitations
         (id, workspace_id, kind, email, role, invited_by, token_hash, status, expires_at, max_uses)
       VALUES ($1, $2, 'link', 'legacy-claimed@example.com', 'member', $3, $4, 'pending', NOW() + INTERVAL '1 day', 1)`,
      [claimedId, fixture.workspaceId, fixture.inviterId, hashInvitationToken(claimedToken)]
    )
    await expect(fixture.service.claimLinkByToken(claimedToken, "legacy-claimed@example.com")).resolves.toEqual({
      invitationId: claimedId,
    })
    await expect(fixture.service.claimLinkByToken(claimedToken, "other@example.com")).rejects.toMatchObject({
      code: "INVITATION_EXHAUSTED",
    })

    const pendingToken = "legacy-pending-token"
    const pendingId = invitationId()
    await fixture.pool.query(
      `INSERT INTO workspace_invitations
         (id, workspace_id, kind, email, role, invited_by, token_hash, status, expires_at, max_uses)
       VALUES ($1, $2, 'link', NULL, 'member', $3, $4, 'expired', NOW() - INTERVAL '1 day', 1)`,
      [pendingId, fixture.workspaceId, fixture.inviterId, hashInvitationToken(pendingToken)]
    )
    await expect(fixture.service.claimLinkByToken(pendingToken, "legacy-new@example.com")).rejects.toMatchObject({
      code: "INVITATION_EXPIRED",
    })
    const revived = await fixture.service.updateLink({
      workspaceId: fixture.workspaceId,
      invitationId: pendingId,
      expiresAt: new Date(Date.now() + 60_000),
      maxUses: 2,
    })
    expect(revived?.status).toBe("pending")
    const childId = await claim(fixture, pendingToken, "legacy-new@example.com")
    await fixture.pool.query("UPDATE workspace_invitations SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1", [
      childId,
    ])
    await fixture.service.updateLink({
      workspaceId: fixture.workspaceId,
      invitationId: pendingId,
      expiresAt: new Date(Date.now() + 120_000),
    })
    await expect(
      fixture.service.acceptInvitation(childId, {
        workosUserId: "workos_legacy_new",
        email: "legacy-new@example.com",
        name: "Legacy New",
      })
    ).resolves.toBe(fixture.workspaceId)
    const outstandingId = await claim(fixture, pendingToken, "outstanding@example.com")

    await fixture.service.revokeInvitation(pendingId, fixture.workspaceId)
    await expect(
      fixture.service.acceptInvitation(outstandingId, {
        workosUserId: "workos_outstanding",
        email: "outstanding@example.com",
        name: "Outstanding",
      })
    ).rejects.toMatchObject({ code: "INVITATION_REVOKED" })
    await expect(
      fixture.service.updateLink({ workspaceId: fixture.workspaceId, invitationId: pendingId, maxUses: 3 })
    ).resolves.toBeNull()
    await expect(fixture.service.claimLinkByToken(pendingToken, "blocked@example.com")).rejects.toMatchObject({
      code: "INVITATION_REVOKED",
    })
    await expect(
      fixture.service.updateLink({ workspaceId: workspaceId(), invitationId: pendingId, maxUses: 3 })
    ).resolves.toBeNull()
  })

  test("should serialize simultaneous accept, revoke, and edit without partial capacity state", async () => {
    const created = await fixture.service.createLink({
      workspaceId: fixture.workspaceId,
      invitedBy: fixture.inviterId,
      role: "member",
      note: null,
      maxUses: 1,
      expiresAt: null,
    })
    const candidate = identity(40)
    const childId = await claim(fixture, created.token, candidate.email)

    const [acceptResult, revokeResult] = await Promise.allSettled([
      fixture.service.acceptInvitation(childId, candidate),
      fixture.service.revokeInvitation(created.invitation.id, fixture.workspaceId),
      fixture.service.updateLink({
        workspaceId: fixture.workspaceId,
        invitationId: created.invitation.id,
        maxUses: 2,
      }),
    ])

    expect(revokeResult).toEqual({ status: "fulfilled", value: true })
    const [parent, acceptedChild] = await Promise.all([
      InvitationRepository.findById(fixture.pool, created.invitation.id),
      InvitationRepository.findById(fixture.pool, childId),
    ])
    expect(parent?.status).toBe("revoked")
    if (acceptResult.status === "fulfilled") {
      expect(acceptResult.value).toBe(fixture.workspaceId)
      expect(parent?.useCount).toBe(1)
      expect(acceptedChild?.status).toBe("accepted")
    } else {
      expect(acceptResult.reason).toMatchObject({ code: "INVITATION_REVOKED" })
      expect(parent?.useCount).toBe(0)
      expect(acceptedChild?.status).toBe("pending")
    }
  })

  test("should use a non-expiring parent instead of an expired child in pending queries", async () => {
    const created = await fixture.service.createLink({
      workspaceId: fixture.workspaceId,
      invitedBy: fixture.inviterId,
      role: "member",
      note: null,
      maxUses: 2,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const email = "parent-never-expires@example.com"
    const childId = await claim(fixture, created.token, email)
    await fixture.pool.query("UPDATE workspace_invitations SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1", [
      childId,
    ])
    await fixture.service.updateLink({
      workspaceId: fixture.workspaceId,
      invitationId: created.invitation.id,
      expiresAt: null,
    })

    expect((await InvitationRepository.findPendingByEmail(fixture.pool, email)).map((row) => row.id)).toEqual([childId])
    expect(
      (await InvitationRepository.findPendingByEmailsAndWorkspace(fixture.pool, [email], fixture.workspaceId)).map(
        (row) => row.id
      )
    ).toEqual([childId])

    const otherWorkspaceId = workspaceId()
    const crossWorkspaceParentId = invitationId()
    const crossWorkspaceChildId = invitationId()
    await WorkspaceRepository.insert(fixture.pool, {
      id: otherWorkspaceId,
      name: "Other invite workspace",
      slug: `other-${otherWorkspaceId}`,
      createdBy: fixture.inviterId,
    })
    await fixture.pool.query(
      `INSERT INTO workspace_invitations
         (id, workspace_id, kind, email, role, invited_by, token_hash, status, expires_at, max_uses)
       VALUES ($1, $2, 'link', NULL, 'member', $3, $4, 'pending', NULL, 2)`,
      [crossWorkspaceParentId, otherWorkspaceId, fixture.inviterId, hashInvitationToken("cross-workspace-parent")]
    )
    await fixture.pool.query(
      `INSERT INTO workspace_invitations
         (id, workspace_id, kind, email, role, invited_by, status, expires_at, parent_link_id, max_uses)
       VALUES ($1, $2, 'link', $3, 'member', $4, 'pending', NOW() - INTERVAL '1 day', $5, NULL)`,
      [
        crossWorkspaceChildId,
        fixture.workspaceId,
        "cross-workspace@example.com",
        fixture.inviterId,
        crossWorkspaceParentId,
      ]
    )
    expect(await InvitationRepository.findPendingByEmail(fixture.pool, "cross-workspace@example.com")).toEqual([])
  })

  test("should record a new already-member legacy-root acceptance without consuming capacity", async () => {
    const token = "legacy-member-token"
    const id = invitationId()
    const email = `${fixture.inviterId.toLowerCase()}@example.com`
    await fixture.pool.query(
      `INSERT INTO workspace_invitations
         (id, workspace_id, kind, email, role, invited_by, token_hash, status, expires_at, max_uses)
       VALUES ($1, $2, 'link', $3, 'member', $4, $5, 'pending', NULL, 1)`,
      [id, fixture.workspaceId, email, fixture.inviterId, hashInvitationToken(token)]
    )

    await fixture.service.acceptInvitation(id, {
      workosUserId: `workos_${fixture.inviterId}`,
      email,
      name: "Invite admin",
    })
    expect(await InvitationRepository.findById(fixture.pool, id)).toMatchObject({
      status: "accepted",
      useCount: 0,
      acceptanceConsumesCapacity: false,
    })
    await expect(fixture.service.claimLinkByToken(token, "legacy-after-member@example.com")).resolves.toHaveProperty(
      "invitationId"
    )
  })

  test("should preserve unknown old-writer legacy acceptance as one consumed use", async () => {
    const id = invitationId()
    await fixture.pool.query(
      `INSERT INTO workspace_invitations
         (id, workspace_id, kind, email, role, invited_by, token_hash, status, expires_at, max_uses)
       VALUES ($1, $2, 'link', 'old-writer@example.com', 'member', $3, $4, 'pending', NULL, 1)`,
      [id, fixture.workspaceId, fixture.inviterId, hashInvitationToken("old-writer-token")]
    )
    await fixture.pool.query(
      "UPDATE workspace_invitations SET status = 'accepted', accepted_at = NOW() WHERE id = $1",
      [id]
    )

    expect(await InvitationRepository.findById(fixture.pool, id)).toMatchObject({
      useCount: 1,
      acceptanceConsumesCapacity: null,
    })
  })

  test("should keep queued and replayed legacy root claims on the legacy shadow protocol", async () => {
    const token = "legacy-outbox-token"
    const id = invitationId()
    await fixture.pool.query(
      `INSERT INTO workspace_invitations
         (id, workspace_id, kind, email, role, invited_by, token_hash, status, expires_at, max_uses)
       VALUES ($1, $2, 'link', 'legacy-outbox@example.com', 'member', $3, $4, 'pending', NULL, 1)`,
      [id, fixture.workspaceId, fixture.inviterId, hashInvitationToken(token)]
    )
    const calls: unknown[] = []
    const controlPlaneClient = {
      notifyInvitationLinkClaimed: async (params: unknown) => calls.push(params),
    } as unknown as ControlPlaneClient
    const handler = new TestShadowSyncHandler(fixture.pool, controlPlaneClient, "local")
    const base = {
      id: 1n,
      eventType: "invitation:link-claimed",
      createdAt: new Date(),
    }

    await handler.process({
      ...base,
      payload: {
        workspaceId: fixture.workspaceId,
        invitationId: id,
        email: "legacy-outbox@example.com",
        role: "member",
      },
    } as OutboxEvent)
    await handler.process({
      ...base,
      id: 2n,
      payload: {
        workspaceId: fixture.workspaceId,
        invitationId: id,
        parentInvitationId: id,
        email: "legacy-outbox@example.com",
        role: "member",
      },
    } as OutboxEvent)

    expect(calls).toEqual([
      { parentInvitationId: id, email: "legacy-outbox@example.com", inviterWorkosUserId: undefined },
      { parentInvitationId: id, email: "legacy-outbox@example.com", inviterWorkosUserId: undefined },
    ])
  })

  test("should send accepted identity with the current parent snapshot after reordered revocation", async () => {
    const created = await fixture.service.createLink({
      workspaceId: fixture.workspaceId,
      invitedBy: fixture.inviterId,
      role: "member",
      note: null,
      maxUses: 2,
      expiresAt: null,
    })
    const email = "accepted-ack@example.com"
    const childId = await claim(fixture, created.token, email)
    await fixture.service.acceptInvitation(childId, {
      workosUserId: "workos_accepted_ack",
      email,
      name: "Accepted Ack",
    })
    await fixture.service.revokeInvitation(created.invitation.id, fixture.workspaceId)
    const calls: unknown[] = []
    const handler = new TestShadowSyncHandler(
      fixture.pool,
      { acknowledgeInvitationAccepted: async (params: unknown) => calls.push(params) } as unknown as ControlPlaneClient,
      "local"
    )

    await handler.process({
      id: 3n,
      eventType: "invitation:accepted",
      createdAt: new Date(),
      payload: {
        workspaceId: fixture.workspaceId,
        invitationId: childId,
        email,
        workosUserId: "workos_accepted_ack",
        userName: "Accepted Ack",
      },
    } as OutboxEvent)

    expect(calls).toEqual([
      {
        invitationId: childId,
        workspaceId: fixture.workspaceId,
        email,
        workosUserId: "workos_accepted_ack",
        parentInvitationId: created.invitation.id,
        expiresAt: null,
        maxUses: 2,
        useCount: 1,
        revision: 3,
        status: "revoked",
      },
    ])

    await expect(
      handler.process({
        id: 4n,
        eventType: "invitation:accepted",
        createdAt: new Date(),
        payload: {
          workspaceId: fixture.workspaceId,
          invitationId: childId,
          email,
          workosUserId: "workos_pending_attacker",
          userName: "Pending Attacker",
        },
      } as OutboxEvent)
    ).rejects.toThrow("does not match regional state")
    expect(calls).toHaveLength(1)
  })

  test("should acknowledge a completed legacy root after the link is revoked", async () => {
    const id = invitationId()
    const candidate = identity(91)
    await fixture.pool.query(
      `INSERT INTO workspace_invitations
         (id, workspace_id, kind, email, role, invited_by, token_hash, expires_at)
       VALUES ($1, $2, 'link', $3, 'member', $4, $5, NOW() + INTERVAL '1 day')`,
      [id, fixture.workspaceId, candidate.email, fixture.inviterId, hashInvitationToken("legacy-revoked-ack")]
    )
    await fixture.service.acceptInvitation(id, candidate)
    await fixture.service.revokeInvitation(id, fixture.workspaceId)
    const calls: unknown[] = []
    const handler = new TestShadowSyncHandler(
      fixture.pool,
      { acknowledgeInvitationAccepted: async (params: unknown) => calls.push(params) } as unknown as ControlPlaneClient,
      "local"
    )
    await handler.process({
      id: 5n,
      eventType: "invitation:accepted",
      createdAt: new Date(),
      payload: {
        invitationId: id,
        workspaceId: fixture.workspaceId,
        email: candidate.email,
        workosUserId: candidate.workosUserId,
        userName: candidate.name,
      },
    } as OutboxEvent)
    expect(calls[0]).toMatchObject({
      invitationId: id,
      parentInvitationId: id,
      workosUserId: candidate.workosUserId,
      status: "revoked",
      useCount: 1,
    })
  })

  test("should keep a revived legacy admin link bound to one email and fixed at one use", async () => {
    const token = "legacy-admin-token"
    const id = invitationId()
    await fixture.pool.query(
      `INSERT INTO workspace_invitations
         (id, workspace_id, kind, email, role, invited_by, token_hash, status, expires_at, max_uses)
       VALUES ($1, $2, 'link', NULL, 'admin', $3, $4, 'expired', NOW() - INTERVAL '1 day', 1)`,
      [id, fixture.workspaceId, fixture.inviterId, hashInvitationToken(token)]
    )

    await expect(fixture.service.claimLinkByToken(token, "first-admin@example.com")).rejects.toMatchObject({
      code: "INVITATION_EXPIRED",
    })
    const revived = await fixture.service.updateLink({
      workspaceId: fixture.workspaceId,
      invitationId: id,
      expiresAt: null,
    })
    expect(revived).toMatchObject({ id, role: "admin", maxUses: 1, expiresAt: null, status: "pending" })

    await expect(fixture.service.claimLinkByToken(token, "first-admin@example.com")).resolves.toEqual({
      invitationId: id,
    })
    await expect(fixture.service.claimLinkByToken(token, "first-admin@example.com")).resolves.toEqual({
      invitationId: id,
    })
    await expect(fixture.service.claimLinkByToken(token, "second-admin@example.com")).rejects.toMatchObject({
      code: "INVITATION_EXHAUSTED",
    })
    expect(await InvitationRepository.findLinkChild(fixture.pool, id, "first-admin@example.com")).toBeNull()

    await expect(
      fixture.service.updateLink({ workspaceId: fixture.workspaceId, invitationId: id, maxUses: null })
    ).resolves.toBeNull()
    await expect(
      fixture.service.updateLink({ workspaceId: fixture.workspaceId, invitationId: id, maxUses: 2 })
    ).resolves.toBeNull()
    expect(await InvitationRepository.findById(fixture.pool, id)).toMatchObject({
      email: "first-admin@example.com",
      maxUses: 1,
      expiresAt: null,
      revision: revived!.revision,
    })
  })

  test("should derive accepted legacy use and publish current parent state", async () => {
    const token = "legacy-accepted-token"
    const id = invitationId()
    await fixture.pool.query(
      `INSERT INTO workspace_invitations
         (id, workspace_id, kind, email, role, invited_by, token_hash, status, expires_at, accepted_at, max_uses)
       VALUES ($1, $2, 'link', 'legacy@example.com', 'member', $3, $4, 'accepted', NULL, NOW(), 1)`,
      [id, fixture.workspaceId, fixture.inviterId, hashInvitationToken(token)]
    )
    expect((await InvitationRepository.findById(fixture.pool, id))?.useCount).toBe(1)

    await fixture.service.updateLink({
      workspaceId: fixture.workspaceId,
      invitationId: id,
      maxUses: 2,
      expiresAt: null,
    })
    const childId = await claim(fixture, token, "legacy-second@example.com")
    await fixture.service.acceptInvitation(childId, {
      workosUserId: "workos_legacy_second",
      email: "legacy-second@example.com",
      name: "Legacy Second",
    })
    const row = await InvitationRepository.findById(fixture.pool, id)
    expect(row).toMatchObject({ maxUses: 2, useCount: 2 })

    const outbox = await fixture.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox WHERE event_type = 'invitation:accepted' AND payload->>'invitationId' = $1`,
      [childId]
    )
    expect(outbox.rows[0]?.payload).toMatchObject({
      invitationId: childId,
      parentInvitationId: id,
      maxUses: 2,
      useCount: 2,
      status: "accepted",
    })
  })
})
