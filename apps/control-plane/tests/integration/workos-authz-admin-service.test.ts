import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { HttpError, StubWorkosOrgService } from "@threahq/backend-common"
import { WORKSPACE_ROLE_SLUGS, type WorkspaceRoleSlug } from "@threahq/types"
import { WorkosAuthzAdminService, WorkosAuthzRepository, type AdminActor } from "../../src/features/workos-authz"
import { setupTestDatabase } from "./setup"

describe("WorkosAuthzAdminService", () => {
  let pool: Pool
  let workos: StubWorkosOrgService
  let service: WorkosAuthzAdminService

  const orgId = "org_test_admin_service"
  const ownerUserId = "user_test_owner"
  const adminUserId = "user_test_admin"
  const memberUserId = "user_test_member"
  const otherOwnerUserId = "user_test_other_owner"

  const ownerActor: AdminActor = { workosUserId: ownerUserId, isPlatformAdmin: false }
  const platformAdminActor: AdminActor = { workosUserId: "user_platform_admin", isPlatformAdmin: true }
  const nonOwnerActor: AdminActor = { workosUserId: memberUserId, isPlatformAdmin: false }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    workos = new StubWorkosOrgService()
    service = new WorkosAuthzAdminService({ pool, workosOrgService: workos })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM workos_organization_memberships WHERE workos_organization_id = $1", [orgId])
    workos.clearMirrorEvents()
    workos.setOrganizationMemberships(orgId, [])
    await seedMembership(pool, orgId, ownerUserId, "om_owner", [WORKSPACE_ROLE_SLUGS.OWNER])
    await seedMembership(pool, orgId, adminUserId, "om_admin", [WORKSPACE_ROLE_SLUGS.ADMIN])
    await seedMembership(pool, orgId, memberUserId, "om_member", [WORKSPACE_ROLE_SLUGS.MEMBER])
    workos.setOrganizationMemberships(orgId, [
      stubMembership("om_owner", orgId, ownerUserId, WORKSPACE_ROLE_SLUGS.OWNER),
      stubMembership("om_admin", orgId, adminUserId, WORKSPACE_ROLE_SLUGS.ADMIN),
      stubMembership("om_member", orgId, memberUserId, WORKSPACE_ROLE_SLUGS.MEMBER),
    ])
  })

  describe("assignRole", () => {
    test("owner can assign a role to a new member", async () => {
      const newUserId = "user_test_new"
      await service.assignRole({
        actor: ownerActor,
        organizationId: orgId,
        targetUserId: newUserId,
        roleSlug: WORKSPACE_ROLE_SLUGS.MEMBER,
      })

      const memberships = await workos.listOrganizationMemberships(orgId)
      const created = memberships.find((m) => m.userId === newUserId)
      expect(created).toBeDefined()
      expect(created!.roleSlugs).toEqual([WORKSPACE_ROLE_SLUGS.MEMBER])
    })

    test("platform admin can assign a role without being a workspace owner", async () => {
      await service.assignRole({
        actor: platformAdminActor,
        organizationId: orgId,
        targetUserId: "user_test_new",
        roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
      })
      const memberships = await workos.listOrganizationMemberships(orgId)
      expect(memberships.some((m) => m.userId === "user_test_new")).toBe(true)
    })

    test("non-owner actor is rejected with FORBIDDEN", async () => {
      await expectHttpError(
        service.assignRole({
          actor: nonOwnerActor,
          organizationId: orgId,
          targetUserId: "user_test_new",
          roleSlug: WORKSPACE_ROLE_SLUGS.MEMBER,
        }),
        { status: 403, code: "FORBIDDEN" }
      )
    })

    test("unknown role slug is rejected with INVALID_ROLE", async () => {
      await expectHttpError(
        service.assignRole({
          actor: ownerActor,
          organizationId: orgId,
          targetUserId: "user_test_new",
          roleSlug: "viewer" as unknown as WorkspaceRoleSlug,
        }),
        { status: 400, code: "INVALID_ROLE" }
      )
    })
  })

  describe("changeRole", () => {
    test("owner can promote a member to admin", async () => {
      await service.changeRole({
        actor: ownerActor,
        organizationId: orgId,
        targetUserId: memberUserId,
        roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
      })

      const memberships = await workos.listOrganizationMemberships(orgId)
      const target = memberships.find((m) => m.userId === memberUserId)
      expect(target!.roleSlugs).toEqual([WORKSPACE_ROLE_SLUGS.ADMIN])
    })

    test("rejects demoting the last remaining owner", async () => {
      await expectHttpError(
        service.changeRole({
          actor: platformAdminActor,
          organizationId: orgId,
          targetUserId: ownerUserId,
          roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
        }),
        { status: 422, code: "LAST_OWNER" }
      )
    })

    test("allows demoting an owner when another owner remains", async () => {
      await seedMembership(pool, orgId, otherOwnerUserId, "om_owner_2", [WORKSPACE_ROLE_SLUGS.OWNER])
      workos.setOrganizationMemberships(orgId, [
        stubMembership("om_owner", orgId, ownerUserId, WORKSPACE_ROLE_SLUGS.OWNER),
        stubMembership("om_owner_2", orgId, otherOwnerUserId, WORKSPACE_ROLE_SLUGS.OWNER),
        stubMembership("om_admin", orgId, adminUserId, WORKSPACE_ROLE_SLUGS.ADMIN),
        stubMembership("om_member", orgId, memberUserId, WORKSPACE_ROLE_SLUGS.MEMBER),
      ])

      await service.changeRole({
        actor: platformAdminActor,
        organizationId: orgId,
        targetUserId: otherOwnerUserId,
        roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
      })

      const memberships = await workos.listOrganizationMemberships(orgId)
      const target = memberships.find((m) => m.userId === otherOwnerUserId)
      expect(target!.roleSlugs).toEqual([WORKSPACE_ROLE_SLUGS.ADMIN])
    })

    test("owner cannot demote themselves", async () => {
      await seedMembership(pool, orgId, otherOwnerUserId, "om_owner_2", [WORKSPACE_ROLE_SLUGS.OWNER])
      workos.setOrganizationMemberships(orgId, [
        stubMembership("om_owner", orgId, ownerUserId, WORKSPACE_ROLE_SLUGS.OWNER),
        stubMembership("om_owner_2", orgId, otherOwnerUserId, WORKSPACE_ROLE_SLUGS.OWNER),
        stubMembership("om_admin", orgId, adminUserId, WORKSPACE_ROLE_SLUGS.ADMIN),
        stubMembership("om_member", orgId, memberUserId, WORKSPACE_ROLE_SLUGS.MEMBER),
      ])
      await expectHttpError(
        service.changeRole({
          actor: ownerActor,
          organizationId: orgId,
          targetUserId: ownerUserId,
          roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
        }),
        { status: 422, code: "SELF_DEMOTE" }
      )
    })

    test("rejects unknown target user with NOT_FOUND", async () => {
      await expectHttpError(
        service.changeRole({
          actor: ownerActor,
          organizationId: orgId,
          targetUserId: "user_does_not_exist",
          roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
        }),
        { status: 404, code: "NOT_FOUND" }
      )
    })

    test("non-owner actor is rejected before any other guard runs", async () => {
      await expectHttpError(
        service.changeRole({
          actor: nonOwnerActor,
          organizationId: orgId,
          targetUserId: memberUserId,
          roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
        }),
        { status: 403, code: "FORBIDDEN" }
      )
    })
  })

  describe("removeMember", () => {
    test("owner can remove a member", async () => {
      await service.removeMember({
        actor: ownerActor,
        organizationId: orgId,
        targetUserId: memberUserId,
      })
      const memberships = await workos.listOrganizationMemberships(orgId)
      expect(memberships.some((m) => m.userId === memberUserId)).toBe(false)
    })

    test("rejects removing the last remaining owner", async () => {
      await expectHttpError(
        service.removeMember({
          actor: platformAdminActor,
          organizationId: orgId,
          targetUserId: ownerUserId,
        }),
        { status: 422, code: "LAST_OWNER" }
      )
    })

    test("owner cannot remove themselves even when a co-owner exists", async () => {
      await seedMembership(pool, orgId, otherOwnerUserId, "om_owner_2", [WORKSPACE_ROLE_SLUGS.OWNER])
      workos.setOrganizationMemberships(orgId, [
        stubMembership("om_owner", orgId, ownerUserId, WORKSPACE_ROLE_SLUGS.OWNER),
        stubMembership("om_owner_2", orgId, otherOwnerUserId, WORKSPACE_ROLE_SLUGS.OWNER),
        stubMembership("om_admin", orgId, adminUserId, WORKSPACE_ROLE_SLUGS.ADMIN),
        stubMembership("om_member", orgId, memberUserId, WORKSPACE_ROLE_SLUGS.MEMBER),
      ])
      await expectHttpError(
        service.removeMember({
          actor: ownerActor,
          organizationId: orgId,
          targetUserId: ownerUserId,
        }),
        { status: 422, code: "SELF_DEMOTE" }
      )
    })

    test("rejects unknown target user with NOT_FOUND", async () => {
      await expectHttpError(
        service.removeMember({
          actor: ownerActor,
          organizationId: orgId,
          targetUserId: "user_does_not_exist",
        }),
        { status: 404, code: "NOT_FOUND" }
      )
    })

    test("non-owner actor is rejected", async () => {
      await expectHttpError(
        service.removeMember({
          actor: nonOwnerActor,
          organizationId: orgId,
          targetUserId: memberUserId,
        }),
        { status: 403, code: "FORBIDDEN" }
      )
    })
  })

  describe("concurrent writes", () => {
    test("two owners demoting each other in parallel: lock serializes, second is rejected, one owner remains", async () => {
      // Two owners (A = ownerUserId from beforeEach, B = otherOwnerUserId).
      // Each tries to demote the other; without the per-org advisory lock
      // both reads would see "2 owners", both guards pass, and WorkOS ends
      // with 0 owners. With the lock, the second caller re-reads WorkOS
      // after the first commits and sees that they themselves are no longer
      // an owner — assertActorMayTouchOwnership trips OWNER_ACTION because
      // demoting an owner requires owner-level permission. (If the second
      // caller had still held the owner role, the last-owner guard would
      // trip LAST_OWNER instead; either rejection proves the race is closed.)
      await seedMembership(pool, orgId, otherOwnerUserId, "om_owner_2", [WORKSPACE_ROLE_SLUGS.OWNER])
      workos.setOrganizationMemberships(orgId, [
        stubMembership("om_owner", orgId, ownerUserId, WORKSPACE_ROLE_SLUGS.OWNER),
        stubMembership("om_owner_2", orgId, otherOwnerUserId, WORKSPACE_ROLE_SLUGS.OWNER),
        stubMembership("om_admin", orgId, adminUserId, WORKSPACE_ROLE_SLUGS.ADMIN),
        stubMembership("om_member", orgId, memberUserId, WORKSPACE_ROLE_SLUGS.MEMBER),
      ])

      const actorA: AdminActor = { workosUserId: ownerUserId, isPlatformAdmin: false }
      const actorB: AdminActor = { workosUserId: otherOwnerUserId, isPlatformAdmin: false }

      const results = await Promise.allSettled([
        service.changeRole({
          actor: actorA,
          organizationId: orgId,
          targetUserId: otherOwnerUserId,
          roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
        }),
        service.changeRole({
          actor: actorB,
          organizationId: orgId,
          targetUserId: ownerUserId,
          roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
        }),
      ])

      const fulfilled = results.filter((r) => r.status === "fulfilled")
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(rejected[0]!.reason).toBeInstanceOf(HttpError)
      expect(["OWNER_ACTION", "LAST_OWNER"]).toContain((rejected[0]!.reason as HttpError).code)

      const memberships = await workos.listOrganizationMemberships(orgId)
      const remainingOwners = memberships.filter((m) => m.roleSlugs.includes(WORKSPACE_ROLE_SLUGS.OWNER))
      expect(remainingOwners).toHaveLength(1)
    })

    test("two parallel removes of co-owners: lock serializes, second sees LAST_OWNER", async () => {
      await seedMembership(pool, orgId, otherOwnerUserId, "om_owner_2", [WORKSPACE_ROLE_SLUGS.OWNER])
      workos.setOrganizationMemberships(orgId, [
        stubMembership("om_owner", orgId, ownerUserId, WORKSPACE_ROLE_SLUGS.OWNER),
        stubMembership("om_owner_2", orgId, otherOwnerUserId, WORKSPACE_ROLE_SLUGS.OWNER),
      ])

      // Platform admin removes each owner concurrently. Without the lock both
      // guards would pass; with the lock the second sees one owner remaining
      // and trips LAST_OWNER on its own removal.
      const results = await Promise.allSettled([
        service.removeMember({ actor: platformAdminActor, organizationId: orgId, targetUserId: ownerUserId }),
        service.removeMember({ actor: platformAdminActor, organizationId: orgId, targetUserId: otherOwnerUserId }),
      ])

      const fulfilled = results.filter((r) => r.status === "fulfilled")
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect((rejected[0]!.reason as HttpError).code).toBe("LAST_OWNER")

      const memberships = await workos.listOrganizationMemberships(orgId)
      const remainingOwners = memberships.filter((m) => m.roleSlugs.includes(WORKSPACE_ROLE_SLUGS.OWNER))
      expect(remainingOwners).toHaveLength(1)
    })
  })
})

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

async function expectHttpError(promise: Promise<unknown>, expected: { status: number; code: string }): Promise<void> {
  try {
    await promise
    throw new Error(`Expected HttpError ${expected.code} but call succeeded`)
  } catch (err) {
    if (!(err instanceof HttpError)) throw err
    expect(err.status).toBe(expected.status)
    expect(err.code).toBe(expected.code)
  }
}
