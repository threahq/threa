import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { StubWorkosOrgService } from "@threahq/backend-common"
import { WORKSPACE_ROLE_SLUGS } from "@threahq/types"
import {
  WorkosAuthzAdminService,
  WorkosAuthzRepository,
  WorkspaceOwnerBackfill,
  type AdminActor,
} from "../../src/features/workos-authz"
import { setupTestDatabase } from "./setup"

describe("WorkspaceOwnerBackfill", () => {
  let pool: Pool
  let workos: StubWorkosOrgService
  let adminService: WorkosAuthzAdminService
  let backfill: WorkspaceOwnerBackfill

  const orgA = "org_backfill_a"
  const orgB = "org_backfill_b"
  const orgOrphan = "org_backfill_orphan"
  const wsA = "ws_backfill_a"
  const wsB = "ws_backfill_b"
  const wsOrphan = "ws_backfill_orphan"
  const wsNoOrg = "ws_backfill_no_org"
  const creatorA = "user_backfill_creator_a"
  const creatorB = "user_backfill_creator_b"
  const creatorOrphan = "user_backfill_creator_orphan"
  const creatorNoOrg = "user_backfill_creator_no_org"
  const actor: AdminActor = { workosUserId: "system-owner-backfill", isPlatformAdmin: true }

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    // Backfill scans every workspace_registry row with a non-null
    // workos_organization_id; truncate both tables so leaked rows from sibling
    // integration tests can't inflate workspacesScanned.
    await pool.query("TRUNCATE workspace_registry, workos_organization_memberships CASCADE")
    workos = new StubWorkosOrgService()
    adminService = new WorkosAuthzAdminService({ pool, workosOrgService: workos })
    backfill = new WorkspaceOwnerBackfill(pool, adminService, actor)
  })

  test("upgrades an existing admin creator to owner via changeRole", async () => {
    await seedWorkspace(pool, wsA, creatorA, orgA)
    await seedMembership(pool, orgA, creatorA, "om_a_creator", [WORKSPACE_ROLE_SLUGS.ADMIN])
    workos.setOrganizationMemberships(orgA, [
      stubMembership("om_a_creator", orgA, creatorA, WORKSPACE_ROLE_SLUGS.ADMIN),
    ])

    const result = await backfill.run()

    expect(result).toMatchObject({
      workspacesScanned: 1,
      alreadyOwners: 0,
      upgraded: 1,
      newlyAssigned: 0,
      errors: [],
    })
    const memberships = await workos.listOrganizationMemberships(orgA)
    const creator = memberships.find((m) => m.userId === creatorA)
    expect(creator?.roleSlugs).toEqual([WORKSPACE_ROLE_SLUGS.OWNER])
  })

  test("assigns owner to a creator with no mirror row via assignRole", async () => {
    await seedWorkspace(pool, wsOrphan, creatorOrphan, orgOrphan)

    const result = await backfill.run()

    expect(result).toMatchObject({
      workspacesScanned: 1,
      alreadyOwners: 0,
      upgraded: 0,
      newlyAssigned: 1,
      errors: [],
    })
    const memberships = await workos.listOrganizationMemberships(orgOrphan)
    expect(
      memberships.some((m) => m.userId === creatorOrphan && m.roleSlugs.includes(WORKSPACE_ROLE_SLUGS.OWNER))
    ).toBe(true)
  })

  test("skips creators that already have the owner role", async () => {
    await seedWorkspace(pool, wsA, creatorA, orgA)
    await seedMembership(pool, orgA, creatorA, "om_a_owner", [WORKSPACE_ROLE_SLUGS.OWNER])
    workos.setOrganizationMemberships(orgA, [stubMembership("om_a_owner", orgA, creatorA, WORKSPACE_ROLE_SLUGS.OWNER)])

    const result = await backfill.run()

    expect(result).toMatchObject({
      workspacesScanned: 1,
      alreadyOwners: 1,
      upgraded: 0,
      newlyAssigned: 0,
      errors: [],
    })
  })

  test("ignores workspaces without a workos_organization_id", async () => {
    await seedWorkspace(pool, wsNoOrg, creatorNoOrg, null)

    const result = await backfill.run()

    expect(result.workspacesScanned).toBe(0)
    expect(result.upgraded).toBe(0)
    expect(result.newlyAssigned).toBe(0)
  })

  test("dry-run classifies candidates without calling WorkOS", async () => {
    await seedWorkspace(pool, wsA, creatorA, orgA)
    await seedMembership(pool, orgA, creatorA, "om_a_creator", [WORKSPACE_ROLE_SLUGS.ADMIN])
    workos.setOrganizationMemberships(orgA, [
      stubMembership("om_a_creator", orgA, creatorA, WORKSPACE_ROLE_SLUGS.ADMIN),
    ])
    await seedWorkspace(pool, wsOrphan, creatorOrphan, orgOrphan)

    const result = await backfill.run({ dryRun: true })

    expect(result).toMatchObject({
      workspacesScanned: 2,
      alreadyOwners: 0,
      upgraded: 1,
      newlyAssigned: 1,
      errors: [],
    })
    // WorkOS state must be untouched: creator is still admin, orphan has no membership.
    const orgAMembers = await workos.listOrganizationMemberships(orgA)
    expect(orgAMembers.find((m) => m.userId === creatorA)?.roleSlugs).toEqual([WORKSPACE_ROLE_SLUGS.ADMIN])
    const orphanMembers = await workos.listOrganizationMemberships(orgOrphan)
    expect(orphanMembers).toHaveLength(0)
  })

  test("is idempotent across runs", async () => {
    await seedWorkspace(pool, wsA, creatorA, orgA)
    await seedMembership(pool, orgA, creatorA, "om_a_creator", [WORKSPACE_ROLE_SLUGS.ADMIN])
    workos.setOrganizationMemberships(orgA, [
      stubMembership("om_a_creator", orgA, creatorA, WORKSPACE_ROLE_SLUGS.ADMIN),
    ])

    const first = await backfill.run()
    expect(first.upgraded).toBe(1)

    // Reflect the WorkOS mutation into the mirror, since the poller would
    // normally do this asynchronously and we're not running it here.
    await pool.query(
      `UPDATE workos_organization_memberships
       SET role_slugs = $1, last_event_at = NOW()
       WHERE workos_organization_id = $2 AND workos_user_id = $3`,
      [[WORKSPACE_ROLE_SLUGS.OWNER], orgA, creatorA]
    )

    const second = await backfill.run()
    expect(second).toMatchObject({
      workspacesScanned: 1,
      alreadyOwners: 1,
      upgraded: 0,
      newlyAssigned: 0,
      errors: [],
    })
  })

  test("collects per-workspace errors without aborting the run", async () => {
    await seedWorkspace(pool, wsA, creatorA, orgA)
    await seedMembership(pool, orgA, creatorA, "om_a_creator", [WORKSPACE_ROLE_SLUGS.ADMIN])
    workos.setOrganizationMemberships(orgA, [
      stubMembership("om_a_creator", orgA, creatorA, WORKSPACE_ROLE_SLUGS.ADMIN),
    ])
    await seedWorkspace(pool, wsB, creatorB, orgB)
    await seedMembership(pool, orgB, creatorB, "om_b_creator", [WORKSPACE_ROLE_SLUGS.MEMBER])
    workos.setOrganizationMemberships(orgB, [
      stubMembership("om_b_creator", orgB, creatorB, WORKSPACE_ROLE_SLUGS.MEMBER),
    ])

    const originalChangeRole = workos.changeOrganizationMembershipRole.bind(workos)
    workos.changeOrganizationMembershipRole = async (params) => {
      if (params.organizationMembershipId === "om_a_creator") {
        throw new Error("simulated WorkOS error")
      }
      return originalChangeRole(params)
    }

    const result = await backfill.run()

    expect(result.upgraded).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.workspaceId).toBe(wsA)
    expect(result.errors[0]?.error).toContain("simulated WorkOS error")
  })
})

async function seedWorkspace(
  pool: Pool,
  workspaceId: string,
  createdByWorkosUserId: string,
  workosOrganizationId: string | null
): Promise<void> {
  await pool.query(
    `INSERT INTO workspace_registry (id, name, slug, region, created_by_workos_user_id, workos_organization_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [workspaceId, workspaceId, workspaceId.replace(/_/g, "-"), "us-east-1", createdByWorkosUserId, workosOrganizationId]
  )
}

async function seedMembership(
  pool: Pool,
  organizationId: string,
  workosUserId: string,
  membershipId: string,
  roleSlugs: string[]
): Promise<void> {
  await WorkosAuthzRepository.upsertMembershipFromBackfill(pool, {
    organizationMembershipId: membershipId,
    workosOrganizationId: organizationId,
    workosUserId,
    status: "active",
    roleSlugs,
    observedAt: new Date(),
  })
}

function stubMembership(
  id: string,
  organizationId: string,
  userId: string,
  roleSlug: string
): import("@threahq/backend-common").WorkosOrganizationMembership {
  return {
    id,
    organizationId,
    userId,
    status: "active",
    roleSlugs: [roleSlug],
    updatedAt: new Date(),
  }
}
