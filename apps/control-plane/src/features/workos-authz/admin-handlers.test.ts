import { afterEach, describe, expect, mock, test } from "bun:test"
import { WORKSPACE_ROLE_SLUGS } from "@threahq/types"
import { createBackofficeAuthzAdminHandlers, createInternalAuthzAdminHandlers } from "./admin-handlers"
import type { WorkosAuthzAdminService } from "./admin-service"

function createResponse() {
  const res: {
    statusCode: number
    body: unknown
    status: ReturnType<typeof mock>
    json: ReturnType<typeof mock>
    end: ReturnType<typeof mock>
  } = {
    statusCode: 200,
    body: undefined,
    status: mock(() => res),
    json: mock(() => res),
    end: mock(() => res),
  }
  res.status = mock((code: number) => {
    res.statusCode = code
    return res
  })
  res.end = mock(() => res)
  res.json = mock((body: unknown) => {
    res.body = body
    return res
  })
  return res
}

function createPoolWithOrg(orgId: string | null) {
  return {
    query: mock(async () => ({
      rows: orgId === null ? [] : [{ workos_organization_id: orgId }],
    })),
  } as any
}

function createAdminServiceStub() {
  return {
    changeRole: mock(async () => undefined),
    removeMember: mock(async () => undefined),
    assignRole: mock(async () => undefined),
  } as unknown as WorkosAuthzAdminService & {
    changeRole: ReturnType<typeof mock>
    removeMember: ReturnType<typeof mock>
    assignRole: ReturnType<typeof mock>
  }
}

describe("createInternalAuthzAdminHandlers", () => {
  afterEach(() => {
    mock.restore()
  })

  test("changeRole resolves org id, forwards actor with isPlatformAdmin=false", async () => {
    const pool = createPoolWithOrg("org_workos_123")
    const adminService = createAdminServiceStub()
    const handlers = createInternalAuthzAdminHandlers({ pool, adminService })
    const res = createResponse()

    await handlers.changeRole(
      {
        params: { workspaceId: "ws_1", userId: "user_target" },
        body: { actor: { workosUserId: "user_caller" }, roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN },
      } as any,
      res as any
    )

    expect(adminService.changeRole).toHaveBeenCalledTimes(1)
    expect(adminService.changeRole.mock.calls[0][0]).toEqual({
      actor: { workosUserId: "user_caller", isPlatformAdmin: false },
      organizationId: "org_workos_123",
      targetUserId: "user_target",
      roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
    })
    expect(res.statusCode).toBe(204)
  })

  test("removeMember resolves org id and forwards non-admin actor", async () => {
    const pool = createPoolWithOrg("org_workos_456")
    const adminService = createAdminServiceStub()
    const handlers = createInternalAuthzAdminHandlers({ pool, adminService })
    const res = createResponse()

    await handlers.removeMember(
      {
        params: { workspaceId: "ws_2", userId: "user_target" },
        body: { actor: { workosUserId: "user_caller" } },
      } as any,
      res as any
    )

    expect(adminService.removeMember).toHaveBeenCalledTimes(1)
    expect(adminService.removeMember.mock.calls[0][0]).toEqual({
      actor: { workosUserId: "user_caller", isPlatformAdmin: false },
      organizationId: "org_workos_456",
      targetUserId: "user_target",
    })
    expect(res.statusCode).toBe(204)
  })

  test("rejects when workspace not linked to a WorkOS org", async () => {
    const pool = createPoolWithOrg(null)
    const adminService = createAdminServiceStub()
    const handlers = createInternalAuthzAdminHandlers({ pool, adminService })
    const res = createResponse()

    await expect(
      handlers.changeRole(
        {
          params: { workspaceId: "ws_x", userId: "user_target" },
          body: { actor: { workosUserId: "user_caller" }, roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN },
        } as any,
        res as any
      )
    ).rejects.toMatchObject({ status: 404, code: "NOT_LINKED" })
    expect(adminService.changeRole).not.toHaveBeenCalled()
  })

  test("rejects invalid roleSlug", async () => {
    const pool = createPoolWithOrg("org_workos_123")
    const adminService = createAdminServiceStub()
    const handlers = createInternalAuthzAdminHandlers({ pool, adminService })
    const res = createResponse()

    await expect(
      handlers.changeRole(
        {
          params: { workspaceId: "ws_1", userId: "user_target" },
          body: { actor: { workosUserId: "user_caller" }, roleSlug: "superuser" },
        } as any,
        res as any
      )
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" })
    expect(adminService.changeRole).not.toHaveBeenCalled()
  })

  test("rejects missing actor.workosUserId", async () => {
    const pool = createPoolWithOrg("org_workos_123")
    const adminService = createAdminServiceStub()
    const handlers = createInternalAuthzAdminHandlers({ pool, adminService })
    const res = createResponse()

    await expect(
      handlers.changeRole(
        {
          params: { workspaceId: "ws_1", userId: "user_target" },
          body: { actor: {}, roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN },
        } as any,
        res as any
      )
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" })
  })
})

describe("createBackofficeAuthzAdminHandlers", () => {
  afterEach(() => {
    mock.restore()
  })

  test("changeRole uses authUser.id as actor with isPlatformAdmin=true", async () => {
    const pool = createPoolWithOrg("org_workos_123")
    const adminService = createAdminServiceStub()
    const handlers = createBackofficeAuthzAdminHandlers({ pool, adminService })
    const res = createResponse()

    await handlers.changeRole(
      {
        authUser: { id: "user_platform_admin", email: "p@a", permissions: null },
        params: { id: "ws_1", userId: "user_target" },
        body: { roleSlug: WORKSPACE_ROLE_SLUGS.MEMBER },
      } as any,
      res as any
    )

    expect(adminService.changeRole).toHaveBeenCalledTimes(1)
    expect(adminService.changeRole.mock.calls[0][0]).toEqual({
      actor: { workosUserId: "user_platform_admin", isPlatformAdmin: true },
      organizationId: "org_workos_123",
      targetUserId: "user_target",
      roleSlug: WORKSPACE_ROLE_SLUGS.MEMBER,
    })
    expect(res.statusCode).toBe(204)
  })

  test("removeMember uses authUser.id as platform-admin actor", async () => {
    const pool = createPoolWithOrg("org_workos_123")
    const adminService = createAdminServiceStub()
    const handlers = createBackofficeAuthzAdminHandlers({ pool, adminService })
    const res = createResponse()

    await handlers.removeMember(
      {
        authUser: { id: "user_platform_admin", email: "p@a", permissions: null },
        params: { id: "ws_1", userId: "user_target" },
        body: {},
      } as any,
      res as any
    )

    expect(adminService.removeMember).toHaveBeenCalledTimes(1)
    expect(adminService.removeMember.mock.calls[0][0]).toEqual({
      actor: { workosUserId: "user_platform_admin", isPlatformAdmin: true },
      organizationId: "org_workos_123",
      targetUserId: "user_target",
    })
    expect(res.statusCode).toBe(204)
  })

  test("rejects when not authenticated", async () => {
    const pool = createPoolWithOrg("org_workos_123")
    const adminService = createAdminServiceStub()
    const handlers = createBackofficeAuthzAdminHandlers({ pool, adminService })
    const res = createResponse()

    await expect(
      handlers.changeRole(
        {
          params: { id: "ws_1", userId: "user_target" },
          body: { roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN },
        } as any,
        res as any
      )
    ).rejects.toMatchObject({ status: 401, code: "NOT_AUTHENTICATED" })
  })

  test("rejects when workspace not linked", async () => {
    const pool = createPoolWithOrg(null)
    const adminService = createAdminServiceStub()
    const handlers = createBackofficeAuthzAdminHandlers({ pool, adminService })
    const res = createResponse()

    await expect(
      handlers.removeMember(
        {
          authUser: { id: "user_platform_admin", email: "p@a", permissions: null },
          params: { id: "ws_x", userId: "user_target" },
          body: {},
        } as any,
        res as any
      )
    ).rejects.toMatchObject({ status: 404, code: "NOT_LINKED" })
    expect(adminService.removeMember).not.toHaveBeenCalled()
  })

  test("assignMember forwards platform-admin actor with target workosUserId and roleSlug", async () => {
    const pool = createPoolWithOrg("org_workos_123")
    const adminService = createAdminServiceStub()
    const handlers = createBackofficeAuthzAdminHandlers({ pool, adminService })
    const res = createResponse()

    await handlers.assignMember(
      {
        authUser: { id: "user_platform_admin", email: "p@a", permissions: null },
        params: { id: "ws_1" },
        body: { workosUserId: "user_target", roleSlug: WORKSPACE_ROLE_SLUGS.MEMBER },
      } as any,
      res as any
    )

    expect(adminService.assignRole).toHaveBeenCalledTimes(1)
    expect(adminService.assignRole.mock.calls[0][0]).toEqual({
      actor: { workosUserId: "user_platform_admin", isPlatformAdmin: true },
      organizationId: "org_workos_123",
      targetUserId: "user_target",
      roleSlug: WORKSPACE_ROLE_SLUGS.MEMBER,
    })
    expect(res.statusCode).toBe(204)
  })

  test("assignMember rejects missing workosUserId", async () => {
    const pool = createPoolWithOrg("org_workos_123")
    const adminService = createAdminServiceStub()
    const handlers = createBackofficeAuthzAdminHandlers({ pool, adminService })
    const res = createResponse()

    await expect(
      handlers.assignMember(
        {
          authUser: { id: "user_platform_admin", email: "p@a", permissions: null },
          params: { id: "ws_1" },
          body: { roleSlug: WORKSPACE_ROLE_SLUGS.MEMBER },
        } as any,
        res as any
      )
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" })
    expect(adminService.assignRole).not.toHaveBeenCalled()
  })
})
