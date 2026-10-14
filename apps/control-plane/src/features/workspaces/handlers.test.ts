import { describe, expect, mock, test } from "bun:test"
import type { Request, Response } from "express"
import { createWorkspaceHandlers } from "./handlers"

function createResponse() {
  const res: any = { statusCode: 200 }
  res.status = mock((code: number) => {
    res.statusCode = code
    return res
  })
  res.json = mock((body: unknown) => {
    res.body = body
    return res
  })
  return res as Response & { body: unknown; statusCode: number }
}

function createHandlers(isMember: (workspaceId: string, workosUserId: string) => Promise<boolean>) {
  const workspaceService = { isMember: mock(isMember) } as any
  const shadowService = {} as any
  return { handlers: createWorkspaceHandlers({ workspaceService, shadowService }), workspaceService }
}

describe("workspace.confirmMembership", () => {
  test("returns { member: true } when the registry has the membership", async () => {
    const { handlers, workspaceService } = createHandlers(async () => true)
    const req = { params: { workspaceId: "ws_1", workosUserId: "workos_user_1" } } as unknown as Request
    const res = createResponse()

    await handlers.confirmMembership(req, res)

    expect(workspaceService.isMember).toHaveBeenCalledWith("ws_1", "workos_user_1")
    expect(res.body).toEqual({ member: true })
  })

  test("returns { member: false } when there is no membership", async () => {
    const { handlers } = createHandlers(async () => false)
    const req = { params: { workspaceId: "ws_1", workosUserId: "workos_user_2" } } as unknown as Request
    const res = createResponse()

    await handlers.confirmMembership(req, res)

    expect(res.body).toEqual({ member: false })
  })

  test("rejects with a 400 HttpError when params are missing", async () => {
    const { handlers } = createHandlers(async () => true)
    const req = { params: { workspaceId: "ws_1" } } as unknown as Request
    const res = createResponse()

    await expect(handlers.confirmMembership(req, res)).rejects.toMatchObject({
      name: "HttpError",
      status: 400,
      code: "VALIDATION_ERROR",
    })
  })
})

describe("workspace.list", () => {
  function listHandlers(canCreate: () => Promise<boolean>) {
    const workspaceService = { listForUser: mock(async () => []), canCreate: mock(canCreate) } as any
    const shadowService = { listPendingForEmail: mock(async () => []) } as any
    return createWorkspaceHandlers({ workspaceService, shadowService })
  }
  const req = { workosUserId: "workos_user_1", authUser: { email: "user@example.com" } } as unknown as Request

  test("reports whether the account may create a workspace", async () => {
    const res = createResponse()
    await listHandlers(async () => true).list(req, res)
    expect(res.body).toEqual({ workspaces: [], pendingInvitations: [], canCreateWorkspace: true })
  })

  test("still lists workspaces when the eligibility lookup fails, leaving creation to the create check", async () => {
    const res = createResponse()
    await listHandlers(async () => {
      throw new Error("WorkOS unavailable")
    }).list(req, res)
    expect(res.body).toEqual({ workspaces: [], pendingInvitations: [], canCreateWorkspace: true })
  })
})
