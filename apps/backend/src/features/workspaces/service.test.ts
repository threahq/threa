import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { PoolClient } from "pg"
import { WorkspaceService } from "./service"
import { UserRepository } from "./user-repository"
import { UserApiKeyRepository } from "../user-api-keys"
import { ReadStateRepository } from "../streams"
import { OutboxRepository } from "../../lib/outbox"
import * as db from "../../db"

type MockWorkosOrgService = {
  hasAcceptedWorkspaceCreationInvitation: ReturnType<typeof mock<(email: string) => Promise<boolean>>>
}

function createWorkspaceService(
  requireWorkspaceCreationInvite: boolean,
  workosOrgService?: MockWorkosOrgService
): WorkspaceService {
  return new WorkspaceService({} as never, {} as never, {} as never, workosOrgService as never, {
    requireWorkspaceCreationInvite,
  })
}

describe("WorkspaceService.createWorkspace invite gating", () => {
  const workosUserId = "workos_user_1"
  const email = "user@example.com"
  const userName = "User"
  const mockWorkspace = {
    id: "ws_1",
    name: "Test Workspace",
    slug: "test-workspace",
    createdBy: "usr_1",
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  const mockWithTransaction = spyOn(db, "withTransaction")

  beforeEach(() => {
    mockWithTransaction.mockReset().mockResolvedValue(mockWorkspace as never)
  })

  test("skips invite checks when invite requirement is disabled", async () => {
    const service = createWorkspaceService(false)

    const workspace = await service.createWorkspace({
      name: "Test Workspace",
      workosUserId,
      email,
      userName,
    })

    expect(workspace).toEqual(mockWorkspace)
    expect(mockWithTransaction).toHaveBeenCalledTimes(1)
  })

  test("does not bypass invite checks when invite requirement is enabled", async () => {
    const workosOrgService: MockWorkosOrgService = {
      hasAcceptedWorkspaceCreationInvitation: mock<(email: string) => Promise<boolean>>(() => Promise.resolve(false)),
    }
    const service = createWorkspaceService(true, workosOrgService)

    await expect(
      service.createWorkspace({
        name: "Test Workspace",
        workosUserId,
        email,
        userName,
      })
    ).rejects.toMatchObject({
      name: "HttpError",
      message: "Workspace creation requires a dedicated workspace invite.",
      status: 403,
      code: "WORKSPACE_CREATION_INVITE_REQUIRED",
    })

    expect(workosOrgService.hasAcceptedWorkspaceCreationInvitation).toHaveBeenCalledWith("user@example.com")
    expect(mockWithTransaction).not.toHaveBeenCalled()
  })

  test("throws when invite validation is enabled without WorkOS org service", async () => {
    const service = createWorkspaceService(true)

    await expect(
      service.createWorkspace({
        name: "Test Workspace",
        workosUserId,
        email,
        userName,
      })
    ).rejects.toMatchObject({
      name: "HttpError",
      message: "Workspace invite validation is not configured",
      status: 500,
      code: "WORKSPACE_INVITE_VALIDATION_NOT_CONFIGURED",
    })

    expect(mockWithTransaction).not.toHaveBeenCalled()
  })

  test("normalizes email before invite validation", async () => {
    const workosOrgService: MockWorkosOrgService = {
      hasAcceptedWorkspaceCreationInvitation: mock<(email: string) => Promise<boolean>>(() => Promise.resolve(false)),
    }
    const service = createWorkspaceService(true, workosOrgService)

    await expect(
      service.createWorkspace({
        name: "Test Workspace",
        workosUserId,
        email: " User@Example.com ",
        userName,
      })
    ).rejects.toMatchObject({
      name: "HttpError",
      message: "Workspace creation requires a dedicated workspace invite.",
      status: 403,
      code: "WORKSPACE_CREATION_INVITE_REQUIRED",
    })

    expect(workosOrgService.hasAcceptedWorkspaceCreationInvitation).toHaveBeenCalledWith("user@example.com")
    expect(mockWithTransaction).not.toHaveBeenCalled()
  })

  test("rejects workspace creation when user lacks accepted invitation", async () => {
    const workosOrgService: MockWorkosOrgService = {
      hasAcceptedWorkspaceCreationInvitation: mock<(email: string) => Promise<boolean>>(() => Promise.resolve(false)),
    }
    const service = createWorkspaceService(true, workosOrgService)

    await expect(
      service.createWorkspace({
        name: "Test Workspace",
        workosUserId,
        email,
        userName,
      })
    ).rejects.toMatchObject({
      name: "HttpError",
      message: "Workspace creation requires a dedicated workspace invite.",
      status: 403,
      code: "WORKSPACE_CREATION_INVITE_REQUIRED",
    })

    expect(workosOrgService.hasAcceptedWorkspaceCreationInvitation).toHaveBeenCalledWith("user@example.com")
    expect(mockWithTransaction).not.toHaveBeenCalled()
  })

  test("allows workspace creation when user has an accepted invitation", async () => {
    const workosOrgService: MockWorkosOrgService = {
      hasAcceptedWorkspaceCreationInvitation: mock<(email: string) => Promise<boolean>>(() => Promise.resolve(true)),
    }
    const service = createWorkspaceService(true, workosOrgService)

    const workspace = await service.createWorkspace({
      name: "Test Workspace",
      workosUserId,
      email,
      userName,
    })

    expect(workspace).toEqual(mockWorkspace)
    expect(workosOrgService.hasAcceptedWorkspaceCreationInvitation).toHaveBeenCalledWith("user@example.com")
    expect(mockWithTransaction).toHaveBeenCalledTimes(1)
  })
})

describe("WorkspaceService.ensureUserProvisioned", () => {
  const params = {
    workspaceId: "ws_1",
    workosUserId: "workos_user_1",
    email: "user@example.com",
    name: "User",
    role: "member" as const,
  }
  const existingUser = { id: "usr_existing", workspaceId: "ws_1" }
  const createdUser = { id: "usr_created", workspaceId: "ws_1" }

  const mockFindUser = spyOn(UserRepository, "findByWorkosUserIdInWorkspace")
  const mockWithTransaction = spyOn(db, "withTransaction")

  beforeEach(() => {
    mockFindUser.mockReset()
    mockWithTransaction.mockReset()
  })

  test("returns the existing row without opening a transaction", async () => {
    mockFindUser.mockResolvedValueOnce(existingUser as never)
    const service = createWorkspaceService(false)

    const user = await service.ensureUserProvisioned(params)

    expect(user).toEqual(existingUser as never)
    expect(mockWithTransaction).not.toHaveBeenCalled()
  })

  test("provisions a new row when none exists", async () => {
    mockFindUser.mockResolvedValueOnce(null)
    mockWithTransaction.mockResolvedValueOnce(createdUser as never)
    const service = createWorkspaceService(false)

    const user = await service.ensureUserProvisioned(params)

    expect(user).toEqual(createdUser as never)
    expect(mockWithTransaction).toHaveBeenCalledTimes(1)
  })

  test("re-reads and returns the winner when a concurrent request wins the unique constraint", async () => {
    mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce(createdUser as never)
    mockWithTransaction.mockRejectedValueOnce({
      code: "23505",
      constraint: "users_workspace_workos_user_key",
    })
    const service = createWorkspaceService(false)

    const user = await service.ensureUserProvisioned(params)

    expect(user).toEqual(createdUser as never)
    expect(mockFindUser).toHaveBeenCalledTimes(2)
  })

  test("propagates non-unique-violation transaction errors", async () => {
    mockFindUser.mockResolvedValueOnce(null)
    mockWithTransaction.mockRejectedValueOnce(new Error("connection reset"))
    const service = createWorkspaceService(false)

    await expect(service.ensureUserProvisioned(params)).rejects.toThrow("connection reset")
  })

  test("throws an explicit error when the raced row cannot be found after a unique collision", async () => {
    const cause = { code: "23505", constraint: "users_workspace_workos_user_key" }
    mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    mockWithTransaction.mockRejectedValueOnce(cause)
    const service = createWorkspaceService(false)

    const err = await service.ensureUserProvisioned(params).catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain("users row vanished after unique-constraint collision")
    expect(err.cause).toBe(cause)
  })
})

describe("WorkspaceService.removeUser read-state cleanup", () => {
  const mockWithTransaction = spyOn(db, "withTransaction")

  beforeEach(() => {
    mockWithTransaction
      .mockReset()
      .mockImplementation(((_pool: unknown, fn: (client: PoolClient) => Promise<unknown>) =>
        fn({} as PoolClient)) as never)
    spyOn(UserApiKeyRepository, "revokeAllByUser").mockResolvedValue(undefined as never)
    spyOn(UserRepository, "remove").mockResolvedValue(undefined as never)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
  })

  afterEach(() => mock.restore())

  test("deletes the user's read state in the same transaction as account removal", async () => {
    const deleteForUser = spyOn(ReadStateRepository, "deleteForUser").mockResolvedValue(undefined as never)
    const service = createWorkspaceService(false)

    await service.removeUser("ws_1", "usr_1")

    expect(UserRepository.remove).toHaveBeenCalledWith({}, "ws_1", "usr_1")
    expect(deleteForUser).toHaveBeenCalledWith({}, "ws_1", "usr_1")
  })
})
