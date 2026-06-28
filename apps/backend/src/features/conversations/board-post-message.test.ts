import { describe, expect, it } from "bun:test"
import type { Message } from "../messaging"
import { toBoardPostMessage, toLiveBoardPostMessage } from "./board-post-message"

const createdAt = new Date("2026-06-22T12:00:00.000Z")

// Only the fields the board projection reads matter; the rest of Message is
// irrelevant to the lean post message.
const message = {
  id: "msg_1",
  authorId: "usr_1",
  authorType: "user",
  contentMarkdown: "hello **world**",
  reactions: { "👍": ["usr_2"] },
  createdAt,
} as unknown as Message

describe("toLiveBoardPostMessage", () => {
  it("projects the message body with empty enrichment for the live conversation payload", () => {
    expect(toLiveBoardPostMessage(message)).toEqual({
      id: "msg_1",
      authorId: "usr_1",
      authorType: "user",
      contentMarkdown: "hello **world**",
      reactions: { "👍": ["usr_2"] },
      attachments: [],
      linkPreviews: [],
      createdAt,
    })
  })

  it("matches the hydrated projection with no attachments or link previews", () => {
    expect(toLiveBoardPostMessage(message)).toEqual(toBoardPostMessage(message, [], []))
  })
})
