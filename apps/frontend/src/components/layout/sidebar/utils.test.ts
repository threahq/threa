import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { AuthorTypes, StreamTypes, Visibilities, type AuthorType, type StreamWithPreview } from "@threa/types"
import { calculateUrgency, categorizeStream } from "./utils"

function makeStream(overrides: Partial<StreamWithPreview> = {}): StreamWithPreview {
  return {
    id: "stream_1",
    workspaceId: "workspace_1",
    type: StreamTypes.DM,
    displayName: "Pierre",
    slug: null,
    description: null,
    visibility: Visibilities.PRIVATE,
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "user_1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    archivedAt: null,
    lastMessagePreview: null,
    ...overrides,
  }
}

describe("calculateUrgency", () => {
  function streamWith(authorType: AuthorType | null) {
    return { lastMessagePreview: authorType ? { authorType } : null }
  }

  it("returns quiet when muted regardless of unread/mentions", () => {
    expect(calculateUrgency(streamWith("user"), 5, 3, true)).toBe("quiet")
  })

  it("prioritizes mentions ahead of any author signal", () => {
    expect(calculateUrgency(streamWith(AuthorTypes.PERSONA), 2, 1, false)).toBe("mentions")
  })

  it("returns ai for unread persona activity", () => {
    expect(calculateUrgency(streamWith(AuthorTypes.PERSONA), 1, 0, false)).toBe("ai")
  })

  it("returns bot for unread bot activity", () => {
    expect(calculateUrgency(streamWith(AuthorTypes.BOT), 1, 0, false)).toBe("bot")
  })

  it("returns activity for unread human activity", () => {
    expect(calculateUrgency(streamWith(AuthorTypes.USER), 1, 0, false)).toBe("activity")
  })

  it("returns activity for unread with no cached preview author", () => {
    expect(calculateUrgency(streamWith(null), 1, 0, false)).toBe("activity")
  })

  it("returns quiet with no unread and no mentions", () => {
    expect(calculateUrgency(streamWith(AuthorTypes.BOT), 0, 0, false)).toBe("quiet")
  })

  it("surfaces activity when a notification landed but unread was missed", () => {
    // activity:created bumped activityCount via the user room, but the per-stream
    // stream:activity that drives unreadCount never arrived — the sidebar should
    // still light up to match the Activity feed.
    expect(calculateUrgency(streamWith("user"), 0, 0, false, 2)).toBe("activity")
  })

  it("prefers mentions over the activity fallback", () => {
    expect(calculateUrgency(streamWith("user"), 0, 1, false, 2)).toBe("mentions")
  })

  it("prefers unread author-typed urgency over the activity fallback", () => {
    expect(calculateUrgency(streamWith(AuthorTypes.PERSONA), 1, 0, false, 2)).toBe("ai")
  })

  it("stays quiet when muted even with pending activity", () => {
    expect(calculateUrgency(streamWith("user"), 0, 0, true, 2)).toBe("quiet")
  })
})

describe("categorizeStream", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-05T12:00:00Z"))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("puts mentioned streams in 'important'", () => {
    expect(categorizeStream(makeStream(), 3, "mentions")).toBe("important")
  })

  it("puts AI activity with unread in 'important'", () => {
    expect(categorizeStream(makeStream(), 2, "ai")).toBe("important")
  })

  it("puts recently-active streams in 'recent'", () => {
    const stream = makeStream({
      lastMessagePreview: {
        authorId: "user_2",
        authorType: "user",
        content: "hello",
        createdAt: "2026-04-04T12:00:00Z", // 1 day ago
      },
    })
    expect(categorizeStream(stream, 0, "quiet")).toBe("recent")
  })

  it("puts old, inactive streams in 'other'", () => {
    const stream = makeStream({
      lastMessagePreview: {
        authorId: "user_2",
        authorType: "user",
        content: "hello",
        createdAt: "2026-03-01T12:00:00Z", // >7 days ago
      },
    })
    expect(categorizeStream(stream, 0, "quiet")).toBe("other")
  })

  it("keeps unread streams in 'recent' even when the cached preview is older than 7 days", () => {
    // Regression: an active DM should not sink into "Everything else" while
    // the user still has unread messages, even if the sidebar's cached
    // lastMessagePreview is momentarily stale.
    const stream = makeStream({
      lastMessagePreview: {
        authorId: "user_2",
        authorType: "user",
        content: "hello",
        createdAt: "2026-03-01T12:00:00Z", // >7 days ago
      },
    })
    expect(categorizeStream(stream, 3, "activity")).toBe("recent")
  })

  it("keeps unread streams in 'recent' even when there is no cached preview at all", () => {
    const stream = makeStream({ lastMessagePreview: null })
    expect(categorizeStream(stream, 1, "activity")).toBe("recent")
  })

  it("promotes activity-only streams to 'recent' even when the cached preview is stale", () => {
    // A notification arrived via the always-joined user room (urgency "activity")
    // before the per-stream stream:activity bumped the unread count. The sidebar
    // row glows, so it must not sink into "other" just because its last cached
    // message is older than 7 days.
    const stream = makeStream({
      lastMessagePreview: {
        authorId: "user_2",
        authorType: "user",
        content: "hello",
        createdAt: "2026-03-01T12:00:00Z", // >7 days ago
      },
    })
    expect(categorizeStream(stream, 0, "activity")).toBe("recent")
  })

  it("puts streams with no preview and no unread in 'other'", () => {
    const stream = makeStream({ lastMessagePreview: null })
    expect(categorizeStream(stream, 0, "quiet")).toBe("other")
  })

  it("does not promote muted streams with unreads into 'recent'", () => {
    // Regression: muting is an explicit deprioritization signal. A muted
    // stream with unread messages must not bubble back up to Recent just
    // because it has outstanding unread content — that defeats the purpose
    // of muting. It falls through to the standard recency check and, if the
    // preview is older than 7 days (or missing), lands in "other".
    const stream = makeStream({ lastMessagePreview: null })
    expect(categorizeStream(stream, 5, "quiet")).toBe("other")
  })

  it("still respects the 7-day window for muted streams with a recent preview", () => {
    const stream = makeStream({
      lastMessagePreview: {
        authorId: "user_2",
        authorType: "user",
        content: "hello",
        createdAt: "2026-04-04T12:00:00Z", // 1 day ago
      },
    })
    expect(categorizeStream(stream, 5, "quiet")).toBe("recent")
  })
})
