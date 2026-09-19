import { describe, expect, it } from "vitest"
import {
  appendMessage,
  resolveTag,
  formatTitle,
  formatBody,
  isViewingStream,
  resolveActions,
  resolvePushActionLimit,
  resolveClickedAction,
  formatReminderDelay,
  planNotificationAction,
  withNotificationActionFailure,
  describeNotificationActionFailure,
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

  it("keeps only the first slot under a one-button limit", () => {
    expect(resolveActions("message", { pushActions: ["remind", "react"] }, 1)).toEqual([
      { action: "remind", title: "Remind me in 5m" },
    ])
  })
})

describe("resolveClickedAction", () => {
  const card = [{ action: "mark_read" }]

  it("reads a body tap as no action", () => {
    expect(resolveClickedAction("", card)).toBe("")
    expect(resolveClickedAction(undefined, card)).toBe("")
  })

  it("keeps an id the card actually rendered", () => {
    expect(resolveClickedAction("mark_read", card)).toBe("mark_read")
  })

  it("drops an id the card never carried, so a misrelayed tap still opens the app", () => {
    expect(resolveClickedAction("remind", card)).toBe("")
    expect(resolveClickedAction("remind", [])).toBe("")
  })

  it("trusts the id on a browser that does not expose the card's actions", () => {
    expect(resolveClickedAction("remind", undefined)).toBe("remind")
  })
})

describe("resolvePushActionLimit", () => {
  const android =
    "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36"
  const mac =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

  it("renders no buttons on Android, where the pressed one cannot be identified", () => {
    expect([android, mac].map(resolvePushActionLimit)).toEqual([0, 2])
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
      body: { lastMessageId: "msg_newest" },
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

describe("notification action failure", () => {
  it("tags the deep link with the failed action and its reason, keeping the existing query", () => {
    expect(withNotificationActionFailure("/w/ws_1/s/stream_1?m=msg_1", "mark_read", "http 401")).toBe(
      "/w/ws_1/s/stream_1?m=msg_1&notify_failed=mark_read%3Ahttp+401"
    )
  })

  it("turns the tag back into toast copy and ignores values the worker never writes", () => {
    expect(describeNotificationActionFailure("mark_read:network Failed to fetch")).toBe(
      "Couldn't mark as read from the notification (network Failed to fetch)."
    )
    expect(describeNotificationActionFailure("remind:http 401")).toBe(
      "Couldn't set the reminder from the notification (http 401)."
    )
    expect(describeNotificationActionFailure("bogus")).toBeNull()
    expect(describeNotificationActionFailure("mark_read:")).toBeNull()
    expect(describeNotificationActionFailure("open:http 500")).toBeNull()
  })
})
