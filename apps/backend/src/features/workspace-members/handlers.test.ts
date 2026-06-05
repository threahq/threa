import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { WORKSPACE_USER_ROLES } from "@threa/types"
import type { Pool } from "pg"
import type { ControlPlaneClient } from "../../lib/control-plane-client"
import { createWorkspaceMemberManagementHandlers } from "./handlers"
import { UserRepository } from "../workspaces"

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

function createControlPlaneClientStub() {
  return {
    changeWorkspaceMemberRole: mock(async () => undefined),
    removeWorkspaceMember: mock(async () => undefined),
  } as unknown as ControlPlaneClient & {
    changeWorkspaceMemberRole: ReturnType<typeof mock>
    removeWorkspaceMember: ReturnType<typeof mock>
  }
}

const fakeUser = {
  id: "usr_target",
  workspaceId: "ws_1",
  workosUserId: "workos_target",
  email: "target@example.com",
  role: "member" as const,
  slug: "target",
  name: "Target User",
  description: null,
  avatarUrl: null,
  timezone: null,
  locale: null,
  pronouns: null,
  phone: null,
  githubUsername: null,
  statusEmoji: null,
  statusText: null,
  statusExpiresAt: null,
  statusPausesNotifications: false,
  notificationsPausedUntil: null,
  notificationsPausedIndefinitely: false,
  setupCompleted: true,
  joinedAt: new Date(),
}

describe("createWorkspaceMemberManagementHandlers", () => {
  afterEach(() => {
    mock.restore()
  })

  test("changeRole resolves target workosUserId and forwards to control plane", async () => {
    const findById = spyOn(UserRepository, "findById").mockResolvedValue(fakeUser)
    const controlPlaneClient = createControlPlaneClientStub()
    const handlers = createWorkspaceMemberManagementHandlers({ pool: {} as Pool, controlPlaneClient })
    const res = createResponse()

    await handlers.changeRole(
      {
        workspaceId: "ws_1",
        user: { workosUserId: "workos_caller" },
        params: { userId: "usr_target" },
        body: { roleSlug: WORKSPACE_USER_ROLES[1] },
      } as never,
      res as never
    )

    expect(findById).toHaveBeenCalledWith(expect.anything(), "ws_1", "usr_target")
    expect(controlPlaneClient.changeWorkspaceMemberRole.mock.calls[0][0]).toEqual({
      workspaceId: "ws_1",
      targetUserId: "workos_target",
      actorWorkosUserId: "workos_caller",
      roleSlug: WORKSPACE_USER_ROLES[1],
    })
    expect(res.statusCode).toBe(204)
  })

  test("removeMember resolves target workosUserId and forwards", async () => {
    const findById = spyOn(UserRepository, "findById").mockResolvedValue(fakeUser)
    const controlPlaneClient = createControlPlaneClientStub()
    const handlers = createWorkspaceMemberManagementHandlers({ pool: {} as Pool, controlPlaneClient })
    const res = createResponse()

    await handlers.removeMember(
      {
        workspaceId: "ws_1",
        user: { workosUserId: "workos_caller" },
        params: { userId: "usr_target" },
        body: {},
      } as never,
      res as never
    )

    expect(findById).toHaveBeenCalledWith(expect.anything(), "ws_1", "usr_target")
    expect(controlPlaneClient.removeWorkspaceMember.mock.calls[0][0]).toEqual({
      workspaceId: "ws_1",
      targetUserId: "workos_target",
      actorWorkosUserId: "workos_caller",
    })
    expect(res.statusCode).toBe(204)
  })

  test("rejects when not authenticated", async () => {
    const controlPlaneClient = createControlPlaneClientStub()
    const handlers = createWorkspaceMemberManagementHandlers({ pool: {} as Pool, controlPlaneClient })
    const res = createResponse()

    await expect(
      handlers.changeRole(
        {
          params: { userId: "usr_target" },
          body: { roleSlug: WORKSPACE_USER_ROLES[1] },
        } as never,
        res as never
      )
    ).rejects.toMatchObject({ status: 401, code: "NOT_AUTHENTICATED" })
    expect(controlPlaneClient.changeWorkspaceMemberRole).not.toHaveBeenCalled()
  })

  test("rejects invalid roleSlug", async () => {
    const controlPlaneClient = createControlPlaneClientStub()
    const handlers = createWorkspaceMemberManagementHandlers({ pool: {} as Pool, controlPlaneClient })
    const res = createResponse()

    await expect(
      handlers.changeRole(
        {
          workspaceId: "ws_1",
          user: { workosUserId: "workos_caller" },
          params: { userId: "usr_target" },
          body: { roleSlug: "superuser" },
        } as never,
        res as never
      )
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" })
    expect(controlPlaneClient.changeWorkspaceMemberRole).not.toHaveBeenCalled()
  })

  test("rejects when target user does not exist in workspace", async () => {
    spyOn(UserRepository, "findById").mockResolvedValue(null)
    const controlPlaneClient = createControlPlaneClientStub()
    const handlers = createWorkspaceMemberManagementHandlers({ pool: {} as Pool, controlPlaneClient })
    const res = createResponse()

    await expect(
      handlers.removeMember(
        {
          workspaceId: "ws_1",
          user: { workosUserId: "workos_caller" },
          params: { userId: "usr_unknown" },
          body: {},
        } as never,
        res as never
      )
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" })
    expect(controlPlaneClient.removeWorkspaceMember).not.toHaveBeenCalled()
  })

  test("returns 503 when control plane is not configured", async () => {
    const handlers = createWorkspaceMemberManagementHandlers({ pool: {} as Pool, controlPlaneClient: null })
    const res = createResponse()

    await expect(
      handlers.changeRole(
        {
          workspaceId: "ws_1",
          user: { workosUserId: "workos_caller" },
          params: { userId: "usr_target" },
          body: { roleSlug: WORKSPACE_USER_ROLES[1] },
        } as never,
        res as never
      )
    ).rejects.toMatchObject({ status: 503, code: "CONTROL_PLANE_UNAVAILABLE" })

    await expect(
      handlers.removeMember(
        {
          workspaceId: "ws_1",
          user: { workosUserId: "workos_caller" },
          params: { userId: "usr_target" },
          body: {},
        } as never,
        res as never
      )
    ).rejects.toMatchObject({ status: 503, code: "CONTROL_PLANE_UNAVAILABLE" })
  })
})
