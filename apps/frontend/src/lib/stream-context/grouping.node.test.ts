import { describe, expect, it } from "vitest"
import { dayBucketLabel, groupItemsByDay } from "./grouping"
import type { ContextItem } from "./types"

// Constructed via local-time components so the day boundaries the function uses
// (INV-42: device-local) are deterministic regardless of the runner's timezone.
const NOW = new Date(2026, 5, 24, 10, 0, 0) // 2026-06-24 10:00 local

function linkItem(date: Date): ContextItem {
  return {
    key: `link:${date.getTime()}`,
    category: "link",
    createdAt: date.toISOString(),
    sourceMessageId: "msg_1",
    snippet: "",
    url: "https://example.com",
    title: null,
    siteName: null,
    faviconUrl: null,
    imageUrl: null,
    previewKind: "generic",
    badge: null,
    refCount: 1,
  }
}

describe("dayBucketLabel", () => {
  it("labels today and yesterday", () => {
    expect(dayBucketLabel(new Date(2026, 5, 24, 8, 0, 0), NOW)).toBe("Today")
    expect(dayBucketLabel(new Date(2026, 5, 23, 23, 0, 0), NOW)).toBe("Yesterday")
  })

  it("uses a weekday within the last week and a date beyond it", () => {
    // 3 days ago → a weekday name (locale-dependent), just not a relative bucket
    const weekday = dayBucketLabel(new Date(2026, 5, 21, 10, 0, 0), NOW)
    expect(weekday).not.toBe("Today")
    expect(weekday).not.toBe("Yesterday")

    // 10 days ago → an absolute date, matching the same locale formatting
    const older = new Date(2026, 5, 14, 10, 0, 0)
    expect(dayBucketLabel(older, NOW)).toBe(older.toLocaleDateString(undefined, { month: "short", day: "numeric" }))
  })
})

describe("groupItemsByDay", () => {
  it("buckets consecutive items into day groups in order", () => {
    const items = [
      linkItem(new Date(2026, 5, 24, 9, 0, 0)),
      linkItem(new Date(2026, 5, 24, 8, 0, 0)),
      linkItem(new Date(2026, 5, 23, 20, 0, 0)),
    ]
    const groups = groupItemsByDay(items, NOW)
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday"])
    expect(groups[0].items).toHaveLength(2)
    expect(groups[1].items).toHaveLength(1)
  })

  it("returns no groups for an empty list", () => {
    expect(groupItemsByDay([], NOW)).toEqual([])
  })
})
