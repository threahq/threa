import { describe, test, expect, spyOn, beforeEach, afterEach, mock } from "bun:test"
import { ConversationService } from "./service"
import * as dbModule from "../../db"
import { ConversationRepository, type Conversation } from "./repository"
import { StreamRepository } from "../streams"
import * as streamsModule from "../streams"
import { MessageRepository, type Message } from "../messaging"
import * as delivery from "./conversation-delivery"
import { OutboxRepository } from "../../lib/outbox"

const POOL = {} as never

function fakeConversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv_1",
    streamId: "stream_1",
    workspaceId: "ws_1",
    messageIds: ["m1"],
    participantIds: [],
    secondaryMessageIds: [],
    topicSummary: "Topic",
    summary: null,
    completenessScore: 3,
    confidence: 0.5,
    status: "resolved",
    parentConversationId: null,
    lastActivityAt: new Date("2026-07-05T00:00:00Z"),
    createdAt: new Date("2026-07-05T00:00:00Z"),
    updatedAt: new Date("2026-07-05T00:00:00Z"),
    ...over,
  }
}

describe("ConversationService.updateConversation — user status lock", () => {
  let updateSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    spyOn(dbModule, "withTransaction").mockImplementation((async (_pool: unknown, cb: (client: unknown) => unknown) =>
      cb({})) as never)
    updateSpy = spyOn(ConversationRepository, "update").mockResolvedValue(fakeConversation())
    spyOn(StreamRepository, "findById").mockResolvedValue({ id: "stream_1" } as never)
    spyOn(delivery, "resolveConversationDelivery").mockResolvedValue({
      parentStreamId: null,
      streamVisibility: "private",
    } as never)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
  })

  afterEach(() => mock.restore())

  test("locks the status against the extractor when the user sets it (Mark resolved / Reopen)", async () => {
    const service = new ConversationService(POOL)
    await service.updateConversation({ workspaceId: "ws_1", conversationId: "conv_1", status: "resolved" })

    expect(updateSpy).toHaveBeenCalledWith(
      expect.anything(),
      "ws_1",
      "conv_1",
      expect.objectContaining({ status: "resolved", statusLockedByUser: true })
    )
  })

  test("leaves the lock untouched on a rename-only edit (no status change)", async () => {
    const service = new ConversationService(POOL)
    await service.updateConversation({ workspaceId: "ws_1", conversationId: "conv_1", topicSummary: "New title" })

    const params = updateSpy.mock.calls[0]![3] as { topicSummary?: string; statusLockedByUser?: boolean }
    expect(params.topicSummary).toBe("New title")
    expect(params.statusLockedByUser).toBeUndefined()
  })
})

function fakeMessage(id: string, streamId: string, createdAt: string): Message {
  return { id, streamId, createdAt: new Date(createdAt) } as Message
}

describe("ConversationService.markRead/markUnread — conversation boundary", () => {
  beforeEach(() => {
    spyOn(dbModule, "withTransaction").mockImplementation((async (_pool: unknown, cb: (client: unknown) => unknown) =>
      cb({})) as never)
  })

  afterEach(() => mock.restore())

  test("rejects a foreign target message (not a conversation member) before any sparse write", async () => {
    spyOn(ConversationRepository, "findById").mockResolvedValue(
      fakeConversation({ messageIds: ["m1"], secondaryMessageIds: [] })
    )
    spyOn(StreamRepository, "findById").mockResolvedValue({
      id: "stream_1",
      rootStreamId: null,
      type: "channel",
      workspaceId: "ws_1",
    } as never)
    const applyRead = spyOn(streamsModule, "applySparseRead").mockResolvedValue({} as never)
    const applyUnread = spyOn(streamsModule, "applySparseUnread").mockResolvedValue({} as never)

    const service = new ConversationService(POOL)
    await expect(
      service.markRead({
        workspaceId: "ws_1",
        conversationId: "conv_1",
        throughMessageId: "msg_foreign",
        userId: "user_1",
      })
    ).rejects.toMatchObject({ status: 404, code: "MESSAGE_NOT_FOUND" })

    expect(applyRead).not.toHaveBeenCalled()
    expect(applyUnread).not.toHaveBeenCalled()
  })

  test("rejects a stale/corrupt member pointing at a foreign-stream before any sparse write", async () => {
    spyOn(ConversationRepository, "findById").mockResolvedValue(
      fakeConversation({ messageIds: ["m1", "m2"], secondaryMessageIds: [] })
    )
    spyOn(StreamRepository, "findById").mockResolvedValue({
      id: "stream_1",
      rootStreamId: null,
      type: "channel",
      workspaceId: "ws_1",
    } as never)
    // m1 (the target) lives in the conversation's stream; m2 is a corrupt member
    // whose stream sits in another workspace. m2 is earlier so the read cutoff
    // (<= target.createdAt) includes it — its stream reaches the boundary guard.
    spyOn(MessageRepository, "findByIds").mockResolvedValue(
      new Map([
        ["m1", fakeMessage("m1", "stream_1", "2026-01-02T00:00:00.000Z")],
        ["m2", fakeMessage("m2", "stream_foreign", "2026-01-01T00:00:00.000Z")],
      ])
    )
    spyOn(StreamRepository, "findByIds").mockResolvedValue([
      { id: "stream_1", rootStreamId: null, workspaceId: "ws_1" } as never,
      { id: "stream_foreign", rootStreamId: null, workspaceId: "ws_OTHER" } as never,
    ])
    const applyRead = spyOn(streamsModule, "applySparseRead").mockResolvedValue({} as never)
    const applyUnread = spyOn(streamsModule, "applySparseUnread").mockResolvedValue({} as never)

    const service = new ConversationService(POOL)
    await expect(
      service.markRead({
        workspaceId: "ws_1",
        conversationId: "conv_1",
        throughMessageId: "m1",
        userId: "user_1",
      })
    ).rejects.toMatchObject({ status: 404, code: "MESSAGE_NOT_FOUND" })

    expect(applyRead).not.toHaveBeenCalled()
    expect(applyUnread).not.toHaveBeenCalled()
  })

  test("rejects a member stream that resolves to a different effective root (INV-62)", async () => {
    spyOn(ConversationRepository, "findById").mockResolvedValue(
      fakeConversation({ messageIds: ["m1", "m2"], secondaryMessageIds: [] })
    )
    // Conversation lives under root stream_1.
    spyOn(StreamRepository, "findById").mockResolvedValue({
      id: "stream_1",
      rootStreamId: null,
      type: "channel",
      workspaceId: "ws_1",
    } as never)
    spyOn(MessageRepository, "findByIds").mockResolvedValue(
      new Map([
        ["m1", fakeMessage("m1", "stream_1", "2026-01-02T00:00:00.000Z")],
        // Same workspace, but a thread under a DIFFERENT root — foreign to this
        // conversation even though the workspace matches.
        ["m2", fakeMessage("m2", "thread_other_root", "2026-01-01T00:00:00.000Z")],
      ])
    )
    spyOn(StreamRepository, "findByIds").mockResolvedValue([
      { id: "stream_1", rootStreamId: null, workspaceId: "ws_1" } as never,
      { id: "thread_other_root", rootStreamId: "stream_OTHER_ROOT", workspaceId: "ws_1" } as never,
    ])
    const applyRead = spyOn(streamsModule, "applySparseRead").mockResolvedValue({} as never)

    const service = new ConversationService(POOL)
    await expect(
      service.markRead({
        workspaceId: "ws_1",
        conversationId: "conv_1",
        throughMessageId: "m1",
        userId: "user_1",
      })
    ).rejects.toMatchObject({ status: 404, code: "MESSAGE_NOT_FOUND" })

    expect(applyRead).not.toHaveBeenCalled()
  })
})
