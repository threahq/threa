import { describe, expect, test } from "bun:test"
import { selectConversationWindow } from "./conversation-window"
import type { Message } from "../messaging"

const base = Date.parse("2026-07-01T10:00:00Z")

function message(n: number, chars: number, edited?: number): Message {
  return {
    id: `msg_${String(n).padStart(2, "0")}`,
    streamId: "stream_1",
    sequence: BigInt(n),
    authorId: "usr_1",
    authorType: "user",
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "x".repeat(chars),
    replyCount: 0,
    revision: 1,
    clientMessageId: null,
    sentVia: null,
    reactions: {},
    metadata: {},
    conversationIntent: null,
    editedAt: edited === undefined ? null : new Date(base + edited * 60_000),
    deletedAt: null,
    createdAt: new Date(base + n * 60_000),
    ciphertext: null,
    envelope: null,
    e2eVersion: null,
  } as Message
}

const at = (minute: number) => new Date(base + minute * 60_000)
const ids = (messages: Message[]) => messages.map((m) => m.id)

describe("selectConversationWindow", () => {
  test("a conversation within budget is read whole, through its newest activity", () => {
    const messages = [message(2, 10), message(1, 10), message(3, 10, 9)]

    const window = selectConversationWindow(messages, at(2), 100)

    expect({ ...window, messages: ids(window.messages) }).toEqual({
      messages: ["msg_01", "msg_02", "msg_03"],
      readThrough: at(9),
      complete: true,
    })
  })

  test("an unread conversation over budget is read oldest first, leaving the rest for the next pass", () => {
    const messages = [1, 2, 3, 4, 5].map((n) => message(n, 40))

    const window = selectConversationWindow(messages, null, 100)

    expect({ ...window, messages: ids(window.messages) }).toEqual({
      messages: ["msg_01", "msg_02"],
      readThrough: at(2),
      complete: false,
    })
  })

  test("the next pass reads on from the watermark, topped up with the newest already-read messages", () => {
    const messages = [1, 2, 3, 4, 5].map((n) => message(n, 40))

    const window = selectConversationWindow(messages, at(3), 120)

    expect({ ...window, messages: ids(window.messages) }).toEqual({
      messages: ["msg_03", "msg_04", "msg_05"],
      readThrough: at(5),
      complete: true,
    })
  })

  test("an old message edited after the watermark is read again", () => {
    const messages = [message(1, 40, 10), message(2, 40), message(3, 40), message(4, 40)]

    const window = selectConversationWindow(messages, at(4), 50)

    expect({ ...window, messages: ids(window.messages) }).toEqual({
      messages: ["msg_01"],
      readThrough: at(10),
      complete: true,
    })
  })

  test("an unread message larger than the budget is still read alone", () => {
    const messages = [message(1, 10), message(2, 500), message(3, 10)]

    const window = selectConversationWindow(messages, at(1), 100)

    expect({ ...window, messages: ids(window.messages) }).toEqual({
      messages: ["msg_02"],
      readThrough: at(2),
      complete: false,
    })
  })

  test("messages sharing a millisecond are never split across passes", () => {
    const messages = [message(1, 60, 2), message(2, 60), message(3, 60)]

    const window = selectConversationWindow(messages, null, 100)

    expect({ ...window, messages: ids(window.messages) }).toEqual({
      messages: ["msg_01", "msg_02"],
      readThrough: at(2),
      complete: false,
    })
  })

  test("with nothing new, the newest messages fill the budget and the watermark stays", () => {
    const messages = [1, 2, 3, 4].map((n) => message(n, 40))

    const window = selectConversationWindow(messages, at(4), 100)

    expect({ ...window, messages: ids(window.messages) }).toEqual({
      messages: ["msg_03", "msg_04"],
      readThrough: at(4),
      complete: true,
    })
  })
})
