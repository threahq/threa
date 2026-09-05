import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { InvitationRepository, type Invitation } from "../../src/features/invitations/repository"
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
  const isolated = await setupIsolatedTestDatabase("invite_dark_compat")
  const workspace = workspaceId()
  const inviter = userId()
  await WorkspaceRepository.insert(isolated.pool, {
    id: workspace,
    name: "Invite dark compatibility",
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

function identity(index: number) {
  return {
    workosUserId: `workos_dark_joiner_${index}`,
    email: `dark-joiner-${index}@example.com`,
    name: `Dark Joiner ${index}`,
  }
}

async function seedRoot(
  fixture: Fixture,
  options: { maxUses: number | null; expiresAt: Date | null; token?: string }
): Promise<{ root: Invitation; token: string }> {
  const token = options.token ?? `future-token-${crypto.randomUUID()}`
  const root = await InvitationRepository.insertLink(fixture.pool, {
    id: invitationId(),
    workspaceId: fixture.workspaceId,
    role: "member",
    invitedBy: fixture.inviterId,
    tokenHash: hashInvitationToken(token),
    note: null,
    expiresAt: options.expiresAt,
    maxUses: options.maxUses,
  })
  return { root, token }
}

async function seedChild(fixture: Fixture, root: Invitation, email: string, expiresAt = root.expiresAt) {
  return InvitationRepository.insertOrFindLinkChild(fixture.pool, {
    id: invitationId(),
    parent: { ...root, expiresAt },
    email,
  })
}

class TestShadowSyncHandler extends InvitationShadowSyncHandler {
  process(event: OutboxEvent) {
    return this.processEvent(event)
  }
}

describe("regional invitation dark compatibility", () => {
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

  test("should keep the legacy create, claim, and accept round trip", async () => {
    const created = await fixture.service.createLink({
      workspaceId: fixture.workspaceId,
      invitedBy: fixture.inviterId,
      role: "member",
      note: null,
    })
    const candidate = identity(1)

    await expect(fixture.service.claimLinkByToken(created.token, candidate.email)).resolves.toEqual({})
    expect(await InvitationRepository.hasLinkChildren(fixture.pool, fixture.workspaceId, created.invitation.id)).toBe(
      false
    )
    await expect(fixture.service.acceptInvitation(created.invitation.id, candidate)).resolves.toBe(fixture.workspaceId)
    expect(await InvitationRepository.findById(fixture.pool, created.invitation.id)).toMatchObject({
      email: candidate.email,
      status: "accepted",
      maxUses: 1,
      useCount: 1,
    })
  })

  test("should serialize legacy binding and refuse future roots without mutation", async () => {
    const concurrent = await fixture.service.createLink({
      workspaceId: fixture.workspaceId,
      invitedBy: fixture.inviterId,
      role: "member",
      note: null,
    })
    const first = identity(10)
    const second = identity(11)
    const results = await Promise.allSettled([
      fixture.service.claimLinkByToken(concurrent.token, first.email),
      fixture.service.claimLinkByToken(concurrent.token, second.email),
    ])
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"])

    const mixed = await fixture.service.createLink({
      workspaceId: fixture.workspaceId,
      invitedBy: fixture.inviterId,
      role: "member",
      note: null,
    })
    const darkClaim = fixture.service.claimLinkByToken(mixed.token, "dark-writer@example.com")
    const oldClaim = fixture.pool.query<{ email: string }>(
      `UPDATE workspace_invitations
       SET email = $1
       WHERE token_hash = $2 AND kind = 'link' AND status = 'pending'
         AND email IS NULL AND expires_at > NOW()
       RETURNING email`,
      ["old-writer@example.com", hashInvitationToken(mixed.token)]
    )
    const [darkResult, oldResult] = await Promise.allSettled([darkClaim, oldClaim])
    const oldWon = oldResult.status === "fulfilled" && oldResult.value.rows.length === 1
    expect({ darkSucceeded: darkResult.status === "fulfilled", oldWon }).toEqual({
      darkSucceeded: !oldWon,
      oldWon,
    })
    expect((await InvitationRepository.findById(fixture.pool, mixed.invitation.id))?.email).toMatch(
      /^(dark|old)-writer@example\.com$/
    )

    const multi = await seedRoot(fixture, { maxUses: 2, expiresAt: new Date(Date.now() + 60_000) })
    const unlimited = await seedRoot(fixture, { maxUses: null, expiresAt: new Date(Date.now() + 60_000) })
    const noExpiry = await seedRoot(fixture, { maxUses: 1, expiresAt: null })
    const withChild = await seedRoot(fixture, { maxUses: 1, expiresAt: new Date(Date.now() + 60_000) })
    await seedChild(fixture, withChild.root, identity(12).email)

    for (const seeded of [multi, unlimited, noExpiry, withChild]) {
      await expect(fixture.service.claimLinkByToken(seeded.token, "blocked@example.com")).rejects.toMatchObject({
        code: "INVITATION_ROLLOUT_UNAVAILABLE",
      })
      expect(await InvitationRepository.findById(fixture.pool, seeded.root.id)).toMatchObject({ email: null })
    }
  })

  test("should scope legacy hierarchy checks and claims to the workspace", async () => {
    const withChild = await seedRoot(fixture, { maxUses: 1, expiresAt: new Date(Date.now() + 60_000) })
    await seedChild(fixture, withChild.root, identity(13).email)
    expect(await InvitationRepository.hasLinkChildren(fixture.pool, fixture.workspaceId, withChild.root.id)).toBe(true)
    expect(await InvitationRepository.hasLinkChildren(fixture.pool, "ws_other", withChild.root.id)).toBe(false)

    const claimable = await seedRoot(fixture, { maxUses: 1, expiresAt: new Date(Date.now() + 60_000) })
    await expect(
      InvitationRepository.claimLegacyLinkById(fixture.pool, "ws_other", claimable.root.id, identity(14).email)
    ).resolves.toBeNull()
    expect(await InvitationRepository.findById(fixture.pool, claimable.root.id)).toMatchObject({ email: null })
  })

  test("should preserve conservative accounting for an old-writer acceptance", async () => {
    const { root } = await seedRoot(fixture, { maxUses: 1, expiresAt: new Date(Date.now() + 60_000) })
    await fixture.pool.query(
      `UPDATE workspace_invitations
       SET email = 'old-accepted@example.com', status = 'accepted', accepted_at = NOW()
       WHERE id = $1`,
      [root.id]
    )

    expect(await InvitationRepository.findById(fixture.pool, root.id)).toMatchObject({
      acceptanceConsumesCapacity: null,
      useCount: 1,
    })
  })

  test("should enforce future parent capacity and completed replay", async () => {
    const { root } = await seedRoot(fixture, { maxUses: 2, expiresAt: null })
    const candidates = [identity(20), identity(21), identity(22)]
    const children = await Promise.all(candidates.map((candidate) => seedChild(fixture, root, candidate.email)))
    const results = await Promise.allSettled(
      children.map((child, index) => fixture.service.acceptInvitation(child.id, candidates[index]))
    )

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    const acceptedIndex = results.findIndex((result) => result.status === "fulfilled")
    await fixture.service.revokeInvitation(root.id, fixture.workspaceId)
    await expect(fixture.service.acceptInvitation(children[acceptedIndex].id, candidates[acceptedIndex])).resolves.toBe(
      fixture.workspaceId
    )
    expect(await InvitationRepository.findById(fixture.pool, root.id)).toMatchObject({
      status: "revoked",
      useCount: 2,
    })
  })

  test("should enforce parent revocation and effective expiry for future children", async () => {
    const revoked = await seedRoot(fixture, { maxUses: 2, expiresAt: null })
    const revokedCandidate = identity(30)
    const revokedChild = await seedChild(fixture, revoked.root, revokedCandidate.email)
    await fixture.service.revokeInvitation(revoked.root.id, fixture.workspaceId)
    await expect(fixture.service.acceptInvitation(revokedChild.id, revokedCandidate)).rejects.toMatchObject({
      code: "INVITATION_REVOKED",
    })

    const expired = await seedRoot(fixture, { maxUses: 2, expiresAt: new Date(Date.now() - 60_000) })
    const expiredCandidate = identity(31)
    const expiredChild = await seedChild(fixture, expired.root, expiredCandidate.email, new Date(Date.now() + 60_000))
    await expect(fixture.service.acceptInvitation(expiredChild.id, expiredCandidate)).rejects.toMatchObject({
      code: "INVITATION_EXPIRED",
    })

    const nonExpiring = await seedRoot(fixture, { maxUses: 2, expiresAt: null })
    const nonExpiringCandidate = identity(32)
    const staleChild = await seedChild(
      fixture,
      nonExpiring.root,
      nonExpiringCandidate.email,
      new Date(Date.now() - 60_000)
    )
    await expect(fixture.service.acceptInvitation(staleChild.id, nonExpiringCandidate)).resolves.toBe(
      fixture.workspaceId
    )
  })

  test("should retry missing claim state and skip an invalid root target", async () => {
    const calls: unknown[] = []
    const handler = new TestShadowSyncHandler(
      fixture.pool,
      {
        notifyInvitationLinkClaimed: async (params: unknown) => calls.push(params),
      } as unknown as ControlPlaneClient,
      "local"
    )
    const payload = {
      workspaceId: fixture.workspaceId,
      email: identity(39).email,
      role: "member" as const,
    }

    await expect(
      handler.process({
        id: 1n,
        eventType: "invitation:link-claimed",
        payload: { ...payload, invitationId: "inv_missing" },
        createdAt: new Date(),
      } as OutboxEvent)
    ).rejects.toThrow("Invitation inv_missing not found for link-claimed delivery")
    await expect(
      handler.process({
        id: 2n,
        eventType: "invitation:link-claimed",
        payload: { ...payload, invitationId: "inv_child", parentInvitationId: "inv_missing_parent" },
        createdAt: new Date(),
      } as OutboxEvent)
    ).rejects.toThrow("Invitation parent inv_missing_parent not found for link-claimed delivery")

    const emailInvitation = await InvitationRepository.insert(fixture.pool, {
      id: invitationId(),
      workspaceId: fixture.workspaceId,
      email: identity(38).email,
      role: "member",
      invitedBy: fixture.inviterId,
      expiresAt: new Date(Date.now() + 60_000),
    })
    await handler.process({
      id: 3n,
      eventType: "invitation:link-claimed",
      payload: { ...payload, invitationId: emailInvitation.id },
      createdAt: new Date(),
    } as OutboxEvent)
    expect(calls).toEqual([])
  })

  test("should deliver queued legacy claims and acceptance acknowledgements", async () => {
    const created = await fixture.service.createLink({
      workspaceId: fixture.workspaceId,
      invitedBy: fixture.inviterId,
      role: "member",
      note: null,
    })
    const candidate = identity(40)
    await fixture.service.claimLinkByToken(created.token, candidate.email)
    await fixture.service.acceptInvitation(created.invitation.id, candidate)

    const calls: unknown[] = []
    const handler = new TestShadowSyncHandler(
      fixture.pool,
      {
        notifyInvitationLinkClaimed: async (params: unknown) => calls.push({ claim: params }),
        acknowledgeInvitationAccepted: async (params: unknown) => calls.push({ accepted: params }),
      } as unknown as ControlPlaneClient,
      "local"
    )
    const base = { createdAt: new Date() }
    await handler.process({
      ...base,
      id: 1n,
      eventType: "invitation:link-claimed",
      payload: {
        workspaceId: fixture.workspaceId,
        invitationId: created.invitation.id,
        email: candidate.email,
        role: "member",
      },
    } as OutboxEvent)
    await handler.process({
      ...base,
      id: 2n,
      eventType: "invitation:accepted",
      payload: {
        workspaceId: fixture.workspaceId,
        invitationId: created.invitation.id,
        email: candidate.email,
        workosUserId: candidate.workosUserId,
        userName: candidate.name,
      },
    } as OutboxEvent)

    expect(calls).toEqual([
      {
        claim: {
          parentInvitationId: created.invitation.id,
          email: candidate.email,
          inviterWorkosUserId: undefined,
        },
      },
      {
        accepted: {
          invitationId: created.invitation.id,
          workspaceId: fixture.workspaceId,
          email: candidate.email,
          workosUserId: candidate.workosUserId,
          parentInvitationId: created.invitation.id,
          expiresAt: expect.any(Date),
          maxUses: 1,
          useCount: 1,
          revision: 2,
          status: "accepted",
        },
      },
    ])
  })
})
