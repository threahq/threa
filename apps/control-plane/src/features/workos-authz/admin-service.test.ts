import { describe, expect, test } from "bun:test"
import { StubWorkosOrgService, type WorkosOrganizationMembership } from "@threahq/backend-common"
import { WORKSPACE_ROLE_SLUGS } from "@threahq/types"
import { WorkosAuthzAdminService, type AdminActor } from "./admin-service"

const ORG_ID = "org_test_authz"

function fakePool() {
  const client = {
    query: async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ pg_try_advisory_lock: true }] }
      }
      return { rows: [] }
    },
    release: () => undefined,
  }
  return {
    connect: async () => client,
  } as any
}

function seedMembers(stub: StubWorkosOrgService, members: Array<{ userId: string; roleSlugs: string[] }>): void {
  const seeded: WorkosOrganizationMembership[] = members.map((m) => ({
    id: `om_${m.userId}`,
    organizationId: ORG_ID,
    userId: m.userId,
    status: "active",
    roleSlugs: m.roleSlugs,
    updatedAt: new Date(),
  }))
  stub.setOrganizationMemberships(ORG_ID, seeded)
}

function makeService(stub: StubWorkosOrgService) {
  return new WorkosAuthzAdminService({ pool: fakePool(), workosOrgService: stub })
}

const ADMIN_ACTOR = (id: string): AdminActor => ({ workosUserId: id, isPlatformAdmin: false })
const PLATFORM_ACTOR: AdminActor = { workosUserId: "platform_op", isPlatformAdmin: true }

describe("WorkosAuthzAdminService.changeRole — actor gates", () => {
  test("admin actor may change a member to admin", async () => {
    const stub = new StubWorkosOrgService()
    seedMembers(stub, [
      { userId: "actor_admin", roleSlugs: [WORKSPACE_ROLE_SLUGS.ADMIN] },
      { userId: "target_member", roleSlugs: [WORKSPACE_ROLE_SLUGS.MEMBER] },
      { userId: "the_owner", roleSlugs: [WORKSPACE_ROLE_SLUGS.OWNER] },
    ])

    await makeService(stub).changeRole({
      actor: ADMIN_ACTOR("actor_admin"),
      organizationId: ORG_ID,
      targetUserId: "target_member",
      roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
    })

    const memberships = await stub.listOrganizationMemberships(ORG_ID)
    const target = memberships.find((m) => m.userId === "target_member")
    expect(target?.roleSlugs).toEqual([WORKSPACE_ROLE_SLUGS.ADMIN])
  })

  test("admin actor cannot promote to owner", async () => {
    const stub = new StubWorkosOrgService()
    seedMembers(stub, [
      { userId: "actor_admin", roleSlugs: [WORKSPACE_ROLE_SLUGS.ADMIN] },
      { userId: "target_member", roleSlugs: [WORKSPACE_ROLE_SLUGS.MEMBER] },
      { userId: "the_owner", roleSlugs: [WORKSPACE_ROLE_SLUGS.OWNER] },
    ])

    await expect(
      makeService(stub).changeRole({
        actor: ADMIN_ACTOR("actor_admin"),
        organizationId: ORG_ID,
        targetUserId: "target_member",
        roleSlug: WORKSPACE_ROLE_SLUGS.OWNER,
      })
    ).rejects.toMatchObject({ status: 403, code: "OWNER_ACTION" })
  })

  test("admin actor cannot demote an existing owner", async () => {
    const stub = new StubWorkosOrgService()
    seedMembers(stub, [
      { userId: "actor_admin", roleSlugs: [WORKSPACE_ROLE_SLUGS.ADMIN] },
      { userId: "second_owner", roleSlugs: [WORKSPACE_ROLE_SLUGS.OWNER] },
      { userId: "the_owner", roleSlugs: [WORKSPACE_ROLE_SLUGS.OWNER] },
    ])

    await expect(
      makeService(stub).changeRole({
        actor: ADMIN_ACTOR("actor_admin"),
        organizationId: ORG_ID,
        targetUserId: "second_owner",
        roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
      })
    ).rejects.toMatchObject({ status: 403, code: "OWNER_ACTION" })
  })

  test("member actor cannot manage members", async () => {
    const stub = new StubWorkosOrgService()
    seedMembers(stub, [
      { userId: "actor_member", roleSlugs: [WORKSPACE_ROLE_SLUGS.MEMBER] },
      { userId: "target_member", roleSlugs: [WORKSPACE_ROLE_SLUGS.MEMBER] },
      { userId: "the_owner", roleSlugs: [WORKSPACE_ROLE_SLUGS.OWNER] },
    ])

    await expect(
      makeService(stub).changeRole({
        actor: ADMIN_ACTOR("actor_member"),
        organizationId: ORG_ID,
        targetUserId: "target_member",
        roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
      })
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" })
  })

  test("owner actor may demote another owner (with a remaining owner)", async () => {
    const stub = new StubWorkosOrgService()
    seedMembers(stub, [
      { userId: "actor_owner", roleSlugs: [WORKSPACE_ROLE_SLUGS.OWNER] },
      { userId: "second_owner", roleSlugs: [WORKSPACE_ROLE_SLUGS.OWNER] },
    ])

    await makeService(stub).changeRole({
      actor: ADMIN_ACTOR("actor_owner"),
      organizationId: ORG_ID,
      targetUserId: "second_owner",
      roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
    })

    const memberships = await stub.listOrganizationMemberships(ORG_ID)
    expect(memberships.find((m) => m.userId === "second_owner")?.roleSlugs).toEqual([WORKSPACE_ROLE_SLUGS.ADMIN])
  })

  test("platform admin bypasses workspace-role check but still respects last-owner", async () => {
    const stub = new StubWorkosOrgService()
    seedMembers(stub, [{ userId: "the_owner", roleSlugs: [WORKSPACE_ROLE_SLUGS.OWNER] }])

    await expect(
      makeService(stub).changeRole({
        actor: PLATFORM_ACTOR,
        organizationId: ORG_ID,
        targetUserId: "the_owner",
        roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
      })
    ).rejects.toMatchObject({ status: 422, code: "LAST_OWNER" })
  })
})

describe("WorkosAuthzAdminService.removeMember — actor gates", () => {
  test("admin actor may remove a member", async () => {
    const stub = new StubWorkosOrgService()
    seedMembers(stub, [
      { userId: "actor_admin", roleSlugs: [WORKSPACE_ROLE_SLUGS.ADMIN] },
      { userId: "target_member", roleSlugs: [WORKSPACE_ROLE_SLUGS.MEMBER] },
      { userId: "the_owner", roleSlugs: [WORKSPACE_ROLE_SLUGS.OWNER] },
    ])

    await makeService(stub).removeMember({
      actor: ADMIN_ACTOR("actor_admin"),
      organizationId: ORG_ID,
      targetUserId: "target_member",
    })

    const memberships = await stub.listOrganizationMemberships(ORG_ID)
    expect(memberships.find((m) => m.userId === "target_member")).toBeUndefined()
  })

  test("admin actor cannot remove an owner", async () => {
    const stub = new StubWorkosOrgService()
    seedMembers(stub, [
      { userId: "actor_admin", roleSlugs: [WORKSPACE_ROLE_SLUGS.ADMIN] },
      { userId: "second_owner", roleSlugs: [WORKSPACE_ROLE_SLUGS.OWNER] },
      { userId: "the_owner", roleSlugs: [WORKSPACE_ROLE_SLUGS.OWNER] },
    ])

    await expect(
      makeService(stub).removeMember({
        actor: ADMIN_ACTOR("actor_admin"),
        organizationId: ORG_ID,
        targetUserId: "second_owner",
      })
    ).rejects.toMatchObject({ status: 403, code: "OWNER_ACTION" })
  })
})
