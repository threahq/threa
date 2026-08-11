import { describe, it, expect, beforeEach } from "vitest"
import { partitionActivitySections, resetActivitySectionLatch } from "./use-activity-sections"
import type { Activity } from "@threa/types"

const WS = "ws_1"

function activity(id: string, overrides: Partial<Activity> = {}): Activity {
  return {
    id,
    workspaceId: WS,
    userId: "usr_me",
    activityType: "message",
    streamId: "stream_1",
    messageId: `msg_${id}`,
    actorId: "usr_other",
    actorType: "user",
    context: {},
    readAt: null,
    createdAt: "2026-08-11T10:00:00.000Z",
    isSelf: false,
    emoji: null,
    ...overrides,
  }
}

const read = (id: string) => activity(id, { readAt: "2026-08-11T09:00:00.000Z" })

describe("partitionActivitySections", () => {
  beforeEach(() => resetActivitySectionLatch())

  it("splits the feed into unread and already-read rows", () => {
    const rows = [activity("a"), read("b"), activity("c")]

    expect(partitionActivitySections(WS, rows)).toEqual({
      unread: [rows[0], rows[2]],
      read: [rows[1]],
      stillUnreadCount: 2,
    })
  })

  it("keeps a row in the unread section after it is read, and stops counting it", () => {
    partitionActivitySections(WS, [activity("a"), activity("b")])

    const rows = [read("a"), activity("b")]
    expect(partitionActivitySections(WS, rows)).toEqual({
      unread: [rows[0], rows[1]],
      read: [],
      stillUnreadCount: 1,
    })
  })

  it("prepends newly arrived unread rows above the latched ones", () => {
    partitionActivitySections(WS, [activity("a"), read("z")])

    const rows = [activity("new"), read("a"), read("z")]
    const sections = partitionActivitySections(WS, rows)

    expect(sections.unread.map((row) => row.id)).toEqual(["new", "a"])
    expect(sections.read.map((row) => row.id)).toEqual(["z"])
  })

  it("never latches self rows, which are inserted already read", () => {
    const rows = [activity("mine", { isSelf: true, actorId: "usr_me" })]

    expect(partitionActivitySections(WS, rows)).toEqual({ unread: [], read: rows, stillUnreadCount: 0 })
  })

  it("latches per workspace", () => {
    partitionActivitySections(WS, [activity("a")])

    expect(partitionActivitySections("ws_2", [read("a")]).unread).toEqual([])
  })
})
