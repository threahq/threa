import { describe, expect, it } from "vitest"
import type { AgentOutcomeSummary } from "@threahq/types"
import { followUpContextItems, withFollowUps } from "./follow-ups"
import type { DerivedStreamContext, LinkContextItem } from "./types"

function outcome(overrides: Partial<AgentOutcomeSummary> = {}): AgentOutcomeSummary {
  return {
    id: "afu_1",
    kind: "follow_up",
    streamId: "stream_1",
    title: "Check the deploy",
    status: "pending",
    scheduledFor: "2026-07-30T09:00:00.000Z",
    claimedByLabel: null,
    statusNote: null,
    resultMessageId: null,
    actorType: "persona",
    actorId: "persona_1",
    createdAt: "2026-07-29T10:00:00.000Z",
    statusChangedAt: "2026-07-29T10:00:00.000Z",
    occursAt: "2026-07-30T09:00:00.000Z",
    anchorEventId: "event_1",
    ...overrides,
  } as AgentOutcomeSummary
}

function linkItem(createdAt: string, key: string): LinkContextItem {
  return {
    key,
    category: "link",
    createdAt,
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

function derived(items: LinkContextItem[]): DerivedStreamContext {
  return {
    items,
    counts: { link: items.length, media: 0, file: 0, memo: 0, delegation: 0, follow_up: 0, thread: 0 },
    total: items.length,
  }
}

describe("followUpContextItems", () => {
  it("keeps only follow-ups and carries the anchor event as the jump target", () => {
    const items = followUpContextItems([
      outcome(),
      outcome({ id: "dlg_1", kind: "delegation", status: "open", scheduledFor: null }),
    ])

    expect(items).toEqual([
      {
        key: "follow_up:afu_1",
        category: "follow_up",
        createdAt: "2026-07-29T10:00:00.000Z",
        sourceMessageId: "event_1",
        snippet: "",
        followUpId: "afu_1",
        note: "Check the deploy",
        status: "pending",
        scheduledFor: "2026-07-30T09:00:00.000Z",
      },
    ])
  })

  it("leaves a follow-up with no anchor event without a jump target", () => {
    expect(followUpContextItems([outcome({ anchorEventId: null })])[0]!.sourceMessageId).toBeNull()
  })
})

describe("withFollowUps", () => {
  it("interleaves newest-first and bumps the follow_up count", () => {
    const base = derived([
      linkItem("2026-07-29T12:00:00.000Z", "link:a"),
      linkItem("2026-07-29T08:00:00.000Z", "link:b"),
    ])

    const merged = withFollowUps(
      base,
      followUpContextItems([outcome(), outcome({ id: "afu_2", createdAt: "2026-07-29T07:00:00.000Z" })])
    )

    expect(merged.items.map((i) => i.key)).toEqual(["link:a", "follow_up:afu_1", "link:b", "follow_up:afu_2"])
    expect(merged.counts.follow_up).toBe(2)
    expect(merged.total).toBe(4)
  })

  it("returns the input untouched when there are no follow-ups", () => {
    const base = derived([linkItem("2026-07-29T12:00:00.000Z", "link:a")])
    expect(withFollowUps(base, [])).toBe(base)
  })
})
