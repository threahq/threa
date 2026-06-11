import { describe, it, expect } from "vitest"
import type { ConversationWithStaleness, StreamEvent } from "@threa/types"
import { annotateConversationRows, type TimelineItem } from "../event-list"
import { buildConversationOverlayModel, CONVERSATION_COLOR_COUNT, conversationColor } from "./model"

function makeConversation(overrides: Partial<ConversationWithStaleness>): ConversationWithStaleness {
  return {
    id: "conv_1",
    streamId: "stream_123",
    workspaceId: "ws_1",
    messageIds: [],
    participantIds: [],
    secondaryMessageIds: [],
    topicSummary: null,
    completenessScore: 1,
    confidence: 0.5,
    status: "active",
    parentConversationId: null,
    lastActivityAt: "2026-06-01T00:00:00.000Z",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    temporalStaleness: 0,
    effectiveCompleteness: 1,
    ...overrides,
  }
}

function messageItem(messageId: string, extra?: Record<string, unknown>): TimelineItem {
  const event: StreamEvent = {
    id: `evt_${messageId}`,
    streamId: "stream_123",
    sequence: "1",
    eventType: "message_created",
    payload: { messageId, contentMarkdown: "hi", ...extra },
    actorId: "usr_1",
    actorType: "user",
    createdAt: "2026-06-01T00:00:00.000Z",
  }
  return { type: "event", event }
}

describe("buildConversationOverlayModel", () => {
  it("orders by createdAt, assigns palette slots, and indexes primary membership", () => {
    const conversations = [
      makeConversation({
        id: "conv_b",
        createdAt: "2026-06-02T00:00:00.000Z",
        messageIds: ["msg_3"],
      }),
      makeConversation({
        id: "conv_a",
        createdAt: "2026-06-01T00:00:00.000Z",
        messageIds: ["msg_1", "msg_2"],
        secondaryMessageIds: ["msg_3"],
      }),
    ]

    const model = buildConversationOverlayModel(conversations, "stream_123")

    expect(model.conversations.map((c) => c.id)).toEqual(["conv_a", "conv_b"])
    expect(model.colorIndexById.get("conv_a")).toBe(0)
    expect(model.colorIndexById.get("conv_b")).toBe(1)
    // Secondary membership does not own a row's color: msg_3's home is conv_b.
    expect(model.conversationIdByMessageId.get("msg_3")).toBe("conv_b")
    expect(model.conversationIdByMessageId.get("msg_1")).toBe("conv_a")
  })

  it("drops conversations from other streams (child threads)", () => {
    const conversations = [
      makeConversation({ id: "conv_thread", streamId: "stream_thread", messageIds: ["msg_t1"] }),
      makeConversation({ id: "conv_here", messageIds: ["msg_1"] }),
    ]

    const model = buildConversationOverlayModel(conversations, "stream_123")

    expect(model.conversations.map((c) => c.id)).toEqual(["conv_here"])
    expect(model.conversationIdByMessageId.has("msg_t1")).toBe(false)
  })

  it("wraps palette slots beyond the palette size", () => {
    const conversations = Array.from({ length: CONVERSATION_COLOR_COUNT + 1 }, (_, i) =>
      makeConversation({ id: `conv_${i}`, createdAt: `2026-06-01T00:00:0${Math.min(i, 9)}.00${i}Z` })
    )

    const model = buildConversationOverlayModel(conversations, "stream_123")

    const lastId = model.conversations[CONVERSATION_COLOR_COUNT].id
    expect(model.colorIndexById.get(lastId)).toBe(0)
  })
})

describe("conversationColor", () => {
  it("composes the palette variable with optional alpha", () => {
    expect(conversationColor(0)).toBe("hsl(var(--conversation-1))")
    expect(conversationColor(1, 0.1)).toBe("hsl(var(--conversation-2) / 0.1)")
    expect(conversationColor(CONVERSATION_COLOR_COUNT)).toBe("hsl(var(--conversation-1))")
  })
})

describe("annotateConversationRows", () => {
  const model = buildConversationOverlayModel(
    [
      makeConversation({
        id: "conv_a",
        createdAt: "2026-06-01T00:00:00.000Z",
        messageIds: ["msg_1", "msg_2", "msg_4"],
      }),
      makeConversation({ id: "conv_b", createdAt: "2026-06-02T00:00:00.000Z", messageIds: ["msg_3"] }),
    ],
    "stream_123"
  )

  function annotations(items: TimelineItem[]) {
    return annotateConversationRows(items, model).map((item) =>
      item.type === "event" ? (item.conversationRow ?? null) : null
    )
  }

  it("stamps each message with its conversation and marks block starts where it changes", () => {
    const result = annotations([messageItem("msg_1"), messageItem("msg_2"), messageItem("msg_3"), messageItem("msg_4")])

    expect(result).toEqual([
      { conversationId: "conv_a", blockStart: true },
      { conversationId: "conv_a", blockStart: false },
      { conversationId: "conv_b", blockStart: true },
      { conversationId: "conv_a", blockStart: true },
    ])
  })

  it("stamps unassigned messages with a null conversation and never a block start", () => {
    const result = annotations([messageItem("msg_unknown"), messageItem("msg_1")])

    expect(result).toEqual([
      { conversationId: null, blockStart: false },
      { conversationId: "conv_a", blockStart: true },
    ])
  })

  it("does not break a run across non-message items", () => {
    const gap: TimelineItem = { type: "gap", afterEventId: "evt_msg_1", missingCount: 1 }
    const result = annotateConversationRows([messageItem("msg_1"), gap, messageItem("msg_2")], model)

    expect(result[2]).toMatchObject({ conversationRow: { conversationId: "conv_a", blockStart: false } })
  })

  it("leaves deleted messages and non-message events unstamped", () => {
    const deleted = messageItem("msg_1", { deletedAt: "2026-06-01T01:00:00.000Z" })
    const membership: TimelineItem = {
      type: "event",
      event: {
        id: "evt_m",
        streamId: "stream_123",
        sequence: "9",
        eventType: "member_joined",
        payload: {},
        actorId: "usr_1",
        actorType: "user",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    }

    const result = annotateConversationRows([deleted, membership], model)
    expect(result.every((item) => item.type === "event" && item.conversationRow === undefined)).toBe(true)
  })
})
