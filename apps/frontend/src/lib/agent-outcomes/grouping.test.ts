import { describe, expect, it } from "vitest"
import { groupOutcomesByDay } from "./grouping"
import type { OutcomeItem } from "./items"

const NOW = new Date("2026-07-28T12:00:00")

function item(overrides: Partial<OutcomeItem> & { id: string; occursAt: string }): OutcomeItem {
  return {
    kind: "follow_up",
    streamId: "str_design",
    title: "A follow-up",
    statusLabel: "Scheduled",
    statusPillClass: "",
    isSettled: false,
    scheduledFor: overrides.occursAt,
    claimedByLabel: null,
    statusNote: null,
    createdAt: overrides.occursAt,
    statusChangedAt: overrides.occursAt,
    anchorPath: null,
    canCancel: true,
    canMarkDone: false,
    ...overrides,
  }
}

describe("groupOutcomesByDay", () => {
  it("puts an overdue outstanding follow-up in Now, not in its calendar day", () => {
    const groups = groupOutcomesByDay([item({ id: "fup_late", occursAt: "2026-07-26T09:00:00" })], NOW)
    expect(groups.map((g) => g.label)).toEqual(["Now"])
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["fup_late"])
  })

  it("keeps a settled outcome in its calendar day even when it is in the past", () => {
    const groups = groupOutcomesByDay([item({ id: "fup_done", occursAt: "2026-07-27T09:00:00", isSettled: true })], NOW)
    expect(groups.map((g) => g.label)).toEqual(["Yesterday"])
  })

  it("interleaves both kinds inside Now", () => {
    const groups = groupOutcomesByDay(
      [
        item({ id: "deleg_1", kind: "delegation", occursAt: "2026-07-28T10:30:00" }),
        item({ id: "fup_late", occursAt: "2026-07-27T08:00:00" }),
      ],
      NOW
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["deleg_1", "fup_late"])
  })

  it("buckets later today, tomorrow, and beyond the horizon", () => {
    const groups = groupOutcomesByDay(
      [
        item({ id: "far", occursAt: "2026-08-20T09:00:00" }),
        item({ id: "tomorrow", occursAt: "2026-07-29T09:00:00" }),
        item({ id: "tonight", occursAt: "2026-07-28T22:00:00" }),
      ],
      NOW
    )
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Today", ["tonight"]],
      ["Wednesday, July 29", ["tomorrow"]],
      ["Later", ["far"]],
    ])
  })

  it("leads with Now and trails with Later regardless of arrival order", () => {
    const groups = groupOutcomesByDay(
      [
        item({ id: "far", occursAt: "2026-09-01T09:00:00" }),
        item({ id: "tonight", occursAt: "2026-07-28T22:00:00" }),
        item({ id: "overdue", occursAt: "2026-07-20T09:00:00" }),
      ],
      NOW
    )
    expect(groups.map((g) => g.label)).toEqual(["Now", "Today", "Later"])
  })

  it("orders the days between Today and Later chronologically from a DESC page", () => {
    const groups = groupOutcomesByDay(
      [
        item({ id: "far", occursAt: "2026-09-01T09:00:00" }),
        item({ id: "fri", occursAt: "2026-07-31T09:00:00" }),
        item({ id: "thu", occursAt: "2026-07-30T09:00:00" }),
        item({ id: "wed", occursAt: "2026-07-29T09:00:00" }),
        item({ id: "tonight", occursAt: "2026-07-28T22:00:00" }),
        item({ id: "overdue", occursAt: "2026-07-20T09:00:00" }),
      ],
      NOW
    )
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Now", ["overdue"]],
      ["Today", ["tonight"]],
      ["Wednesday, July 29", ["wed"]],
      ["Thursday, July 30", ["thu"]],
      ["Friday, July 31", ["fri"]],
      ["Later", ["far"]],
    ])
  })

  it("returns no groups for an empty list", () => {
    expect(groupOutcomesByDay([], NOW)).toEqual([])
  })
})
