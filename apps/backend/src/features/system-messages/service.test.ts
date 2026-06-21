import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { AuthorTypes, CompanionModes, StreamTypes, Visibilities } from "@threa/types"
import { StreamRepository } from "../streams"
import { InvitationRepository } from "../invitations"
import { UserRepository } from "../workspaces"
import { SystemMessageService } from "./service"
import type { Stream } from "../streams"

const WORKSPACE_ID = `ws_${crypto.randomUUID().replace(/-/g, "").slice(0, 26)}`
const USER_A = `usr_${crypto.randomUUID().replace(/-/g, "").slice(0, 26)}`
const USER_B = `usr_${crypto.randomUUID().replace(/-/g, "").slice(0, 26)}`

function fakeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: `stream_${crypto.randomUUID().replace(/-/g, "").slice(0, 26)}`,
    workspaceId: WORKSPACE_ID,
    type: StreamTypes.SYSTEM,
    displayName: "Threa",
    slug: null,
    description: null,
    descriptionJson: null,
    visibility: Visibilities.PRIVATE,
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    companionMode: CompanionModes.OFF,
    companionPersonaId: null,
    createdBy: USER_A,
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
    displayNameGeneratedAt: null,
    ...overrides,
  }
}

function fakeUser(overrides: Partial<Awaited<ReturnType<typeof UserRepository.findById>>> = {}) {
  return {
    id: USER_A,
    workspaceId: WORKSPACE_ID,
    workosUserId: "workos_user_1",
    email: "alice@test.com",
    role: "owner" as const,
    slug: "alice",
    name: "Alice",
    description: null,
    avatarUrl: null,
    timezone: null,
    locale: null,
    setupCompleted: true,
    joinedAt: new Date(),
    ...(overrides as object),
  }
}

function createService() {
  const createMessage = mock(async () => ({}) as any)

  return {
    service: new SystemMessageService({ pool: {} as any, createMessage }),
    createMessage,
  }
}

describe("SystemMessageService", () => {
  afterEach(() => {
    mock.restore()
  })

  describe("notifyUser", () => {
    it("should send message to existing system stream", async () => {
      const systemStream = fakeStream({ createdBy: USER_A })
      spyOn(StreamRepository, "findByTypeAndOwner").mockResolvedValue(systemStream)

      const { service, createMessage } = createService()
      await service.notifyUser(WORKSPACE_ID, USER_A, "Hello from the system")

      expect(createMessage).toHaveBeenCalledWith({
        workspaceId: WORKSPACE_ID,
        streamId: systemStream.id,
        authorId: AuthorTypes.SYSTEM,
        authorType: AuthorTypes.SYSTEM,
        content: "Hello from the system",
      })
    })

    it("should log error and skip when system stream is missing", async () => {
      spyOn(StreamRepository, "findByTypeAndOwner").mockResolvedValue(null)

      const { service, createMessage } = createService()
      await service.notifyUser(WORKSPACE_ID, USER_A, "Test notification")

      expect(createMessage).not.toHaveBeenCalled()
    })
  })

  describe("sendBudgetAlert", () => {
    it("should format budget data as markdown and delegate to notifyOwners", async () => {
      const streamA = fakeStream({ createdBy: USER_A })

      spyOn(UserRepository, "listByWorkspace").mockResolvedValue([fakeUser({ id: USER_A })] as never)
      spyOn(StreamRepository, "list").mockResolvedValue([streamA])

      const { service, createMessage } = createService()
      await service.sendBudgetAlert({
        workspaceId: WORKSPACE_ID,
        alertType: "threshold",
        thresholdPercent: 80,
        currentUsageUsd: 40.5,
        budgetUsd: 50,
        percentUsed: 81,
      })

      expect(createMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "**Budget alert** — AI usage has reached 81% of your $50/month budget ($40.50 spent).",
        })
      )
    })
  })

  describe("notifyOwners", () => {
    it("should send message to each owner's system stream", async () => {
      const streamA = fakeStream({ createdBy: USER_A })
      const streamB = fakeStream({ createdBy: USER_B })

      spyOn(UserRepository, "listByWorkspace").mockResolvedValue([
        fakeUser({ id: USER_A, role: "owner", name: "Alice", email: "alice@test.com" }),
        fakeUser({ id: USER_B, role: "owner", name: "Bob", email: "bob@test.com" }),
      ] as never)
      spyOn(StreamRepository, "list").mockResolvedValue([streamA, streamB])

      const { service, createMessage } = createService()
      await service.notifyOwners(WORKSPACE_ID, "Owner alert")

      expect(StreamRepository.list).toHaveBeenCalledWith(expect.anything(), WORKSPACE_ID, {
        types: [StreamTypes.SYSTEM],
      })
      expect(createMessage).toHaveBeenCalledTimes(2)
      expect(createMessage).toHaveBeenCalledWith(
        expect.objectContaining({ streamId: streamA.id, content: "Owner alert" })
      )
      expect(createMessage).toHaveBeenCalledWith(
        expect.objectContaining({ streamId: streamB.id, content: "Owner alert" })
      )
    })

    it("should only notify owners, not regular users", async () => {
      const streamA = fakeStream({ createdBy: USER_A })

      spyOn(UserRepository, "listByWorkspace").mockResolvedValue([
        fakeUser({ id: USER_A, role: "owner", name: "Alice" }),
        fakeUser({ id: USER_B, role: "member", name: "Bob" }),
      ] as never)
      spyOn(StreamRepository, "list").mockResolvedValue([streamA])

      const { service, createMessage } = createService()
      await service.notifyOwners(WORKSPACE_ID, "Alert")

      expect(createMessage).toHaveBeenCalledTimes(1)
      expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({ streamId: streamA.id }))
    })

    it("should skip owners with missing streams and continue notifying others", async () => {
      const streamB = fakeStream({ createdBy: USER_B })

      spyOn(UserRepository, "listByWorkspace").mockResolvedValue([
        fakeUser({ id: USER_A, role: "owner", name: "Alice" }),
        fakeUser({ id: USER_B, role: "owner", name: "Bob" }),
      ] as never)

      // Only owner B has a system stream
      spyOn(StreamRepository, "list").mockResolvedValue([streamB])

      const { service, createMessage } = createService()
      await service.notifyOwners(WORKSPACE_ID, "Alert")

      expect(createMessage).toHaveBeenCalledTimes(1)
      expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({ streamId: streamB.id }))
    })

    it("should continue notifying remaining owners when one fails", async () => {
      const streamA = fakeStream({ createdBy: USER_A })
      const streamB = fakeStream({ createdBy: USER_B })

      spyOn(UserRepository, "listByWorkspace").mockResolvedValue([
        fakeUser({ id: USER_A, role: "owner", name: "Alice" }),
        fakeUser({ id: USER_B, role: "owner", name: "Bob" }),
      ] as never)

      spyOn(StreamRepository, "list").mockResolvedValue([streamA, streamB])

      const { service, createMessage } = createService()
      createMessage.mockRejectedValueOnce(new Error("message creation failed")).mockResolvedValueOnce({} as any)

      await service.notifyOwners(WORKSPACE_ID, "Alert")

      expect(createMessage).toHaveBeenCalledTimes(2)
      expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({ streamId: streamB.id }))
    })
  })

  describe("sendInvitationAccepted", () => {
    const INVITER_ID = USER_A
    const INVITATION_ID = `inv_${crypto.randomUUID().replace(/-/g, "").slice(0, 26)}`

    it("should notify the inviter with the accepting user's name", async () => {
      const inviterStream = fakeStream({ createdBy: INVITER_ID })

      spyOn(InvitationRepository, "findById").mockResolvedValue({
        id: INVITATION_ID,
        workspaceId: WORKSPACE_ID,
        email: "newuser@test.com",
        role: "member",
        invitedBy: INVITER_ID,
        workosInvitationId: null,
        status: "accepted",
        createdAt: new Date(),
        expiresAt: new Date(),
        acceptedAt: new Date(),
        revokedAt: null,
      } as never)

      spyOn(StreamRepository, "findByTypeAndOwner").mockResolvedValue(inviterStream)

      const { service, createMessage } = createService()
      await service.sendInvitationAccepted({
        workspaceId: WORKSPACE_ID,
        invitationId: INVITATION_ID,
        email: "newuser@test.com",
        workosUserId: "workos_user_2",
        userName: "New User",
      })

      expect(createMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          streamId: inviterStream.id,
          content: "**New User** accepted your invitation and joined the workspace.",
        })
      )
    })

    it("should fall back to email when payload has no user name", async () => {
      const inviterStream = fakeStream({ createdBy: INVITER_ID })

      spyOn(InvitationRepository, "findById").mockResolvedValue({
        id: INVITATION_ID,
        workspaceId: WORKSPACE_ID,
        email: "anonymous@test.com",
        role: "member",
        invitedBy: INVITER_ID,
        workosInvitationId: null,
        status: "accepted",
        createdAt: new Date(),
        expiresAt: new Date(),
        acceptedAt: new Date(),
        revokedAt: null,
      } as never)

      spyOn(StreamRepository, "findByTypeAndOwner").mockResolvedValue(inviterStream)

      const { service, createMessage } = createService()
      await service.sendInvitationAccepted({
        workspaceId: WORKSPACE_ID,
        invitationId: INVITATION_ID,
        email: "anonymous@test.com",
        workosUserId: "workos_user_3",
        userName: "",
      })

      expect(createMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "**anonymous@test.com** accepted your invitation and joined the workspace.",
        })
      )
    })

    it("should skip notification when invitation is not found", async () => {
      spyOn(InvitationRepository, "findById").mockResolvedValue(null)

      const { service, createMessage } = createService()
      await service.sendInvitationAccepted({
        workspaceId: WORKSPACE_ID,
        invitationId: "inv_nonexistent",
        email: "test@test.com",
        workosUserId: "workos_user_9",
        userName: "Test",
      })

      expect(createMessage).not.toHaveBeenCalled()
    })
  })
})
