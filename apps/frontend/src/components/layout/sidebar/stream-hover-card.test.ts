import { describe, expect, it } from "vitest"
import type { StreamEvent } from "@threahq/types"
import type { HoverCardMessage } from "@/hooks/use-hover-card-messages"
import { groupHoverMessages } from "./stream-hover-card"

let seq = 0

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
