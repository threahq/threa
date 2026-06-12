import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { StubWorkosOrgService } from "@threa/backend-common"
import { WORKSPACE_ROLE_SLUGS } from "@threa/types"
import { InvitationShadowRepository, InvitationShadowService } from "../../src/features/invitation-shadows"
import type { PlatformAdminSyncService } from "../../src/features/platform-admin"
import type { RegionalClient } from "../../src/lib/regional-client"
import { setupTestDatabase } from "./setup"

/**
 * The role chosen at the regional `sendInvitations`/`createLink` call site
 * must land on the WorkOS invitation and the resulting org membership — CP
 * is not allowed to silently downgrade to "member".
 */
describe("InvitationShadowService role_slug propagation", () => {
  let pool: Pool
  let workos: StubWorkosOrgService
  let regional: RegionalClient
  let service: InvitationShadowService

  const region = "us-east-1"
  const workspaceId = "ws_role_slug_test"
  const orgId = "org_role_slug_test"
  const inviterUserId = "user_inviter_role_slug"
  const inviteeUserId = "user_invitee_role_slug"
  const inviteeEmail = "role-slug-invitee@example.com"

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    // Sibling tests share these tables; truncate to keep this suite hermetic.
    await pool.query("TRUNCATE invitation_shadows, workspace_registry CASCADE")
    workos = new StubWorkosOrgService()
    // Service touches the regional client only on the accept path, which this
    // suite doesn't exercise. A bare object satisfies the type without binding
    // to a live region map.
    regional = {} as RegionalClient
    service = new InvitationShadowService({
      pool,
      regionalClient: regional,
      workosOrgService: workos,
      // The accept path isn't exercised here, so the sync hook never runs.
      platformAdminSync: {} as PlatformAdminSyncService,
    })

    await pool.query(
      `INSERT INTO workspace_registry (id, name, slug, region, created_by_workos_user_id, workos_organization_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [workspaceId, "Role Slug Test", "role-slug-test", region, inviterUserId, orgId]
    )
  })

  test("createShadow persists role_slug and forwards it to WorkOS sendInvitation", async () => {
    const shadow = await service.createShadow({
      id: "inv_role_admin",
      workspaceId,
      region,
      kind: "email",
      email: inviteeEmail,
      tokenHash: null,
      roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      inviterWorkosUserId: inviterUserId,
    })

    expect(shadow.role_slug).toBe(WORKSPACE_ROLE_SLUGS.ADMIN)

    expect([...workos.sentInvitations.values()]).toContainEqual(
      expect.objectContaining({
        organizationId: orgId,
        email: inviteeEmail,
        inviterUserId,
        roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
      })
    )
  })

  test("createShadow with kind='link' persists role_slug without sending an invitation yet", async () => {
    const shadow = await service.createShadow({
      id: "inv_link_admin",
      workspaceId,
      region,
      kind: "link",
      email: null,
      tokenHash: "h_link_admin",
      roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      inviterWorkosUserId: inviterUserId,
    })

    expect(shadow.role_slug).toBe(WORKSPACE_ROLE_SLUGS.ADMIN)
    expect([...workos.sentInvitations.values()]).not.toContainEqual(expect.objectContaining({ organizationId: orgId }))
  })

  test("acceptLinkClaim binds the email and sends WorkOS invitation with the stored role_slug", async () => {
    await service.createShadow({
      id: "inv_link_for_claim",
      workspaceId,
      region,
      kind: "link",
      email: null,
      tokenHash: "h_link_for_claim",
      roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      inviterWorkosUserId: inviterUserId,
    })

    await service.acceptLinkClaim({
      id: "inv_link_for_claim",
      email: inviteeEmail,
      inviterWorkosUserId: inviterUserId,
    })

    expect([...workos.sentInvitations.values()]).toContainEqual(
      expect.objectContaining({
        organizationId: orgId,
        email: inviteeEmail,
        roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
      })
    )
  })

  test("repository.insert defaults to member when caller omits role_slug via the DB default", async () => {
    // Direct INSERT bypasses the application path so the column default is
    // what's under test here — covers legacy rows that pre-date the column.
    await pool.query(
      `INSERT INTO invitation_shadows (id, workspace_id, kind, email, region, expires_at)
       VALUES ($1, $2, 'email', $3, $4, NOW() + INTERVAL '7 days')`,
      ["inv_legacy_no_role", workspaceId, "legacy@example.com", region]
    )

    const row = await InvitationShadowRepository.findById(pool, "inv_legacy_no_role")
    expect(row?.role_slug).toBe(WORKSPACE_ROLE_SLUGS.MEMBER)
  })

  test("acceptShadow with stored role_slug='admin' grants the WorkOS membership at the admin role", async () => {
    // Seed a shadow that's already been claimed (email bound) so we can hit
    // acceptShadow without going through the regional accept hop.
    await pool.query(
      `INSERT INTO invitation_shadows
        (id, workspace_id, kind, email, region, expires_at, role_slug, status)
       VALUES ($1, $2, 'email', $3, $4, NOW() + INTERVAL '7 days', $5, 'pending')`,
      ["inv_accept_admin", workspaceId, inviteeEmail, region, WORKSPACE_ROLE_SLUGS.ADMIN]
    )

    // Replace the regional accept path with a no-op so we don't hit HTTP.
    service["regionalClient"] = {
      acceptInvitation: async () => ({ workspaceId }),
    } as unknown as RegionalClient

    await service.acceptShadow("inv_accept_admin", {
      id: inviteeUserId,
      email: inviteeEmail,
      firstName: "Role",
      lastName: "Slug",
    })

    const memberships = await workos.listOrganizationMemberships(orgId)
    const member = memberships.find((m) => m.userId === inviteeUserId)
    expect(member).toBeDefined()
    expect(member?.roleSlugs).toEqual([WORKSPACE_ROLE_SLUGS.ADMIN])
  })
})
