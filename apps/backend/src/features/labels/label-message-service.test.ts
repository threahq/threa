import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { LabelActorTypes, LabelableResourceTypes, type LabelAssignment } from "@threa/types"
import { LabelMessageService } from "./label-message-service"
import { LabelAssignmentRepository } from "./repository"
import { MessageRepository, type Message } from "../messaging"
import { AttachmentRepository } from "../attachments"
import { LinkPreviewRepository } from "../link-previews"
import * as streamsBarrel from "../streams"

const WORKSPACE_ID = "ws_1"
const USER_ID = "usr_1"
const USER_ACTOR = { type: LabelActorTypes.USER, id: USER_ID } as const
const LABEL_ID = "label_1"
const CREATED_AT = "2026-05-28T12:00:00.000Z"

function messageAssignment(resourceId: string): LabelAssignment {
  return {
    labelId: LABEL_ID,
    resourceType: LabelableResourceTypes.MESSAGE,
    resourceId,
    actorType: LabelActorTypes.USER,
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    assignedAt: CREATED_AT,
  }
}

function fakeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg_1",
    streamId: "stream_a",
    sequence: 1n,
    authorId: USER_ID,
    authorType: "user",
    contentJson: { type: "doc", content: [] } as unknown as Message["contentJson"],
    contentMarkdown: "hello",
    replyCount: 0,
    clientMessageId: null,
    sentVia: null,
    reactions: {},
    metadata: {},
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(CREATED_AT),
    ciphertext: null,
    envelope: null,
    e2eVersion: null,
    ...overrides,
  }
}

function setupService() {
  return new LabelMessageService({ pool: {} as any, botChannelService: {} as any })
}

describe("LabelMessageService.listLabeledMessages", () => {
  afterEach(() => mock.restore())

  it("returns the actor's labeled messages in stowed order, hydrated with stream + content", async () => {
    const service = setupService()
    spyOn(LabelAssignmentRepository, "listForLabelAndResourceType").mockResolvedValue([
      messageAssignment("msg_2"),
      messageAssignment("msg_1"),
    ])
    spyOn(MessageRepository, "findByIds").mockResolvedValue(
      new Map([
        ["msg_1", fakeMessage({ id: "msg_1", streamId: "stream_a", contentMarkdown: "first" })],
        ["msg_2", fakeMessage({ id: "msg_2", streamId: "stream_b", contentMarkdown: "second" })],
      ])
    )
    const access = spyOn(streamsBarrel, "listAccessibleStreamIds").mockResolvedValue(new Set(["stream_a", "stream_b"]))
    spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(new Map())
    spyOn(LinkPreviewRepository, "findByMessageIds").mockResolvedValue(new Map())

    const result = await service.listLabeledMessages(WORKSPACE_ID, USER_ACTOR, LABEL_ID)

    // Order follows the assignment list (newest stowed first), not message ids.
    expect(result.map((m) => m.id)).toEqual(["msg_2", "msg_1"])
    expect(result[0]).toEqual({
      id: "msg_2",
      streamId: "stream_b",
      authorId: USER_ID,
      authorType: "user",
      contentMarkdown: "second",
      reactions: {},
      attachments: [],
      linkPreviews: [],
      createdAt: CREATED_AT,
    })
    expect(access).toHaveBeenCalledWith(expect.anything(), WORKSPACE_ID, USER_ID, ["stream_b", "stream_a"])
  })

  it("drops a message deleted after it was labeled", async () => {
    const service = setupService()
    spyOn(LabelAssignmentRepository, "listForLabelAndResourceType").mockResolvedValue([
      messageAssignment("msg_1"),
      messageAssignment("msg_2"),
    ])
    spyOn(MessageRepository, "findByIds").mockResolvedValue(
      new Map([
        ["msg_1", fakeMessage({ id: "msg_1", deletedAt: new Date(CREATED_AT) })],
        ["msg_2", fakeMessage({ id: "msg_2" })],
      ])
    )
    spyOn(streamsBarrel, "listAccessibleStreamIds").mockResolvedValue(new Set(["stream_a"]))
    spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(new Map())
    spyOn(LinkPreviewRepository, "findByMessageIds").mockResolvedValue(new Map())

    const result = await service.listLabeledMessages(WORKSPACE_ID, USER_ACTOR, LABEL_ID)

    expect(result.map((m) => m.id)).toEqual(["msg_2"])
  })

  it("drops a labeled message whose stream the viewer can no longer reach", async () => {
    const service = setupService()
    spyOn(LabelAssignmentRepository, "listForLabelAndResourceType").mockResolvedValue([
      messageAssignment("msg_1"),
      messageAssignment("msg_2"),
    ])
    spyOn(MessageRepository, "findByIds").mockResolvedValue(
      new Map([
        ["msg_1", fakeMessage({ id: "msg_1", streamId: "stream_a" })],
        ["msg_2", fakeMessage({ id: "msg_2", streamId: "stream_private" })],
      ])
    )
    spyOn(streamsBarrel, "listAccessibleStreamIds").mockResolvedValue(new Set(["stream_a"]))
    spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(new Map())
    spyOn(LinkPreviewRepository, "findByMessageIds").mockResolvedValue(new Map())

    const result = await service.listLabeledMessages(WORKSPACE_ID, USER_ACTOR, LABEL_ID)

    expect(result.map((m) => m.id)).toEqual(["msg_1"])
  })

  it("returns [] without fetching messages when nothing is filed under the label", async () => {
    const service = setupService()
    spyOn(LabelAssignmentRepository, "listForLabelAndResourceType").mockResolvedValue([])
    const findByIds = spyOn(MessageRepository, "findByIds")

    const result = await service.listLabeledMessages(WORKSPACE_ID, USER_ACTOR, LABEL_ID)

    expect(result).toEqual([])
    expect(findByIds).not.toHaveBeenCalled()
  })
})
