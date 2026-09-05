import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { Pool } from "pg"
import { HttpError, StubWorkosOrgService } from "@threa/backend-common"
import { WORKSPACE_ROLE_SLUGS } from "@threa/types"
import { InvitationShadowRepository, InvitationShadowService } from "../../src/features/invitation-shadows"
import { PlatformAdminSyncService } from "../../src/features/platform-admin"
import { WorkspaceRegistryRepository } from "../../src/features/workspaces"
import { RegionalInvitationError, RegionalClient } from "../../src/lib/regional-client"
import { setupTestDatabase } from "./setup"

type RegionalClientMethods = {
  acceptInvitation?: RegionalClient["acceptInvitation"]
  claimInvitationLink?: RegionalClient["claimInvitationLink"]
}

class TestRegionalClient extends RegionalClient {
  constructor(private readonly methods: RegionalClientMethods = {}) {
    super({}, "test-internal-key")
  }

  override async acceptInvitation(
    region: string,
    invitationId: string,
    data: { workosUserId: string; email: string; name: string }
  ): Promise<{ workspaceId: string }> {
    return this.methods.acceptInvitation?.(region, invitationId, data) ?? { workspaceId: "ws_multi_shadow" }
  }

  override async claimInvitationLink(
    region: string,
    data: { token: string; email: string }
  ): Promise<{ ok: true; alreadyMember?: { workspaceId: string } }> {
    return this.methods.claimInvitationLink?.(region, data) ?? { ok: true }
  }
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)),
  ])
}

describe("multi-use invitation shadows", () => {
  let pool: Pool
  let workos: StubWorkosOrgService
  let regional: RegionalClient
  let service: InvitationShadowService

  const workspaceId = "ws_multi_shadow"
  const future = new Date(Date.now() + 86_400_000)

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("TRUNCATE invitation_shadows, workspace_memberships, workspace_registry CASCADE")
    await pool.query(
      `INSERT INTO workspace_registry
         (id, name, slug, region, created_by_workos_user_id, workos_organization_id)
       VALUES ($1, 'Multi shadow', 'multi-shadow', 'local', 'user_owner', 'org_multi_shadow')`,
      [workspaceId]
    )
    workos = new StubWorkosOrgService()
    regional = new TestRegionalClient()
    service = new InvitationShadowService({
      pool,
      regionalClient: regional,
      workosOrgService: workos,
      platformAdminSync: new PlatformAdminSyncService({ pool, regionalClient: regional }),
    })
  })

  async function createParent(params?: {
    revision?: number
    status?: "pending" | "accepted" | "expired" | "revoked"
    roleSlug?: "member" | "admin"
  }) {
    return service.createShadow({
      id: "inv_parent_multi",
      workspaceId,
      region: "local",
      kind: "link",
      email: null,
      tokenHash: "parent-token-hash",
      roleSlug: params?.roleSlug ?? WORKSPACE_ROLE_SLUGS.MEMBER,
      expiresAt: future,
      maxUses: 2,
      useCount: params?.status === "accepted" ? 1 : 0,
      revision: params?.revision ?? 1,
      status: params?.status ?? "pending",
      inviterWorkosUserId: "user_owner",
    })
  }

  test("applies only current parent snapshots and never resurrects a revoked link", async () => {
    await createParent()
    await service.updateLinkSnapshot("inv_parent_multi", {
      expiresAt: null,
      maxUses: null,
      useCount: 1,
      revision: 3,
      status: "pending",
    })
    await service.updateLinkSnapshot("inv_parent_multi", {
      expiresAt: future,
      maxUses: 2,
      useCount: 0,
      revision: 2,
      status: "pending",
    })
    await service.updateLinkSnapshot("inv_parent_multi", {
      expiresAt: null,
      maxUses: null,
      useCount: 1,
      revision: 4,
      status: "revoked",
    })
    await service.createShadow({
      id: "inv_parent_multi",
      workspaceId,
      region: "local",
      kind: "link",
      email: null,
      tokenHash: "parent-token-hash",
      roleSlug: WORKSPACE_ROLE_SLUGS.MEMBER,
      expiresAt: future,
      maxUses: 10,
      useCount: 0,
      revision: 5,
      status: "pending",
    })

    const row = await InvitationShadowRepository.findById(pool, "inv_parent_multi")
    expect(row).toMatchObject({ status: "revoked", revision: 5, expires_at: null, max_uses: null, use_count: 1 })
  })

  test("creates an independent child and WorkOS invitation for every claim", async () => {
    await createParent()
    await service.acceptLinkClaim({
      id: "inv_parent_multi",
      childInvitationId: "inv_child_one",
      email: "one@example.com",
      expiresAt: future,
      maxUses: 2,
      useCount: 0,
      revision: 1,
      inviterWorkosUserId: "user_owner",
    })
    await service.acceptLinkClaim({
      id: "inv_parent_multi",
      childInvitationId: "inv_child_two",
      email: "two@example.com",
      expiresAt: future,
      maxUses: 2,
      useCount: 0,
      revision: 1,
      inviterWorkosUserId: "user_owner",
    })

    const children = await pool.query(
      `SELECT id, parent_link_id, email, workos_invitation_id FROM invitation_shadows
       WHERE parent_link_id = $1 ORDER BY id`,
      ["inv_parent_multi"]
    )
    expect(children.rows).toEqual([
      expect.objectContaining({ id: "inv_child_one", parent_link_id: "inv_parent_multi", email: "one@example.com" }),
      expect.objectContaining({ id: "inv_child_two", parent_link_id: "inv_parent_multi", email: "two@example.com" }),
    ])
    expect(children.rows.every((row) => typeof row.workos_invitation_id === "string")).toBe(true)
    expect(workos.sentInvitations.size).toBe(2)
  })

  test("reissues an expired WorkOS verification invitation for a non-expiring link", async () => {
    await createParent()
    const claim = {
      id: "inv_parent_multi",
      childInvitationId: "inv_child_workos_expired",
      email: "workos-expired@example.com",
      expiresAt: null,
      maxUses: 2,
      useCount: 0,
      revision: 1,
      inviterWorkosUserId: "user_owner",
    }
    await service.acceptLinkClaim(claim)
    const first = await InvitationShadowRepository.findById(pool, claim.childInvitationId)
    if (!first?.workos_invitation_id) throw new Error("initial WorkOS invitation was not stored")
    await pool.query(
      "UPDATE invitation_shadows SET workos_invitation_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
      [claim.childInvitationId]
    )
    workos.getInvitation = async (id) => ({ id, state: "expired", expiresAt: new Date(Date.now() - 60_000) })
    workos.resendInvitation = async () => {
      throw Object.assign(new Error("Only pending invitations can be resent"), { code: "invite_not_pending" })
    }
    workos.sendInvitation = async () => ({
      id: "inv_workos_replacement",
      expiresAt: new Date(Date.now() + 60_000),
    })

    await service.acceptLinkClaim(claim)

    const replaced = await InvitationShadowRepository.findById(pool, claim.childInvitationId)
    expect(replaced?.workos_invitation_id).toBe("inv_workos_replacement")
    expect(replaced?.workos_invitation_expires_at?.getTime()).toBeGreaterThan(Date.now())
  })

  test("looks up legacy WorkOS invitation expiry instead of treating an unknown expiry as permanent", async () => {
    await createParent()
    const claim = {
      id: "inv_parent_multi",
      childInvitationId: "inv_child_legacy_workos_expiry",
      email: "legacy-workos-expiry@example.com",
      inviterWorkosUserId: "user_owner",
    }
    await service.acceptLinkClaim(claim)
    const first = await InvitationShadowRepository.findById(pool, claim.childInvitationId)
    if (!first?.workos_invitation_id) throw new Error("initial WorkOS invitation was not stored")
    await pool.query("UPDATE invitation_shadows SET workos_invitation_expires_at = NULL WHERE id = $1", [
      claim.childInvitationId,
    ])
    const authoritativeExpiry = new Date(Date.now() + 120_000)
    workos.getInvitation = async (id) => ({ id, state: "pending", expiresAt: authoritativeExpiry })

    await service.acceptLinkClaim(claim)

    expect(await InvitationShadowRepository.findById(pool, claim.childInvitationId)).toMatchObject({
      workos_invitation_id: first.workos_invitation_id,
      workos_invitation_expires_at: authoritativeExpiry,
    })
    expect(workos.sentInvitations.size).toBe(1)
  })

  test("revokes a fresh WorkOS invitation when parent revocation wins the send race", async () => {
    await createParent()
    let releaseSend: ((invitation: { id: string; expiresAt: Date }) => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    workos.sendInvitation = async () => {
      markStarted?.()
      return new Promise((resolve) => {
        releaseSend = resolve
      })
    }
    const revoked: string[] = []
    workos.revokeInvitation = async (id) => {
      revoked.push(id)
    }
    const claim = service.acceptLinkClaim({
      id: "inv_parent_multi",
      childInvitationId: "inv_child_send_revoke",
      email: "send-revoke@example.com",
      inviterWorkosUserId: "user_owner",
    })
    await started
    expect(await service.updateStatus("inv_parent_multi", "revoked")).toBe(true)
    releaseSend?.({ id: "workos_send_revoke", expiresAt: new Date(Date.now() + 60_000) })
    await claim

    expect(await InvitationShadowRepository.findById(pool, "inv_child_send_revoke")).toMatchObject({
      status: "revoked",
      workos_invitation_id: null,
    })
    expect(revoked).toEqual(["workos_send_revoke"])
  })

  test("keeps one replacement and revokes the loser for concurrent expired-claim delivery", async () => {
    await createParent()
    const params = {
      id: "inv_parent_multi",
      childInvitationId: "inv_child_concurrent_claim",
      email: "concurrent-claim@example.com",
      inviterWorkosUserId: "user_owner",
    }
    await service.acceptLinkClaim(params)
    const initial = await InvitationShadowRepository.findById(pool, params.childInvitationId)
    if (!initial?.workos_invitation_id) throw new Error("initial WorkOS invitation was not stored")
    await pool.query(
      "UPDATE invitation_shadows SET workos_invitation_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
      [params.childInvitationId]
    )
    workos.getInvitation = async (id) => ({ id, state: "expired", expiresAt: new Date(Date.now() - 60_000) })

    const releases: Array<(expiresAt: Date) => void> = []
    let started = 0
    let markBothStarted: (() => void) | undefined
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve
    })
    workos.sendInvitation = async () => {
      started += 1
      if (started === 2) markBothStarted?.()
      const id = `workos_concurrent_${started}`
      return new Promise((resolve) => {
        releases.push((expiresAt) => resolve({ id, expiresAt }))
      })
    }
    const revoked: string[] = []
    workos.revokeInvitation = async (id) => {
      revoked.push(id)
    }
    const deliveries = [service.acceptLinkClaim(params), service.acceptLinkClaim(params)]
    await bothStarted
    for (const release of releases) release(new Date(Date.now() + 60_000))
    await Promise.all(deliveries)

    const row = await InvitationShadowRepository.findById(pool, params.childInvitationId)
    expect(["workos_concurrent_1", "workos_concurrent_2"]).toContain(row?.workos_invitation_id)
    expect(row?.workos_invitation_id).not.toBe(initial.workos_invitation_id)
    expect(revoked).toHaveLength(1)
    expect(revoked).not.toContain(row?.workos_invitation_id)
  })

  test("keeps a legacy root claim on the root and preserves its verification state on replay", async () => {
    await createParent()
    await service.acceptLinkClaim({
      id: "inv_parent_multi",
      email: "legacy-root@example.com",
      inviterWorkosUserId: "user_owner",
    })
    const first = await InvitationShadowRepository.findById(pool, "inv_parent_multi")
    await service.acceptLinkClaim({
      id: "inv_parent_multi",
      email: "legacy-root@example.com",
      inviterWorkosUserId: "user_owner",
    })

    expect(await InvitationShadowRepository.findById(pool, "inv_parent_multi")).toMatchObject({
      email: "legacy-root@example.com",
      workos_invitation_id: first?.workos_invitation_id,
      parent_link_id: null,
    })
    expect(
      (await pool.query("SELECT 1 FROM invitation_shadows WHERE parent_link_id = $1", ["inv_parent_multi"])).rowCount
    ).toBe(0)
    expect(workos.sentInvitations.size).toBe(1)
  })

  test("revokes pending children when an unversioned legacy revoke arrives", async () => {
    await createParent()
    await service.acceptLinkClaim({
      id: "inv_parent_multi",
      childInvitationId: "inv_child_legacy_revoke",
      email: "legacy-revoke@example.com",
      expiresAt: future,
      maxUses: 2,
      useCount: 0,
      revision: 1,
      inviterWorkosUserId: "user_owner",
    })

    expect(await service.updateStatus("inv_parent_multi", "revoked")).toBe(true)
    expect(await InvitationShadowRepository.findById(pool, "inv_parent_multi")).toMatchObject({ status: "revoked" })
    expect(await InvitationShadowRepository.findById(pool, "inv_child_legacy_revoke")).toMatchObject({
      status: "revoked",
    })
    expect(await service.listPendingForEmail("legacy-revoke@example.com")).toEqual([])
  })

  test("uses the parent expiry for a pending child after extension and removal", async () => {
    await createParent()
    await service.acceptLinkClaim({
      id: "inv_parent_multi",
      childInvitationId: "inv_child_expiry",
      email: "expiry@example.com",
      expiresAt: future,
      maxUses: 2,
      useCount: 0,
      revision: 1,
      inviterWorkosUserId: "user_owner",
    })
    await pool.query("UPDATE invitation_shadows SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1", [
      "inv_child_expiry",
    ])
    await service.updateLinkSnapshot("inv_parent_multi", {
      expiresAt: null,
      maxUses: null,
      useCount: 0,
      revision: 2,
      status: "pending",
    })

    expect(await service.listPendingForEmail("expiry@example.com")).toEqual([
      { id: "inv_child_expiry", workspaceId, workspaceName: "Multi shadow", expiresAt: null },
    ])
  })

  test("keeps the child pending and local membership absent when regional acceptance rejects capacity", async () => {
    await createParent()
    await service.acceptLinkClaim({
      id: "inv_parent_multi",
      childInvitationId: "inv_child_exhausted",
      email: "full@example.com",
      expiresAt: future,
      maxUses: 2,
      useCount: 0,
      revision: 1,
      inviterWorkosUserId: "user_owner",
    })
    const rejectingService = new InvitationShadowService({
      pool,
      regionalClient: new TestRegionalClient({
        acceptInvitation: async () => {
          throw new RegionalInvitationError(409, JSON.stringify({ code: "INVITATION_EXHAUSTED" }))
        },
      }),
      workosOrgService: workos,
      platformAdminSync: new PlatformAdminSyncService({ pool, regionalClient: regional }),
    })

    let caught: unknown
    try {
      await rejectingService.acceptShadow("inv_child_exhausted", {
        id: "user_full",
        email: "full@example.com",
        name: "Full User",
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(HttpError)
    expect(caught).toMatchObject({ status: 409, code: "INVITATION_EXHAUSTED" })
    expect(await InvitationShadowRepository.findById(pool, "inv_child_exhausted")).toMatchObject({ status: "pending" })
    expect(
      (
        await pool.query("SELECT 1 FROM workspace_memberships WHERE workspace_id = $1 AND workos_user_id = $2", [
          workspaceId,
          "user_full",
        ])
      ).rowCount
    ).toBe(0)
  })

  test("keeps revision-zero accepted roots unavailable with the legacy error", async () => {
    await service.createShadow({
      id: "inv_legacy_used",
      workspaceId,
      region: "local",
      kind: "link",
      email: "legacy-used@example.com",
      tokenHash: "legacy-used-hash",
      roleSlug: WORKSPACE_ROLE_SLUGS.MEMBER,
      expiresAt: future,
      status: "accepted",
    })

    await expect(service.lookupByToken("not-the-prehashed-token")).rejects.toMatchObject({
      code: "INVITATION_NOT_FOUND",
    })
    const token = "legacy-used-token"
    await pool.query("UPDATE invitation_shadows SET token_hash = $1 WHERE id = 'inv_legacy_used'", [
      createHash("sha256").update(token).digest("hex"),
    ])
    await expect(service.lookupByToken(token)).rejects.toMatchObject({ code: "INVITATION_ALREADY_CLAIMED" })
    await expect(service.claimByToken(token, "legacy-used@example.com")).rejects.toMatchObject({
      code: "INVITATION_ALREADY_CLAIMED",
    })
  })

  test("maps the old regional already-claimed error during the CP-first rollout", async () => {
    const token = "legacy-old-regional-claimed"
    await service.createShadow({
      id: "inv_legacy_old_regional",
      workspaceId,
      region: "local",
      kind: "link",
      email: null,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      roleSlug: WORKSPACE_ROLE_SLUGS.MEMBER,
      expiresAt: future,
    })
    const oldRegionalService = new InvitationShadowService({
      pool,
      regionalClient: new TestRegionalClient({
        claimInvitationLink: async () => {
          throw new RegionalInvitationError(409, JSON.stringify({ code: "INVITATION_ALREADY_CLAIMED" }))
        },
      }),
      workosOrgService: workos,
      platformAdminSync: new PlatformAdminSyncService({ pool, regionalClient: regional }),
    })

    await expect(oldRegionalService.claimByToken(token, "legacy@example.com")).rejects.toMatchObject({
      status: 409,
      code: "INVITATION_ALREADY_CLAIMED",
    })
  })

  test("reconciles a regional join after CP rollback and a reordered parent revoke", async () => {
    await createParent()
    await service.acceptLinkClaim({
      id: "inv_parent_multi",
      childInvitationId: "inv_child_recovery",
      email: "recovery@example.com",
      expiresAt: future,
      maxUses: 2,
      useCount: 0,
      revision: 1,
      inviterWorkosUserId: "user_owner",
    })
    const failingService = new InvitationShadowService({
      pool,
      regionalClient: regional,
      workosOrgService: workos,
      platformAdminSync: {
        enqueueIfAdmin: async () => {
          throw new Error("forced CP transaction rollback")
        },
      } as unknown as PlatformAdminSyncService,
    })

    await expect(
      failingService.acceptShadow("inv_child_recovery", {
        id: "user_recovery",
        email: "recovery@example.com",
        name: "Recovery User",
      })
    ).rejects.toThrow("forced CP transaction rollback")
    expect(await InvitationShadowRepository.findById(pool, "inv_child_recovery")).toMatchObject({ status: "pending" })
    expect(await WorkspaceRegistryRepository.isMember(pool, workspaceId, "user_recovery")).toBe(false)

    await service.updateLinkSnapshot("inv_parent_multi", {
      expiresAt: future,
      maxUses: 2,
      useCount: 1,
      revision: 2,
      status: "revoked",
    })
    await service.reconcileAccepted({
      id: "inv_child_recovery",
      workspaceId,
      email: "recovery@example.com",
      workosUserId: "user_recovery",
      parentInvitationId: "inv_parent_multi",
      expiresAt: future,
      maxUses: 2,
      useCount: 1,
      revision: 2,
      status: "revoked",
    })

    expect(await InvitationShadowRepository.findById(pool, "inv_parent_multi")).toMatchObject({ status: "revoked" })
    expect(await InvitationShadowRepository.findById(pool, "inv_child_recovery")).toMatchObject({
      status: "accepted",
      accepted_workos_user_id: "user_recovery",
    })
    expect(await WorkspaceRegistryRepository.isMember(pool, workspaceId, "user_recovery")).toBe(true)
    expect(await service.listPendingForEmail("recovery@example.com")).toEqual([])
    expect((await workos.listOrganizationMemberships("org_multi_shadow")).map((row) => row.userId)).toContain(
      "user_recovery"
    )
  })

  test("does not restore or promote WorkOS access when accepted invitations replay", async () => {
    await createParent({ roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN })
    await service.acceptLinkClaim({
      id: "inv_parent_multi",
      childInvitationId: "inv_child_admin_replay",
      email: "admin-replay@example.com",
      inviterWorkosUserId: "user_owner",
    })
    await service.reconcileAccepted({
      id: "inv_child_admin_replay",
      workspaceId,
      email: "admin-replay@example.com",
      workosUserId: "user_admin_replay",
      parentInvitationId: "inv_parent_multi",
    })
    const existing = (await workos.listOrganizationMemberships("org_multi_shadow"))[0]
    if (!existing) throw new Error("initial WorkOS membership was not created")
    workos.setOrganizationMemberships("org_multi_shadow", [{ ...existing, roleSlugs: ["member"] }])

    await service.acceptShadow("inv_child_admin_replay", {
      id: "user_admin_replay",
      email: "admin-replay@example.com",
      name: "Admin Replay",
    })
    expect(await workos.listOrganizationMemberships("org_multi_shadow")).toEqual([
      expect.objectContaining({ userId: "user_admin_replay", roleSlugs: ["member"] }),
    ])

    await service.updateLinkSnapshot("inv_parent_multi", {
      expiresAt: future,
      maxUses: 2,
      useCount: 1,
      revision: 2,
      status: "revoked",
    })
    workos.setOrganizationMemberships("org_multi_shadow", [])
    await service.reconcileAccepted({
      id: "inv_child_admin_replay",
      workspaceId,
      email: "admin-replay@example.com",
      workosUserId: "user_admin_replay",
      parentInvitationId: "inv_parent_multi",
      expiresAt: future,
      maxUses: 2,
      useCount: 1,
      revision: 2,
      status: "revoked",
    })
    expect(await workos.listOrganizationMemberships("org_multi_shadow")).toEqual([])
  })

  test("does not recreate removed WorkOS access from a revoked legacy admin invitation", async () => {
    await createParent({ roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN })
    await service.acceptLinkClaim({
      id: "inv_parent_multi",
      email: "revoked-admin@example.com",
      inviterWorkosUserId: "user_owner",
    })
    await service.reconcileAccepted({
      id: "inv_parent_multi",
      workspaceId,
      email: "revoked-admin@example.com",
      workosUserId: "user_revoked_admin",
      parentInvitationId: "inv_parent_multi",
    })
    await service.updateLinkSnapshot("inv_parent_multi", {
      expiresAt: future,
      maxUses: 2,
      useCount: 1,
      revision: 2,
      status: "revoked",
    })
    workos.setOrganizationMemberships("org_multi_shadow", [])

    await service.acceptShadow("inv_parent_multi", {
      id: "user_revoked_admin",
      email: "revoked-admin@example.com",
      name: "Revoked Admin",
    })
    await service.reconcileAccepted({
      id: "inv_parent_multi",
      workspaceId,
      email: "revoked-admin@example.com",
      workosUserId: "user_revoked_admin",
      parentInvitationId: "inv_parent_multi",
      expiresAt: future,
      maxUses: 2,
      useCount: 1,
      revision: 2,
      status: "revoked",
    })

    expect(await workos.listOrganizationMemberships("org_multi_shadow")).toEqual([])
    expect(await InvitationShadowRepository.findById(pool, "inv_parent_multi")).toMatchObject({ status: "revoked" })
  })

  test("does not promote an active member who accepts a pending admin invitation", async () => {
    await createParent({ roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN })
    await service.acceptLinkClaim({
      id: "inv_parent_multi",
      childInvitationId: "inv_child_active_member",
      email: "active-member@example.com",
      inviterWorkosUserId: "user_owner",
    })
    await WorkspaceRegistryRepository.insertMembership(pool, workspaceId, "user_active_member")
    workos.setOrganizationMemberships("org_multi_shadow", [
      {
        id: "membership_active_member",
        organizationId: "org_multi_shadow",
        userId: "user_active_member",
        status: "active",
        roleSlugs: ["member"],
        updatedAt: new Date(),
      },
    ])

    await service.acceptShadow("inv_child_active_member", {
      id: "user_active_member",
      email: "active-member@example.com",
      name: "Active Member",
    })

    expect(await workos.listOrganizationMemberships("org_multi_shadow")).toEqual([
      expect.objectContaining({ userId: "user_active_member", roleSlugs: ["member"] }),
    ])
  })

  test("should bind a null-email legacy root when acceptance arrives before claim", async () => {
    await createParent()

    await service.reconcileAccepted({
      id: "inv_parent_multi",
      workspaceId,
      email: "legacy-accept-first@example.com",
      workosUserId: "user_legacy_accept_first",
      parentInvitationId: "inv_parent_multi",
    })

    expect(await InvitationShadowRepository.findById(pool, "inv_parent_multi")).toMatchObject({
      email: "legacy-accept-first@example.com",
      status: "accepted",
      accepted_workos_user_id: "user_legacy_accept_first",
    })
    expect(await WorkspaceRegistryRepository.isMember(pool, workspaceId, "user_legacy_accept_first")).toBe(true)
  })

  test("should insert an accepted child from the refreshed parent snapshot", async () => {
    await createParent()

    await service.reconcileAccepted({
      id: "inv_child_snapshot_first",
      workspaceId,
      email: "snapshot-first@example.com",
      workosUserId: "user_snapshot_first",
      parentInvitationId: "inv_parent_multi",
      expiresAt: null,
      maxUses: null,
      useCount: 1,
      revision: 2,
      status: "pending",
    })

    expect(await InvitationShadowRepository.findById(pool, "inv_parent_multi")).toMatchObject({
      expires_at: null,
      max_uses: null,
      use_count: 1,
      revision: 2,
    })
    expect(await InvitationShadowRepository.findById(pool, "inv_child_snapshot_first")).toMatchObject({
      parent_link_id: "inv_parent_multi",
      email: "snapshot-first@example.com",
      expires_at: null,
      status: "accepted",
    })
  })

  test("should let a parent update finish before a concurrent acceptance locks its child", async () => {
    await createParent()
    await service.acceptLinkClaim({
      id: "inv_parent_multi",
      childInvitationId: "inv_child_lock_order",
      email: "lock-order@example.com",
      inviterWorkosUserId: "user_owner",
    })

    const updater = await pool.connect()
    try {
      await updater.query("BEGIN")
      await updater.query("SET LOCAL lock_timeout = '300ms'")
      await updater.query("SET LOCAL statement_timeout = '900ms'")
      await InvitationShadowRepository.findByIdForUpdate(updater, "inv_parent_multi")

      const acknowledgement = service.reconcileAccepted({
        id: "inv_child_lock_order",
        workspaceId,
        email: "lock-order@example.com",
        workosUserId: "user_lock_order",
        parentInvitationId: "inv_parent_multi",
      })

      const waitDeadline = Date.now() + 750
      let waitingOnParent = false
      while (!waitingOnParent && Date.now() < waitDeadline) {
        const result = await pool.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE datname = current_database() AND pid <> $1
               AND wait_event_type = 'Lock'
               AND query LIKE '%FROM invitation_shadows WHERE id = $1 FOR UPDATE%'
           ) AS waiting`,
          [updater.processID]
        )
        waitingOnParent = result.rows[0]?.waiting ?? false
        if (!waitingOnParent) await Bun.sleep(10)
      }
      expect(waitingOnParent).toBe(true)

      await InvitationShadowRepository.applyParentSnapshot(updater, "inv_parent_multi", {
        expiresAt: null,
        maxUses: 2,
        useCount: 1,
        revision: 2,
        status: "revoked",
      })
      expect(await InvitationShadowRepository.revokePendingChildren(updater, "inv_parent_multi")).toEqual([
        expect.objectContaining({ id: "inv_child_lock_order", status: "revoked" }),
      ])
      await updater.query("COMMIT")
      await withTimeout(acknowledgement, "acceptance acknowledgement")
    } catch (error) {
      await updater.query("ROLLBACK")
      throw error
    } finally {
      updater.release()
    }

    expect(await InvitationShadowRepository.findById(pool, "inv_child_lock_order")).toMatchObject({
      status: "accepted",
      accepted_workos_user_id: "user_lock_order",
    })
  })

  test("should expose retryable missing shadows and permanent acceptance conflicts as HttpErrors", async () => {
    await expect(
      service.reconcileAccepted({
        id: "inv_missing_child",
        workspaceId,
        email: "missing@example.com",
        workosUserId: "user_missing",
        parentInvitationId: "inv_missing_parent",
      })
    ).rejects.toMatchObject({ status: 503, code: "INVITATION_SHADOW_NOT_READY" })

    await createParent()
    await expect(
      service.reconcileAccepted({
        id: "inv_parent_multi",
        workspaceId: "ws_wrong",
        email: "wrong-workspace@example.com",
        workosUserId: "user_wrong_workspace",
        parentInvitationId: "inv_parent_multi",
      })
    ).rejects.toMatchObject({ status: 409, code: "INVITATION_PARENT_CONFLICT" })

    await service.acceptLinkClaim({
      id: "inv_parent_multi",
      childInvitationId: "inv_child_conflict",
      email: "right@example.com",
      inviterWorkosUserId: "user_owner",
    })
    await expect(
      service.reconcileAccepted({
        id: "inv_child_conflict",
        workspaceId,
        email: "wrong@example.com",
        workosUserId: "user_wrong",
        parentInvitationId: "inv_parent_multi",
      })
    ).rejects.toMatchObject({ status: 409, code: "INVITATION_ACCEPTANCE_CONFLICT" })
  })

  test("creates a missing accepted child before delayed claim and revoke events without accepting the wrong email", async () => {
    await createParent()
    await service.acceptLinkClaim({
      id: "inv_parent_multi",
      childInvitationId: "inv_child_still_pending",
      email: "still-pending@example.com",
      inviterWorkosUserId: "user_owner",
    })
    await service.reconcileAccepted({
      id: "inv_child_accept_first",
      workspaceId,
      email: "accept-first@example.com",
      workosUserId: "user_accept_first",
      parentInvitationId: "inv_parent_multi",
      expiresAt: future,
      maxUses: 2,
      useCount: 1,
      revision: 2,
      status: "revoked",
    })
    await service.acceptLinkClaim({
      id: "inv_parent_multi",
      childInvitationId: "inv_child_accept_first",
      email: "accept-first@example.com",
      expiresAt: future,
      maxUses: 2,
      useCount: 1,
      revision: 2,
      inviterWorkosUserId: "user_owner",
    })

    expect(await InvitationShadowRepository.findById(pool, "inv_parent_multi")).toMatchObject({ status: "revoked" })
    expect(await InvitationShadowRepository.findById(pool, "inv_child_still_pending")).toMatchObject({
      status: "revoked",
    })
    expect(await InvitationShadowRepository.findById(pool, "inv_child_accept_first")).toMatchObject({
      status: "accepted",
      email: "accept-first@example.com",
      accepted_workos_user_id: "user_accept_first",
    })
    await expect(
      service.reconcileAccepted({
        id: "inv_child_accept_first",
        workspaceId,
        email: "attacker@example.com",
        workosUserId: "user_attacker",
        parentInvitationId: "inv_parent_multi",
      })
    ).rejects.toThrow("acceptance identity conflicts")
    expect(await WorkspaceRegistryRepository.isMember(pool, workspaceId, "user_attacker")).toBe(false)
  })

  test("preserves accepted legacy state under old-writer replay and replays an accepted child", async () => {
    await service.createShadow({
      id: "inv_legacy_accepted",
      workspaceId,
      region: "local",
      kind: "link",
      email: "legacy@example.com",
      tokenHash: "legacy-accepted-hash",
      roleSlug: WORKSPACE_ROLE_SLUGS.MEMBER,
      expiresAt: future,
      status: "accepted",
    })
    await service.createShadow({
      id: "inv_legacy_accepted",
      workspaceId,
      region: "local",
      kind: "link",
      email: null,
      tokenHash: "legacy-accepted-hash",
      roleSlug: WORKSPACE_ROLE_SLUGS.MEMBER,
      expiresAt: future,
    })
    expect(await InvitationShadowRepository.findById(pool, "inv_legacy_accepted")).toMatchObject({ status: "accepted" })

    await createParent()
    await service.acceptLinkClaim({
      id: "inv_parent_multi",
      childInvitationId: "inv_child_accepted",
      email: "accepted@example.com",
      inviterWorkosUserId: "user_owner",
    })
    await pool.query("UPDATE invitation_shadows SET status = 'accepted' WHERE id = 'inv_child_accepted'")
    await pool.query("INSERT INTO workspace_memberships (workspace_id, workos_user_id) VALUES ($1, $2)", [
      workspaceId,
      "user_accepted",
    ])
    const replayGuardService = new InvitationShadowService({
      pool,
      regionalClient: new TestRegionalClient({
        acceptInvitation: async () => {
          throw new Error("must not replay regional membership")
        },
      }),
      workosOrgService: workos,
      platformAdminSync: new PlatformAdminSyncService({ pool, regionalClient: regional }),
    })

    await expect(
      replayGuardService.acceptShadow("inv_child_accepted", {
        id: "user_accepted",
        email: "accepted@example.com",
        name: "Accepted User",
      })
    ).resolves.toEqual({ workspaceId })
  })
})
