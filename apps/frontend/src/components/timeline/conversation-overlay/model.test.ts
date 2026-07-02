import { describe, it, expect } from "vitest"
import type { ConversationWithStaleness, StreamEvent } from "@threa/types"
import { annotateConversationRows, annotateConversationRevivals, type TimelineItem } from "../event-list"
import {
  buildConversationOverlayModel,
  buildMessageConversationMap,
  CONVERSATION_COLOR_COUNT,
  conversationColor,
} from "./model"

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
})

describe("buildMessageConversationMap", () => {
  it("maps both primary and secondary members, with primary winning a conflict", () => {
    const conversations = [
      makeConversation({ id: "conv_a", messageIds: ["msg_1", "msg_2"], secondaryMessageIds: ["msg_3"] }),
      // msg_3 is conv_b's primary (its canonical home) and conv_a's secondary.
      makeConversation({ id: "conv_b", messageIds: ["msg_3"] }),
    ]

    const map = buildMessageConversationMap(conversations)

    expect(map.get("msg_1")).toBe("conv_a")
    // Secondary membership is still resolvable — unlike the overlay model.
    expect(map.get("msg_2")).toBe("conv_a")
    // Primary wins: msg_3 resolves to its home conv_b, not the secondary conv_a.
    expect(map.get("msg_3")).toBe("conv_b")
  })

  it("resolves a cross-stream (thread) member of a root conversation", () => {
    // A conversation can span the root + its threads (one root): the opener is
    // a primary member in the root, the thread reply a secondary member living
    // in the thread stream. Both must resolve to the same conversation.
    const conversations = [
      makeConversation({
        id: "conv_root",
        streamId: "stream_123",
        messageIds: ["msg_root"],
        secondaryMessageIds: ["msg_thread_reply"],
      }),
    ]

    const map = buildMessageConversationMap(conversations)

    expect(map.get("msg_root")).toBe("conv_root")
    expect(map.get("msg_thread_reply")).toBe("conv_root")
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

describe("annotateConversationRevivals", () => {
  function msg(messageId: string, createdAt: string): TimelineItem {
    return {
      type: "event",
      event: {
        id: `evt_${messageId}`,
        streamId: "stream_123",
        sequence: "1",
        eventType: "message_created",
        payload: { messageId, contentMarkdown: "hi" },
        actorId: "usr_1",
        actorType: "user",
        createdAt,
      },
    }
  }

  const conversationsById = new Map<string, ConversationWithStaleness>([
    ["conv_a", makeConversation({ id: "conv_a", topicSummary: "Pizza" })],
    ["conv_b", makeConversation({ id: "conv_b", topicSummary: "Bug" })],
  ])

  function revivals(items: TimelineItem[], membership: Record<string, string>) {
    return annotateConversationRevivals(items, new Map(Object.entries(membership)), conversationsById).map((item) =>
      item.type === "event" ? (item.revival ?? null) : null
    )
  }

  it("marks a reopened conversation as a revival, anchored to its prior member time", () => {
    const items = [
      msg("a1", "2026-06-01T00:00:00.000Z"),
      msg("b1", "2026-06-01T00:01:00.000Z"),
      msg("a2", "2026-06-01T03:00:00.000Z"),
    ]
    const membership = { a1: "conv_a", b1: "conv_b", a2: "conv_a" }

    expect(revivals(items, membership)).toEqual([
      null,
      null,
      { conversationId: "conv_a", topicSummary: "Pizza", previousActivityAt: "2026-06-01T00:00:00.000Z" },
    ])
  })

  it("does not mark a contiguous run or a conversation's first appearance", () => {
    const items = [
      msg("a1", "2026-06-01T00:00:00.000Z"),
      msg("a2", "2026-06-01T00:01:00.000Z"),
      msg("b1", "2026-06-01T00:02:00.000Z"),
    ]
    const membership = { a1: "conv_a", a2: "conv_a", b1: "conv_b" }

    expect(revivals(items, membership)).toEqual([null, null, null])
  })

  it("does not manufacture a revival when only an unassigned aside separates two members", () => {
    // a1 → x1(unassigned) → a2, all with no *other* conversation between. A lone
    // unclustered message is not a topic switch, so a2 must not get a chip.
    const items = [
      msg("a1", "2026-06-01T00:00:00.000Z"),
      msg("x1", "2026-06-01T00:01:00.000Z"),
      msg("a2", "2026-06-01T00:02:00.000Z"),
    ]
    const membership = { a1: "conv_a", a2: "conv_a" }

    expect(revivals(items, membership)).toEqual([null, null, null])
  })

  it("ignores unassigned rows and does not break the run across non-message items", () => {
    const gap: TimelineItem = { type: "gap", afterEventId: "evt_a1", missingCount: 1 }
    const items = [
      msg("a1", "2026-06-01T00:00:00.000Z"),
      msg("x1", "2026-06-01T00:01:00.000Z"),
      msg("b1", "2026-06-01T00:02:00.000Z"),
      gap,
      msg("a2", "2026-06-01T00:03:00.000Z"),
    ]
    // x1 is unassigned (no membership entry); the gap sits between b1 and a2.
    const membership = { a1: "conv_a", b1: "conv_b", a2: "conv_a" }

    const result = revivals(items, membership)
    expect(result[1]).toBeNull()
    expect(result[3]).toBeNull()
    expect(result[4]).toEqual({
      conversationId: "conv_a",
      topicSummary: "Pizza",
      previousActivityAt: "2026-06-01T00:00:00.000Z",
    })
  })
})
