import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { ContextRefKinds, Visibilities } from "@threa/types"
import { ConversationResolver } from "./conversation-resolver"
import { AttachmentRepository } from "../../../attachments"
import { MessageRepository } from "../../../messaging"
import { LinkPreviewRepository } from "../../../link-previews"
import { ConversationRepository } from "../../../conversations"
import { StreamRepository, StreamMemberRepository } from "../../../streams"
import { UserRepository } from "../../../workspaces"
import { PersonaRepository } from "../../persona-repository"

beforeEach(() => {
  spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(new Map())
  spyOn(LinkPreviewRepository, "findByMessageIds").mockResolvedValue(new Map())
  spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_author", name: "Author" }] as any)
  spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
})

afterEach(() => mock.restore())

function makeStream(overrides: Record<string, any> = {}): any {
  return {
    id: "stream_root",
    workspaceId: "ws_1",
    type: "channel",
    visibility: Visibilities.PRIVATE,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "usr_1",
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
    displayName: null,
    slug: null,
    description: null,
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    displayNameGeneratedAt: null,
    ...overrides,
  }
}

function makeConversation(overrides: Record<string, any> = {}): any {
  return {
    id: "conv_1",
    streamId: "stream_root",
    workspaceId: "ws_1",
    messageIds: ["msg_a", "msg_b"],
    participantIds: ["usr_author"],
    secondaryMessageIds: [],
    topicSummary: null,
    completenessScore: 0,
    confidence: 0,
    status: "active",
    parentConversationId: null,
    lastActivityAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeMessage(overrides: Record<string, any> = {}): any {
  return {
    id: "msg_a",
    streamId: "stream_root",
    sequence: 1n,
    authorId: "usr_author",
    authorType: "user",
    contentMarkdown: "hello",
    contentJson: { type: "doc", content: [] },
    replyCount: 0,
    clientMessageId: null,
    sentVia: null,
    reactions: {},
    metadata: {},
    editedAt: null,
    deletedAt: null,
    createdAt: new Date("2026-04-22T09:00:00Z"),
    ...overrides,
  }
}

describe("ConversationResolver.assertAccess", () => {
  it("rejects when the conversation is missing or cross-workspace", async () => {
    spyOn(ConversationRepository, "findByIds").mockResolvedValue([])

    await expect(
      ConversationResolver.assertAccess(
        {} as any,
        { kind: ContextRefKinds.CONVERSATION, conversationId: "conv_gone", streamId: "stream_root" },
        "usr_x",
        "ws_1"
      )
    ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_FORBIDDEN" })
  })

  it("rejects when the caller cannot read the conversation's root stream", async () => {
    spyOn(ConversationRepository, "findByIds").mockResolvedValue([makeConversation()])
    spyOn(StreamRepository, "findById").mockResolvedValue(makeStream())
    spyOn(StreamMemberRepository, "isMember").mockResolvedValue(false)

    await expect(
      ConversationResolver.assertAccess(
        {} as any,
        { kind: ContextRefKinds.CONVERSATION, conversationId: "conv_1", streamId: "stream_root" },
        "usr_x",
        "ws_1"
      )
    ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_FORBIDDEN" })
  })

  it("allows access when the root stream is readable, using the conversation's own root not the client streamId", async () => {
    spyOn(ConversationRepository, "findByIds").mockResolvedValue([makeConversation({ streamId: "stream_real_root" })])
    const findById = spyOn(StreamRepository, "findById").mockResolvedValue(
      makeStream({ id: "stream_real_root", visibility: Visibilities.PUBLIC })
    )
    const isMember = spyOn(StreamMemberRepository, "isMember").mockResolvedValue(false)

    await ConversationResolver.assertAccess(
      {} as any,
      // Client-supplied streamId is a stale/wrong value — must be ignored.
      { kind: ContextRefKinds.CONVERSATION, conversationId: "conv_1", streamId: "stream_wrong" },
      "usr_x",
      "ws_1"
    )

    expect(findById).toHaveBeenCalledWith(expect.anything(), "stream_real_root")
    expect(isMember).not.toHaveBeenCalled()
  })
})

describe("ConversationResolver.fetch", () => {
  it("throws CONTEXT_SOURCE_NOT_FOUND when the conversation is gone", async () => {
    spyOn(ConversationRepository, "findById").mockResolvedValue(null)

    await expect(
      ConversationResolver.fetch({} as any, {
        kind: ContextRefKinds.CONVERSATION,
        conversationId: "conv_gone",
        streamId: "stream_root",
      })
    ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_NOT_FOUND" })
  })

  it("resolves member messages flattened-chronological across streams and drops soft-deleted rows", async () => {
    spyOn(ConversationRepository, "findById").mockResolvedValue(
      makeConversation({ messageIds: ["msg_a", "msg_b", "msg_deleted"] })
    )
    // Returned out of order, spanning root + a thread, with one soft-deleted.
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([
        ["msg_b", makeMessage({ id: "msg_b", streamId: "stream_thread", createdAt: new Date("2026-04-22T10:00:00Z") })],
        ["msg_a", makeMessage({ id: "msg_a", streamId: "stream_root", createdAt: new Date("2026-04-22T09:00:00Z") })],
        ["msg_deleted", makeMessage({ id: "msg_deleted", deletedAt: new Date() })],
      ])
    )

    const result = await ConversationResolver.fetch({} as any, {
      kind: ContextRefKinds.CONVERSATION,
      conversationId: "conv_1",
      streamId: "stream_root",
    })

    expect(result.items.map((i) => i.messageId)).toEqual(["msg_a", "msg_b"])
    expect(result.focalMessageId).toBeNull()
    expect(result.tailMessageId).toBe("msg_b")
  })

  it("marks the focal message when originMessageId is a member", async () => {
    spyOn(ConversationRepository, "findById").mockResolvedValue(makeConversation())
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([
        ["msg_a", makeMessage({ id: "msg_a", createdAt: new Date("2026-04-22T09:00:00Z") })],
        ["msg_b", makeMessage({ id: "msg_b", createdAt: new Date("2026-04-22T10:00:00Z") })],
      ])
    )

    const result = await ConversationResolver.fetch({} as any, {
      kind: ContextRefKinds.CONVERSATION,
      conversationId: "conv_1",
      streamId: "stream_root",
      originMessageId: "msg_b",
    })

    expect(result.focalMessageId).toBe("msg_b")
  })

  it("keys the summary cache on the conversation id", () => {
    expect(
      ConversationResolver.canonicalKey({
        kind: ContextRefKinds.CONVERSATION,
        conversationId: "conv_1",
        streamId: "stream_root",
      })
    ).toBe("conversation:conv_1")
  })
})
