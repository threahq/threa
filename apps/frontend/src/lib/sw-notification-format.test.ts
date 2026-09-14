import { describe, expect, it } from "vitest"
import {
  appendMessage,
  resolveTag,
  formatTitle,
  formatBody,
  isViewingStream,
  resolveActions,
  formatReminderDelay,
  planNotificationAction,
  countNotifiedMessages,
  resolveLatestMessageId,
  type NotificationMessage,
} from "./sw-notification-format"

describe("resolveLatestMessageId", () => {
  it("advances to each new message", () => {
    expect(resolveLatestMessageId(undefined, { activityType: "message", messageId: "msg_1" })).toBe("msg_1")
    expect(
      resolveLatestMessageId(
        { messageId: "msg_1", latestMessageId: "msg_1" },
        { activityType: "message", messageId: "msg_2" }
      )
    ).toBe("msg_2")
  })

  it("keeps the newer message when a reaction to an older one joins the card", () => {
    expect(
      resolveLatestMessageId(
        { messageId: "msg_1", latestMessageId: "msg_2" },
        { activityType: "reaction", messageId: "msg_0" }
      )
    ).toBe("msg_2")
  })

  it("acts on the reacted message when the card holds nothing else", () => {
    expect(resolveLatestMessageId(undefined, { activityType: "reaction", messageId: "msg_0" })).toBe("msg_0")
  })
})

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

  it("lists the newest message first so the collapsed banner shows it", () => {
    const messages: NotificationMessage[] = [
      { authorName: "Alice", contentPreview: "hello" },
      { authorName: "Bob", contentPreview: "world" },
      { authorName: "Carol", contentPreview: "latest" },
    ]
    expect(formatBody(messages)).toBe("Carol: latest\nBob: world\nAlice: hello")
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
    expect(formatBody(messages)).toBe('Pierre reacted 🫡 to "hello"\nAlice: hello')
  })
})

describe("resolveActions", () => {
  it("defaults to mark read and a 5m reminder for a message", () => {
    expect(resolveActions("message", {})).toEqual([
      { action: "mark_read", title: "Mark read" },
      { action: "remind", title: "Remind me in 5m" },
    ])
  })

  it("follows the user's slots, duration, and quick reaction", () => {
    expect(
      resolveActions("message", { pushActions: ["react", "remind"], pushReminderMinutes: 120, pushQuickReaction: "🎉" })
    ).toEqual([
      { action: "react", title: "🎉" },
      { action: "remind", title: "Remind me in 2h" },
    ])
  })

  it("drops the reaction button on a reaction push, since the message is the reader's own", () => {
    expect(resolveActions("reaction", { pushActions: ["mark_read", "react"] })).toEqual([
      { action: "mark_read", title: "Mark read" },
    ])
  })

  it("honours an empty slot list and never exceeds two buttons", () => {
    expect(resolveActions("message", { pushActions: [] })).toEqual([])
    expect(resolveActions("message", { pushActions: ["mark_read", "remind", "react"] })).toEqual([
      { action: "mark_read", title: "Mark read" },
      { action: "remind", title: "Remind me in 5m" },
    ])
  })
})

describe("formatReminderDelay", () => {
  it("picks the largest whole unit", () => {
    expect([5, 90, 60, 1440, 4320].map(formatReminderDelay)).toEqual(["5m", "90m", "1h", "1d", "3d"])
  })
})

describe("planNotificationAction", () => {
  const data = { workspaceId: "ws_1", streamId: "stream_1", messageId: "msg_oldest", latestMessageId: "msg_newest" }

  it("marks the stream read through the newest message of the card", () => {
    expect(planNotificationAction("mark_read", data)).toEqual({
      url: "/api/workspaces/ws_1/streams/stream_1/read",
      body: { lastEventId: "msg_newest" },
    })
  })

  it("reacts to the newest message of the card with the user's quick reaction", () => {
    expect(planNotificationAction("react", { ...data, pushQuickReaction: "🎉" })).toEqual({
      url: "/api/workspaces/ws_1/messages/msg_newest/reactions",
      body: { emoji: "🎉" },
    })
    expect(planNotificationAction("react", data)?.body).toEqual({ emoji: "👍" })
  })

  it("saves the newest message with a reminder the configured minutes ahead", () => {
    const now = Date.UTC(2026, 8, 14, 12, 0, 0)
    expect(planNotificationAction("remind", { ...data, pushReminderMinutes: 30 }, now)).toEqual({
      url: "/api/workspaces/ws_1/saved",
      body: { messageId: "msg_newest", remindAt: "2026-09-14T12:30:00.000Z" },
    })
    expect(planNotificationAction("remind", data, now)?.body.remindAt).toBe("2026-09-14T12:05:00.000Z")
  })

  it("falls back to the deep-link message when no newer one is recorded", () => {
    expect(planNotificationAction("react", { ...data, latestMessageId: undefined })?.url).toBe(
      "/api/workspaces/ws_1/messages/msg_oldest/reactions"
    )
  })

  it("returns null without the ids to act on, or for an unknown action", () => {
    expect(planNotificationAction("mark_read", { ...data, streamId: undefined })).toBeNull()
    expect(planNotificationAction("react", { workspaceId: "ws_1" })).toBeNull()
    expect(planNotificationAction("mute", data)).toBeNull()
  })
})

describe("countNotifiedMessages", () => {
  it("sums the messages behind every card and ignores cards without any", () => {
    expect(
      countNotifiedMessages([{ messages: [{}, {}, {}] }, { messages: [{}] }, { kind: "call_ring" } as never, undefined])
    ).toBe(4)
  })
})
