import { describe, expect, it } from "vitest"
import {
  appendMessage,
  resolveTag,
  formatTitle,
  formatBody,
  isViewingStream,
  type NotificationMessage,
} from "./sw-notification-format"

describe("resolveTag", () => {
  it("returns streamId for message activity", () => {
    expect(resolveTag("stream_123", "message")).toBe("stream_123")
  })

  it("returns streamId:mention for mention activity", () => {
    expect(resolveTag("stream_123", "mention")).toBe("stream_123:mention")
  })

  it("returns streamId when activityType is undefined", () => {
    expect(resolveTag("stream_123")).toBe("stream_123")
  })
})

describe("isViewingStream", () => {
  const ORIGIN = "https://app.threa.io"

  it("matches a window viewing the same workspace + stream", () => {
    expect(isViewingStream(`${ORIGIN}/w/ws_1/s/stream_1`, "ws_1", "stream_1")).toBe(true)
  })

  it("ignores a query string (open thread still counts as the stream)", () => {
    expect(isViewingStream(`${ORIGIN}/w/ws_1/s/stream_1?m=msg_9`, "ws_1", "stream_1")).toBe(true)
  })

  it("does not match a different stream in the same workspace", () => {
    expect(isViewingStream(`${ORIGIN}/w/ws_1/s/stream_2`, "ws_1", "stream_1")).toBe(false)
  })

  it("does not match the same stream id in a different workspace", () => {
    expect(isViewingStream(`${ORIGIN}/w/ws_2/s/stream_1`, "ws_1", "stream_1")).toBe(false)
  })

  it("does not match a non-stream view", () => {
    expect(isViewingStream(`${ORIGIN}/w/ws_1/saved`, "ws_1", "stream_1")).toBe(false)
    expect(isViewingStream(`${ORIGIN}/w/ws_1`, "ws_1", "stream_1")).toBe(false)
    expect(isViewingStream(`${ORIGIN}/workspaces`, "ws_1", "stream_1")).toBe(false)
  })

  it("returns false when the push has no stream/workspace id (cannot confirm the view)", () => {
    expect(isViewingStream(`${ORIGIN}/w/ws_1/s/stream_1`, undefined, "stream_1")).toBe(false)
    expect(isViewingStream(`${ORIGIN}/w/ws_1/s/stream_1`, "ws_1", undefined)).toBe(false)
  })

  it("returns false for a malformed url", () => {
    expect(isViewingStream("not a url", "ws_1", "stream_1")).toBe(false)
  })
})

describe("appendMessage", () => {
  it("appends to empty list", () => {
    const result = appendMessage([], { authorName: "Alice", contentPreview: "hello" })
    expect(result).toEqual([{ authorName: "Alice", contentPreview: "hello" }])
  })

  it("appends to existing list", () => {
    const existing: NotificationMessage[] = [{ authorName: "Alice", contentPreview: "first" }]
    const result = appendMessage(existing, { authorName: "Bob", contentPreview: "second" })
    expect(result).toEqual([
      { authorName: "Alice", contentPreview: "first" },
      { authorName: "Bob", contentPreview: "second" },
    ])
  })

  it("caps at 5 messages, dropping oldest", () => {
    const existing: NotificationMessage[] = Array.from({ length: 5 }, (_, i) => ({
      authorName: `User${i}`,
      contentPreview: `msg${i}`,
    }))
    const result = appendMessage(existing, { authorName: "New", contentPreview: "latest" })
    expect(result).toHaveLength(5)
    expect(result[0].authorName).toBe("User1")
    expect(result[4]).toEqual({ authorName: "New", contentPreview: "latest" })
  })

  it("does not mutate the input array", () => {
    const existing: NotificationMessage[] = [{ authorName: "Alice", contentPreview: "hi" }]
    appendMessage(existing, { authorName: "Bob", contentPreview: "hey" })
    expect(existing).toHaveLength(1)
  })
})

describe("formatTitle", () => {
  it("single message with stream name", () => {
    const messages: NotificationMessage[] = [{ authorName: "Alice", contentPreview: "hey" }]
    expect(formatTitle(messages, "#general")).toBe("#general")
  })

  it("single message without stream name", () => {
    const messages: NotificationMessage[] = [{ authorName: "Alice", contentPreview: "hey" }]
    expect(formatTitle(messages)).toBe("New message")
  })

  it("single mention with stream name", () => {
    const messages: NotificationMessage[] = [{ authorName: "Alice", contentPreview: "hey @bob" }]
    expect(formatTitle(messages, "#general", "mention")).toBe("Mentioned in #general")
  })

  it("single mention without stream name", () => {
    const messages: NotificationMessage[] = [{ authorName: "Alice", contentPreview: "hey @bob" }]
    expect(formatTitle(messages, undefined, "mention")).toBe("You were mentioned")
  })

  it("multiple messages with stream name", () => {
    const messages: NotificationMessage[] = [
      { authorName: "Alice", contentPreview: "first" },
      { authorName: "Bob", contentPreview: "second" },
      { authorName: "Carol", contentPreview: "third" },
    ]
    expect(formatTitle(messages, "#general")).toBe("#general · 3 new messages")
  })

  it("multiple messages without stream name", () => {
    const messages: NotificationMessage[] = [
      { authorName: "Alice", contentPreview: "first" },
      { authorName: "Bob", contentPreview: "second" },
    ]
    expect(formatTitle(messages)).toBe("2 new messages")
  })

  it("multiple mentions with stream name", () => {
    const messages: NotificationMessage[] = [
      { authorName: "Alice", contentPreview: "hey @bob" },
      { authorName: "Carol", contentPreview: "@bob check this" },
    ]
    expect(formatTitle(messages, "#general", "mention")).toBe("2 new mentions in #general")
  })
})

describe("formatBody", () => {
  it("single message with author and preview", () => {
    const messages: NotificationMessage[] = [{ authorName: "Alice", contentPreview: "hello team" }]
    expect(formatBody(messages)).toBe("Alice: hello team")
  })

  it("single message without author", () => {
    const messages: NotificationMessage[] = [{ contentPreview: "hello team" }]
    expect(formatBody(messages)).toBe("hello team")
  })

  it("single message with author but no preview", () => {
    const messages: NotificationMessage[] = [{ authorName: "Alice" }]
    expect(formatBody(messages)).toBe("Alice")
  })

  it("single message with neither author nor preview", () => {
    const messages: NotificationMessage[] = [{}]
    expect(formatBody(messages)).toBe("New message")
  })

  it("multiple messages joined by newlines", () => {
    const messages: NotificationMessage[] = [
      { authorName: "Alice", contentPreview: "hello" },
      { authorName: "Bob", contentPreview: "world" },
    ]
    expect(formatBody(messages)).toBe("Alice: hello\nBob: world")
  })

  it("truncates long previews at 80 chars", () => {
    const longPreview = "a".repeat(100)
    const messages: NotificationMessage[] = [{ authorName: "Alice", contentPreview: longPreview }]
    const body = formatBody(messages)
    // "Alice: " + 79 chars + "…" = within limit
    expect(body).toBe(`Alice: ${"a".repeat(79)}…`)
  })

  it("formats a reaction with author, emoji, and preview", () => {
    const messages: NotificationMessage[] = [{ authorName: "Pierre", contentPreview: "ship it", emoji: "🫡" }]
    expect(formatBody(messages)).toBe('Pierre reacted 🫡 to "ship it"')
  })

  it("formats a reaction without a preview", () => {
    const messages: NotificationMessage[] = [{ authorName: "Pierre", emoji: "🫡" }]
    expect(formatBody(messages)).toBe("Pierre reacted 🫡")
  })

  it("formats a reaction without an author", () => {
    const messages: NotificationMessage[] = [{ contentPreview: "ship it", emoji: "🫡" }]
    expect(formatBody(messages)).toBe('Someone reacted 🫡 to "ship it"')
  })

  it("mixes reaction and message lines in a grouped body", () => {
    const messages: NotificationMessage[] = [
      { authorName: "Alice", contentPreview: "hello" },
      { authorName: "Pierre", contentPreview: "hello", emoji: "🫡" },
    ]
    expect(formatBody(messages)).toBe('Alice: hello\nPierre reacted 🫡 to "hello"')
  })
})
