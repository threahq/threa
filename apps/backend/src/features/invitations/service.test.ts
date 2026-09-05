import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { PoolClient } from "pg"
import * as db from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { UserRepository } from "../workspaces"
import { InvitationRepository, type Invitation } from "./repository"
import { InvitationService } from "./service"

const future = new Date(Date.now() + 60_000)
const root: Invitation = {
  id: "inv_root",
  workspaceId: "ws_1",
  kind: "link",
  email: null,
  role: "member",
  invitedBy: "usr_admin",
  workosInvitationId: null,
  tokenHash: "hash",
  note: null,
  status: "pending",
  createdAt: new Date(),
  expiresAt: future,
  acceptedAt: null,
  revokedAt: null,
  parentLinkId: null,
  maxUses: 2,
  useCount: 0,
  acceptedWorkosUserId: null,
  acceptanceConsumesCapacity: null,
  revision: 1,
}
const child: Invitation = {
  ...root,
  id: "inv_child",
  email: "new@example.com",
  tokenHash: null,
  parentLinkId: root.id,
  maxUses: null,
}

const client = { query: mock(() => Promise.resolve({ rows: [], rowCount: 0 })) } as unknown as PoolClient
spyOn(db, "withTransaction").mockImplementation((_pool, callback) => callback(client))

const insertOutbox = spyOn(OutboxRepository, "insert")
const findUserById = spyOn(UserRepository, "findById")
const findEmails = spyOn(UserRepository, "findEmails")

beforeEach(() => {
  client.query = mock(() => Promise.resolve({ rows: [], rowCount: 0 })) as never
  insertOutbox.mockReset().mockResolvedValue({ id: 1n, eventType: "test", payload: {}, createdAt: new Date() } as never)
  findUserById.mockReset().mockResolvedValue(null)
  findEmails.mockReset().mockResolvedValue(new Set())
})

describe("InvitationService.createLink", () => {
  const insertLink = spyOn(InvitationRepository, "insertLink")

  beforeEach(() => {
    insertLink.mockReset().mockImplementation(async (_db, params) => ({
      ...root,
      id: params.id,
      workspaceId: params.workspaceId,
      invitedBy: params.invitedBy,
      role: params.role,
      tokenHash: params.tokenHash,
      note: params.note,
      expiresAt: params.expiresAt,
      maxUses: params.maxUses,
    }))
  })

  test("should default omitted limits to one use and seven days", async () => {
    const service = new InvitationService({} as never, {} as never)
    const before = Date.now()
    const result = await service.createLink({
      workspaceId: "ws_1",
      invitedBy: "usr_admin",
      role: "member",
      note: null,
    })

    expect(result.token).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(insertLink.mock.calls[0]?.[1]).toMatchObject({ maxUses: 1 })
    expect(insertLink.mock.calls[0]?.[1].expiresAt?.getTime()).toBeGreaterThanOrEqual(before + 7 * 24 * 60 * 60 * 1000)
  })

  test("should reject privileged link creation before writing", async () => {
    const service = new InvitationService({} as never, {} as never)

    await expect(
      service.createLink({
        workspaceId: "ws_1",
        invitedBy: "usr_admin",
        role: "admin",
        note: "partners",
        maxUses: 1,
        expiresAt: null,
      })
    ).rejects.toMatchObject({ code: "INVITATION_ROLE_NOT_ALLOWED" })
    expect(insertLink).not.toHaveBeenCalled()
    expect(insertOutbox).not.toHaveBeenCalled()
  })
})

describe("InvitationService.claimLinkByToken", () => {
  const findRootForUpdate = spyOn(InvitationRepository, "findRootByTokenHashForUpdate")
  const findChild = spyOn(InvitationRepository, "findLinkChild")
  const insertChild = spyOn(InvitationRepository, "insertOrFindLinkChild")
  const claimLegacyAdmin = spyOn(InvitationRepository, "claimLegacyAdminLink")

  beforeEach(() => {
    findRootForUpdate.mockReset().mockResolvedValue(root)
    findChild.mockReset().mockResolvedValue(null)
    insertChild.mockReset().mockResolvedValue(child)
    claimLegacyAdmin.mockReset().mockResolvedValue({ ...root, role: "admin", email: "new@example.com", maxUses: 1 })
  })

  test("should create an email-bound child and publish its id with parent state", async () => {
    const service = new InvitationService({} as never, {} as never)
    const result = await service.claimLinkByToken("token", " New@Example.COM ")

    expect(result).toEqual({ invitationId: "inv_child" })
    expect(insertChild.mock.calls[0]?.[1]).toMatchObject({ parent: root, email: "new@example.com" })
    const event = insertOutbox.mock.calls.find((call) => call[1] === "invitation:link-claimed")
    expect(event?.[2]).toMatchObject({
      invitationId: "inv_child",
      parentInvitationId: "inv_root",
      email: "new@example.com",
      maxUses: 2,
      useCount: 0,
      revision: 1,
    })
  })

  test("should publish a claim before returning the existing-member hint", async () => {
    findEmails.mockResolvedValue(new Set(["new@example.com"]))
    const service = new InvitationService({} as never, {} as never)

    await expect(service.claimLinkByToken("token", "new@example.com")).resolves.toEqual({
      alreadyMember: { workspaceId: "ws_1" },
    })
    expect(insertChild).toHaveBeenCalledTimes(1)
    expect(insertOutbox.mock.calls.find((call) => call[1] === "invitation:link-claimed")?.[2]).toMatchObject({
      invitationId: "inv_child",
      email: "new@example.com",
    })
  })

  test("should return an existing child when a claim notification retries after exhaustion", async () => {
    findRootForUpdate.mockResolvedValue({ ...root, useCount: 2 })
    findChild.mockResolvedValue(child)
    const service = new InvitationService({} as never, {} as never)

    await expect(service.claimLinkByToken("token", "new@example.com")).resolves.toEqual({
      invitationId: "inv_child",
    })
    expect(insertChild).not.toHaveBeenCalled()
  })

  test("should bind a legacy admin root and never mint a child", async () => {
    findRootForUpdate.mockResolvedValue({ ...root, role: "admin", maxUses: 1 })
    const service = new InvitationService({} as never, {} as never)

    await expect(service.claimLinkByToken("token", "new@example.com")).resolves.toEqual({
      invitationId: "inv_root",
    })
    expect(claimLegacyAdmin).toHaveBeenCalledWith(client, "inv_root", "new@example.com")
    expect(insertChild).not.toHaveBeenCalled()
  })

  test("should not resend a bound legacy admin invitation after its link expires", async () => {
    findRootForUpdate.mockResolvedValue({
      ...root,
      role: "admin",
      email: "first@example.com",
      maxUses: 1,
      expiresAt: new Date(Date.now() - 1000),
    })
    const service = new InvitationService({} as never, {} as never)
    await expect(service.claimLinkByToken("token", "first@example.com")).rejects.toMatchObject({
      code: "INVITATION_EXPIRED",
    })
    expect(insertOutbox).not.toHaveBeenCalled()
  })

  test("should reject another email after a legacy admin root is bound", async () => {
    findRootForUpdate.mockResolvedValue({
      ...root,
      role: "admin",
      email: "first@example.com",
      maxUses: 1,
    })
    const service = new InvitationService({} as never, {} as never)

    await expect(service.claimLinkByToken("token", "other@example.com")).rejects.toMatchObject({
      code: "INVITATION_EXHAUSTED",
    })
    expect(claimLegacyAdmin).not.toHaveBeenCalled()
    expect(insertChild).not.toHaveBeenCalled()
    expect(insertOutbox).not.toHaveBeenCalled()
  })

  test("should reject a new claim when successful joins exhausted the link", async () => {
    findRootForUpdate.mockResolvedValue({ ...root, useCount: 2 })
    const service = new InvitationService({} as never, {} as never)

    await expect(service.claimLinkByToken("token", "new@example.com")).rejects.toMatchObject({
      code: "INVITATION_EXHAUSTED",
    })
    expect(insertChild).not.toHaveBeenCalled()
  })
})

describe("InvitationService.updateLink", () => {
  const updateLink = spyOn(InvitationRepository, "updateLink")

  beforeEach(() => updateLink.mockReset())

  test("should publish the current revision without changing the token", async () => {
    const updated = { ...root, expiresAt: null, maxUses: null, revision: 2 }
    updateLink.mockResolvedValue(updated)
    const service = new InvitationService({} as never, {} as never)

    const result = await service.updateLink({
      workspaceId: "ws_1",
      invitationId: "inv_root",
      expiresAt: null,
      maxUses: null,
    })

    expect(result).toEqual(updated)
    expect(insertOutbox.mock.calls[0]?.[2]).toMatchObject({
      invitationId: "inv_root",
      tokenHash: "hash",
      expiresAt: null,
      maxUses: null,
      revision: 2,
    })
  })
})
