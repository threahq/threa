import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { WORKSPACE_ROLE_SLUGS } from "@threahq/types"
import * as db from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { UserRepository, type User } from "../workspaces"
import { WorkspaceAuthzService } from "./service"
import { WorkspaceUserPermissionsRepository, type WorkspaceUserPermissions } from "./repository"

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: "usr_1",
    workspaceId: "ws_1",
    workosUserId: "workos_user_1",
    email: "user@example.com",
    role: WORKSPACE_ROLE_SLUGS.MEMBER,
    slug: "user",
    name: "User",
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
    joinedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  }
}

function buildMirror(overrides: Partial<WorkspaceUserPermissions> = {}): WorkspaceUserPermissions {
  return {
    workspaceId: "ws_1",
    workosUserId: "workos_user_1",
    roleSlugs: [WORKSPACE_ROLE_SLUGS.MEMBER],
    status: "active",
    lastEventAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  }
}

describe("WorkspaceAuthzService.applyMembershipChange", () => {
  // Run the transaction callback inline against a stub client so the upsert,
  // user read, and outbox insert exercise the real control flow without a DB.
  const withTransactionSpy = spyOn(db, "withTransaction").mockImplementation(async (_db, cb) => cb({} as never))

  afterEach(() => {
    withTransactionSpy.mockClear()
  })

  const input = {
    workspaceId: "ws_1",
    workosUserId: "workos_user_1",
    roleSlugs: [WORKSPACE_ROLE_SLUGS.MEMBER],
    status: "active" as const,
    lastEventAt: new Date("2026-01-02T00:00:00.000Z"),
  }

  test("emits workspace_user:updated carrying the freshly derived role on change", async () => {
    // The mirror upsert applied (returns a row); the user read reflects the new
    // role the read path derives from that mirror.
    const upsertSpy = spyOn(WorkspaceUserPermissionsRepository, "upsert").mockResolvedValue(buildMirror())
    const userSpy = spyOn(UserRepository, "findByWorkosUserIdInWorkspace").mockResolvedValue(
      buildUser({ role: WORKSPACE_ROLE_SLUGS.MEMBER })
    )
    const insertSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)

    const service = new WorkspaceAuthzService({ pool: {} as never })
    await service.applyMembershipChange(input)

    expect(upsertSpy).toHaveBeenCalled()
    expect(userSpy).toHaveBeenCalledWith({} as never, "ws_1", "workos_user_1")
    expect(insertSpy).toHaveBeenCalled()
    const [, eventType, payload] = insertSpy.mock.calls[0]!
    expect(eventType).toBe("workspace_user:updated")
    expect(payload).toMatchObject({
      workspaceId: "ws_1",
      user: expect.objectContaining({ id: "usr_1", role: WORKSPACE_ROLE_SLUGS.MEMBER }),
    })

    upsertSpy.mockRestore()
    userSpy.mockRestore()
    insertSpy.mockRestore()
  })

  test("emits nothing when the upsert is ignored as stale", async () => {
    const upsertSpy = spyOn(WorkspaceUserPermissionsRepository, "upsert").mockResolvedValue(null)
    const userSpy = spyOn(UserRepository, "findByWorkosUserIdInWorkspace")
    const insertSpy = spyOn(OutboxRepository, "insert")

    const service = new WorkspaceAuthzService({ pool: {} as never })
    await service.applyMembershipChange(input)

    expect(upsertSpy).toHaveBeenCalledTimes(1)
    expect(userSpy).not.toHaveBeenCalled()
    expect(insertSpy).not.toHaveBeenCalled()

    upsertSpy.mockRestore()
    userSpy.mockRestore()
    insertSpy.mockRestore()
  })

  test("emits nothing when the upsert applied a non-active membership", async () => {
    // An inactive/pending mirror derives no role from the active-only read
    // join, so loading the user would broadcast the stale users.role fallback.
    const upsertSpy = spyOn(WorkspaceUserPermissionsRepository, "upsert").mockResolvedValue(
      buildMirror({ status: "inactive" })
    )
    const userSpy = spyOn(UserRepository, "findByWorkosUserIdInWorkspace")
    const insertSpy = spyOn(OutboxRepository, "insert")

    const service = new WorkspaceAuthzService({ pool: {} as never })
    await service.applyMembershipChange({ ...input, status: "inactive" })

    expect(userSpy).not.toHaveBeenCalled()
    expect(insertSpy).not.toHaveBeenCalled()

    upsertSpy.mockRestore()
    userSpy.mockRestore()
    insertSpy.mockRestore()
  })

  test("skips the broadcast when the user row has not landed yet", async () => {
    const upsertSpy = spyOn(WorkspaceUserPermissionsRepository, "upsert").mockResolvedValue(buildMirror())
    const userSpy = spyOn(UserRepository, "findByWorkosUserIdInWorkspace").mockResolvedValue(null)
    const insertSpy = spyOn(OutboxRepository, "insert")

    const service = new WorkspaceAuthzService({ pool: {} as never })
    await service.applyMembershipChange(input)

    expect(userSpy).toHaveBeenCalledTimes(1)
    expect(insertSpy).not.toHaveBeenCalled()

    upsertSpy.mockRestore()
    userSpy.mockRestore()
    insertSpy.mockRestore()
  })
})
