import { describe, test, expect, spyOn, beforeEach, afterEach, mock } from "bun:test"
import { ConversationService } from "./service"
import * as dbModule from "../../db"
import { ConversationRepository, type Conversation } from "./repository"
import { StreamRepository } from "../streams"
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
