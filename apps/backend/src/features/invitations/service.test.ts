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
  maxUses: 1,
  useCount: 0,
  acceptedWorkosUserId: null,
  acceptanceConsumesCapacity: null,
  revision: 1,
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

  test("should keep link creation at one use and seven days", async () => {
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
    expect(insertOutbox.mock.calls.find((call) => call[1] === "invitation:link-created")?.[2]).toMatchObject({
      parentInvitationId: result.invitation.id,
      maxUses: 1,
      useCount: 0,
      revision: 1,
    })
  })
})

describe("InvitationService.claimLinkByToken", () => {
  const findRootForUpdate = spyOn(InvitationRepository, "findRootByTokenHashForUpdate")
  const hasChildren = spyOn(InvitationRepository, "hasLinkChildren")
  const claimLegacy = spyOn(InvitationRepository, "claimLegacyLinkById")

  beforeEach(() => {
    findRootForUpdate.mockReset().mockResolvedValue(root)
    hasChildren.mockReset().mockResolvedValue(false)
    claimLegacy.mockReset().mockResolvedValue({ ...root, email: "new@example.com" })
  })

  test("should bind a legacy root and publish the old claim payload", async () => {
    const service = new InvitationService({} as never, {} as never)

    await expect(service.claimLinkByToken("token", " New@Example.COM ")).resolves.toEqual({})
    expect(hasChildren.mock.calls[0]?.slice(1)).toEqual(["ws_1", "inv_root"])
    expect(claimLegacy.mock.calls[0]?.slice(1)).toEqual(["ws_1", "inv_root", "new@example.com"])
    expect(insertOutbox.mock.calls.find((call) => call[1] === "invitation:link-claimed")?.[2]).toEqual({
      workspaceId: "ws_1",
      invitationId: "inv_root",
      email: "new@example.com",
      role: "member",
      inviterWorkosUserId: undefined,
    })
  })

  test("should refuse roots with future limits before mutation", async () => {
    findRootForUpdate.mockResolvedValue({ ...root, maxUses: 2 })
    const service = new InvitationService({} as never, {} as never)

    await expect(service.claimLinkByToken("token", "new@example.com")).rejects.toMatchObject({
      code: "INVITATION_ROLLOUT_UNAVAILABLE",
    })
    expect(claimLegacy).not.toHaveBeenCalled()
  })

  test("should refuse no-expiry roots before mutation", async () => {
    findRootForUpdate.mockResolvedValue({ ...root, expiresAt: null })
    const service = new InvitationService({} as never, {} as never)

    await expect(service.claimLinkByToken("token", "new@example.com")).rejects.toMatchObject({
      code: "INVITATION_ROLLOUT_UNAVAILABLE",
    })
    expect(claimLegacy).not.toHaveBeenCalled()
  })

  test("should refuse roots with any child before mutation", async () => {
    hasChildren.mockResolvedValue(true)
    const service = new InvitationService({} as never, {} as never)

    await expect(service.claimLinkByToken("token", "new@example.com")).rejects.toMatchObject({
      code: "INVITATION_ROLLOUT_UNAVAILABLE",
    })
    expect(claimLegacy).not.toHaveBeenCalled()
  })
})
