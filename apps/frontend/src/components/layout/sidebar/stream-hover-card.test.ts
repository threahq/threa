import { describe, expect, it } from "vitest"
import type { StreamEvent } from "@threahq/types"
import { foldHoverMessages, groupHoverMessages, type HoverCardMessage } from "./stream-hover-card"

let seq = 0
function event(eventType: string, payload: Record<string, unknown>): StreamEvent {
  seq += 1
  return {
    id: `evt_${seq}`,
    streamId: "stream_1",
    sequence: String(seq),
    eventType,
    payload,
    actorId: "usr_1",
    actorType: "user",
    createdAt: new Date(2026, 8, 23, 10, seq).toISOString(),
  } as StreamEvent
}

function view(events: StreamEvent[], limit?: number) {
  return foldHoverMessages(events, limit).map((m) => ({
    id: m.messageId,
    content: (m.event.payload as { contentMarkdown?: string }).contentMarkdown,
  }))
}

describe("foldHoverMessages", () => {
  it("should apply edits, drop deleted messages, and keep the latest in order", () => {
    const events = [
      event("message_created", { messageId: "msg_a", contentMarkdown: "a" }),
      event("message_created", { messageId: "msg_b", contentMarkdown: "b" }),
      event("message_created", { messageId: "msg_c", contentMarkdown: "c" }),
      event("message_edited", { messageId: "msg_a", contentMarkdown: "a edited" }),
      event("message_deleted", { messageId: "msg_b" }),
      event("message_created", { messageId: "msg_d", contentMarkdown: "d" }),
    ]

    expect(view(events, 2)).toEqual([
      { id: "msg_c", content: "c" },
      { id: "msg_d", content: "d" },
    ])
    expect(view(events)).toEqual([
      { id: "msg_a", content: "a edited" },
      { id: "msg_c", content: "c" },
      { id: "msg_d", content: "d" },
    ])
  })

  it("should ignore edits for messages outside the fetched window", () => {
    const events = [
      event("message_edited", { messageId: "msg_old", contentMarkdown: "x" }),
      event("message_created", { messageId: "msg_new", contentMarkdown: "new" }),
    ]

    expect(view(events)).toEqual([{ id: "msg_new", content: "new" }])
  })

  it("should fold reaction events into the message they target", () => {
    const events = [
      event("message_created", { messageId: "msg_a", contentMarkdown: "a" }),
      event("reaction_added", { messageId: "msg_a", emoji: ":+1:", userId: "usr_1" }),
      event("reaction_added", { messageId: "msg_a", emoji: ":+1:", userId: "usr_2" }),
      event("reaction_added", { messageId: "msg_a", emoji: ":fire:", userId: "usr_1" }),
      event("message_edited", { messageId: "msg_a", contentMarkdown: "a edited" }),
      event("reaction_removed", { messageId: "msg_a", emoji: ":fire:", userId: "usr_1" }),
      event("reaction_removed", { messageId: "msg_a", emoji: ":+1:", userId: "usr_1" }),
    ]

    expect(foldHoverMessages(events)[0].event.payload).toMatchObject({
      contentMarkdown: "a edited",
      reactions: { ":+1:": ["usr_2"] },
    })
  })
})

function message(id: string, actorId: string, minute: number): HoverCardMessage {
  seq += 1
  return {
    messageId: id,
    sequence: BigInt(seq),
    event: {
      id: `evt_${seq}`,
      streamId: "stream_1",
      sequence: String(seq),
      eventType: "message_created",
      payload: { messageId: id },
      actorId,
      actorType: "user",
      createdAt: new Date(2026, 8, 23, 10, minute).toISOString(),
    } as StreamEvent,
  }
}

function runs(messages: HoverCardMessage[], firstUnreadIndex = -1) {
  return groupHoverMessages(messages, firstUnreadIndex).map((group) => ({
    startsUnread: group.startsUnread,
    ids: group.messages.map((m) => m.messageId),
  }))
}

describe("groupHoverMessages", () => {
  it("should group a same-author run and split on author change or a gap past the run window", () => {
    const messages = [
      message("msg_a", "usr_1", 0),
      message("msg_b", "usr_1", 2),
      message("msg_c", "usr_2", 3),
      message("msg_d", "usr_2", 20),
    ]

    expect(runs(messages)).toEqual([
      { startsUnread: false, ids: ["msg_a", "msg_b"] },
      { startsUnread: false, ids: ["msg_c"] },
      { startsUnread: false, ids: ["msg_d"] },
    ])
  })

  it("should start a new run at the first unread message", () => {
    const messages = [message("msg_a", "usr_1", 0), message("msg_b", "usr_1", 1), message("msg_c", "usr_1", 2)]

    expect(runs(messages, 1)).toEqual([
      { startsUnread: false, ids: ["msg_a"] },
      { startsUnread: true, ids: ["msg_b", "msg_c"] },
    ])
  })
})
