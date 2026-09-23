import { describe, expect, it } from "vitest"
import type { StreamEvent } from "@threahq/types"
import { foldHoverMessages } from "./stream-hover-card"

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
})
