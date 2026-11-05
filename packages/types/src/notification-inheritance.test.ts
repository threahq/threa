import { describe, expect, test } from "bun:test"
import type { NotificationLevel } from "./constants"
import { resolveInheritedNotificationLevel } from "./notification-inheritance"

const ancestors = (...levels: (NotificationLevel | null)[]) =>
  levels.map((level, index) => ({ id: `a${index}`, level }))

describe("resolveInheritedNotificationLevel", () => {
  test("Muted carries as Muted and Everything as Activity; other levels leave the type default", () => {
    const thread = (level: NotificationLevel | null) => resolveInheritedNotificationLevel("thread", ancestors(level))
    expect({
      muted: thread("muted"),
      everything: thread("everything"),
      mentions: thread("mentions"),
      activity: thread("activity"),
      none: thread(null),
    }).toEqual({
      muted: { level: "muted", from: { id: "a0", level: "muted" } },
      everything: { level: "activity", from: { id: "a0", level: "everything" } },
      mentions: { level: "activity", from: null },
      activity: { level: "activity", from: null },
      none: { level: "activity", from: null },
    })
  })

  test("the nearest ancestor with a level decides, even when it carries nothing", () => {
    expect({
      skipsUnset: resolveInheritedNotificationLevel("thread", ancestors(null, "muted")),
      nearestStops: resolveInheritedNotificationLevel("thread", ancestors("mentions", "muted")),
      noAncestors: resolveInheritedNotificationLevel("channel", []),
    }).toEqual({
      skipsUnset: { level: "muted", from: { id: "a1", level: "muted" } },
      nearestStops: { level: "activity", from: null },
      noAncestors: { level: "mentions", from: null },
    })
  })

  test("a carried level the stream type doesn't allow leaves its default", () => {
    expect(resolveInheritedNotificationLevel("aside", ancestors("everything"))).toEqual({ level: "muted", from: null })
  })
})
