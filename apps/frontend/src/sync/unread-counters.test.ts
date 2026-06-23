import { describe, it, expect } from "vitest"
import type { Activity } from "@threa/types"
import {
  applyStreamActivityOrdinal,
  applyStreamReadOrdinal,
  applyStreamReadSet,
  applyStreamsReadAllOrdinals,
  deriveActivityCounts,
  upsertActivity,
  dropActivitiesForStream,
  dropReactionActivity,
  rehomeActivities,
  clearActivities,
  type UnreadCounterState,
} from "./unread-counters"

function act(id: string, streamId: string | null, activityType = "message", extra: Partial<Activity> = {}): Activity {
  return {
    id,
    workspaceId: "ws_1",
    userId: "usr_1",
    activityType,
    streamId,
    messageId: `msg_${id}`,
    actorId: "usr_2",
    actorType: "user",
    context: {},
    readAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    isSelf: false,
    emoji: null,
    ...extra,
  }
}

function makeState(overrides: Partial<UnreadCounterState> = {}): UnreadCounterState {
  const merged: UnreadCounterState = {
    unreadCounts: {},
    unreadActivities: [],
    activityCounts: {},
    mentionCounts: {},
    unreadActivityCount: 0,
    latestOrdinals: {},
    ...overrides,
  }
  // The count fields are a derived projection — keep them consistent with the
  // held rows so a hand-built state is never internally contradictory.
  return { ...merged, ...deriveActivityCounts(merged.unreadActivities) }
}

describe("applyStreamActivityOrdinal", () => {
  // Bootstrap seeded: 5 messages total, 1 unread → implied read position 4.
  const seeded = makeState({ unreadCounts: { s1: 1 }, latestOrdinals: { s1: 5 } })

  it("sets unread from the ordinal delta for others' messages", () => {
    const next = applyStreamActivityOrdinal(seeded, "s1", 6, { isOwnMessage: false, isViewing: false })
    expect(next.unreadCounts.s1).toBe(2)
    expect(next.latestOrdinals?.s1).toBe(6)
  })

  it("converges on duplicate apply", () => {
    const once = applyStreamActivityOrdinal(seeded, "s1", 6, { isOwnMessage: false, isViewing: false })
    const twice = applyStreamActivityOrdinal(once, "s1", 6, { isOwnMessage: false, isViewing: false })
    expect(twice).toEqual(once)
  })

  it("converges on out-of-order apply (sweep-rescued late sync ids)", () => {
    const inOrder = applyStreamActivityOrdinal(
      applyStreamActivityOrdinal(seeded, "s1", 6, { isOwnMessage: false, isViewing: false }),
      "s1",
      7,
      { isOwnMessage: false, isViewing: false }
    )
    const outOfOrder = applyStreamActivityOrdinal(
      applyStreamActivityOrdinal(seeded, "s1", 7, { isOwnMessage: false, isViewing: false }),
      "s1",
      6,
      { isOwnMessage: false, isViewing: false }
    )
    expect(outOfOrder).toEqual(inOrder)
    expect(outOfOrder.unreadCounts.s1).toBe(3)
  })

  it("advances the read position to the message for own sends (server auto-advance mirror)", () => {
    const next = applyStreamActivityOrdinal(seeded, "s1", 6, { isOwnMessage: true, isViewing: false })
    expect(next.unreadCounts.s1).toBe(0)
    expect(next.latestOrdinals?.s1).toBe(6)
  })

  it("keeps newer messages unread when an own send applies out of order", () => {
    const other = applyStreamActivityOrdinal(seeded, "s1", 7, { isOwnMessage: false, isViewing: false })
    const own = applyStreamActivityOrdinal(other, "s1", 6, { isOwnMessage: true, isViewing: false })
    expect(own.unreadCounts.s1).toBe(1)
    expect(own.latestOrdinals?.s1).toBe(7)
  })

  it("pins the read position to latest while viewing", () => {
    const next = applyStreamActivityOrdinal(seeded, "s1", 6, { isOwnMessage: false, isViewing: true })
    expect(next.unreadCounts.s1).toBe(0)
  })

  it("seeds a baseline as the legacy increment when none exists", () => {
    const noBaseline = makeState({ unreadCounts: { s1: 2 }, latestOrdinals: undefined })
    const next = applyStreamActivityOrdinal(noBaseline, "s1", 9, { isOwnMessage: false, isViewing: false })
    expect(next.unreadCounts.s1).toBe(3)
    expect(next.latestOrdinals?.s1).toBe(9)
    const again = applyStreamActivityOrdinal(next, "s1", 9, { isOwnMessage: false, isViewing: false })
    expect(again.unreadCounts.s1).toBe(3)
  })

  it("seeds a zero-unread baseline for own sends without a baseline", () => {
    const noBaseline = makeState({ unreadCounts: { s1: 2 }, latestOrdinals: undefined })
    const next = applyStreamActivityOrdinal(noBaseline, "s1", 9, { isOwnMessage: true, isViewing: false })
    expect(next.unreadCounts.s1).toBe(0)
  })
})

describe("applyStreamReadOrdinal", () => {
  // s1 has 2 unread mentions, s2 has 1 unread message; 3 unread messages on s1.
  const seeded = makeState({
    unreadCounts: { s1: 3 },
    unreadActivities: [act("a1", "s1", "mention"), act("a2", "s1", "mention"), act("a3", "s2")],
    latestOrdinals: { s1: 8 },
  })

  it("leaves messages past the read position unread", () => {
    const next = applyStreamReadOrdinal(seeded, "s1", 6)
    expect(next.unreadCounts.s1).toBe(2)
  })

  it("drops the stream's activity rows on read (coupling) and rederives the total", () => {
    const next = applyStreamReadOrdinal(seeded, "s1", 8)
    expect(next.unreadCounts.s1).toBe(0)
    expect(next.unreadActivities.map((a) => a.streamId)).toEqual(["s2"])
    expect(next.activityCounts.s1 ?? 0).toBe(0)
    expect(next.mentionCounts.s1 ?? 0).toBe(0)
    expect(next.activityCounts.s2).toBe(1)
    expect(next.unreadActivityCount).toBe(1) // s2's row survives
  })

  it("never regresses the read position on a stale read event", () => {
    const read = applyStreamReadOrdinal(seeded, "s1", 8)
    const stale = applyStreamReadOrdinal(read, "s1", 5)
    expect(stale.unreadCounts.s1).toBe(0)
  })

  it("treats a read position ahead of the known latest as a lower bound on latest", () => {
    const next = applyStreamReadOrdinal(seeded, "s1", 12)
    expect(next.latestOrdinals?.s1).toBe(12)
    expect(next.unreadCounts.s1).toBe(0)
  })

  it("zeroes unread when no baseline exists (legacy-equivalent)", () => {
    const noBaseline = makeState({ unreadCounts: { s1: 4 }, latestOrdinals: undefined })
    const next = applyStreamReadOrdinal(noBaseline, "s1", 7)
    expect(next.unreadCounts.s1).toBe(0)
    expect(next.latestOrdinals?.s1).toBe(7)
  })

  it("a later activity re-adds after a read dropped the stream's rows", () => {
    let state = makeState({ unreadActivities: [act("a1", "s1", "mention")] })
    state = applyStreamReadOrdinal(state, "s1", 5)
    expect(state.unreadActivityCount).toBe(0)
    state = upsertActivity(state, act("a2", "s1"))
    expect(state.activityCounts.s1).toBe(1)
    expect(state.unreadActivityCount).toBe(1)
  })
})

describe("applyStreamReadSet", () => {
  const seeded = makeState({
    unreadCounts: { s1: 0 },
    unreadActivities: [act("a1", "s2")],
    latestOrdinals: { s1: 8 },
  })

  it("moves the pointer BACKWARD and raises unread (the mark-unread case)", () => {
    const next = applyStreamReadSet(seeded, "s1", 5)
    expect(next.unreadCounts.s1).toBe(3)
  })

  it("does NOT max-merge — a lower ordinal wins over the prior read", () => {
    const read = applyStreamReadOrdinal(seeded, "s1", 8)
    const unread = applyStreamReadSet(read, "s1", 4)
    expect(unread.unreadCounts.s1).toBe(4)
  })

  it("leaves held activity untouched (re-unread restoration is a follow-up)", () => {
    const next = applyStreamReadSet(seeded, "s1", 2)
    expect(next.unreadActivities).toBe(seeded.unreadActivities)
    expect(next.activityCounts.s2).toBe(1)
    expect(next.unreadActivityCount).toBe(1)
  })

  it("clamps unread at zero when the pointer is at or past latest", () => {
    const next = applyStreamReadSet(seeded, "s1", 8)
    expect(next.unreadCounts.s1).toBe(0)
  })
})

describe("applyStreamsReadAllOrdinals", () => {
  it("applies each stream's read position and drops its activity (coupling)", () => {
    const state = makeState({
      unreadCounts: { s1: 2, s2: 5 },
      unreadActivities: [act("a1", "s1"), act("a2", "s2"), act("a3", "s2", "mention")],
      latestOrdinals: { s1: 4, s2: 10 },
    })
    const next = applyStreamsReadAllOrdinals(state, [
      { streamId: "s1", lastReadOrdinal: 4 },
      { streamId: "s2", lastReadOrdinal: 10 },
    ])
    expect(next.unreadCounts).toEqual({ s1: 0, s2: 0 })
    expect(next.unreadActivities).toEqual([])
    expect(next.activityCounts).toEqual({})
    expect(next.unreadActivityCount).toBe(0)
  })
})

describe("deriveActivityCounts", () => {
  it("groups by stream and filters mentions", () => {
    const d = deriveActivityCounts([act("a1", "s1", "mention"), act("a2", "s1"), act("a3", "s2", "mention")])
    expect(d.activityCounts).toEqual({ s1: 2, s2: 1 })
    expect(d.mentionCounts).toEqual({ s1: 1, s2: 1 })
    expect(d.unreadActivityCount).toBe(3)
  })

  it("counts stream-less rows in the total but not per-stream", () => {
    const d = deriveActivityCounts([act("a1", "s1"), act("a2", null, "saved_reminder")])
    expect(d.activityCounts).toEqual({ s1: 1 })
    expect(d.unreadActivityCount).toBe(2)
  })
})

describe("upsertActivity", () => {
  it("adds a row and derives its counts", () => {
    const next = upsertActivity(makeState(), act("a1", "s1", "mention"))
    expect(next.unreadActivities).toHaveLength(1)
    expect(next.activityCounts.s1).toBe(1)
    expect(next.mentionCounts.s1).toBe(1)
    expect(next.unreadActivityCount).toBe(1)
  })

  it("is idempotent by id — a replayed event never duplicates", () => {
    const once = upsertActivity(makeState(), act("a1", "s1"))
    const twice = upsertActivity(once, act("a1", "s1"))
    expect(twice.unreadActivities).toHaveLength(1)
    expect(twice.unreadActivityCount).toBe(1)
  })

  it("skips self rows (they do not count as unread)", () => {
    const next = upsertActivity(makeState(), act("a1", "s1", "message", { isSelf: true }))
    expect(next.unreadActivities).toHaveLength(0)
    expect(next.unreadActivityCount).toBe(0)
  })
})

describe("dropActivitiesForStream", () => {
  it("drops only that stream's rows", () => {
    const state = makeState({ unreadActivities: [act("a1", "s1"), act("a2", "s2")] })
    const next = dropActivitiesForStream(state, "s1")
    expect(next.unreadActivities.map((a) => a.streamId)).toEqual(["s2"])
    expect(next.activityCounts).toEqual({ s2: 1 })
    expect(next.unreadActivityCount).toBe(1)
  })

  it("is a no-op (same reference) when the stream has no rows", () => {
    const state = makeState({ unreadActivities: [act("a1", "s2")] })
    expect(dropActivitiesForStream(state, "s1")).toBe(state)
  })
})

describe("dropReactionActivity", () => {
  const state = makeState({
    unreadActivities: [
      act("a1", "s1", "reaction", { messageId: "m1", actorId: "u2", emoji: "👍" }),
      act("a2", "s1", "reaction", { messageId: "m1", actorId: "u2", emoji: "🎉" }),
    ],
  })

  it("drops only the row matching message + actor + emoji", () => {
    const next = dropReactionActivity(state, { messageId: "m1", actorId: "u2", emoji: "👍" })
    expect(next.unreadActivities.map((a) => a.emoji)).toEqual(["🎉"])
    expect(next.unreadActivityCount).toBe(1)
  })

  it("is a no-op when nothing matches", () => {
    expect(dropReactionActivity(state, { messageId: "m1", actorId: "u2", emoji: "❤️" })).toBe(state)
  })
})

describe("rehomeActivities", () => {
  it("moves rows from the source stream to the destination", () => {
    const state = makeState({ unreadActivities: [act("a1", "s1"), act("a2", "s3")] })
    const next = rehomeActivities(state, "s1", "s2")
    expect(next.activityCounts).toEqual({ s2: 1, s3: 1 })
    expect(next.unreadActivities.find((a) => a.id === "a1")?.streamId).toBe("s2")
  })

  it("is a no-op when the source has no rows", () => {
    const state = makeState({ unreadActivities: [act("a1", "s3")] })
    expect(rehomeActivities(state, "s1", "s2")).toBe(state)
  })
})

describe("clearActivities", () => {
  it("empties the held set and its derived counts", () => {
    const state = makeState({ unreadActivities: [act("a1", "s1"), act("a2", "s2")] })
    const next = clearActivities(state)
    expect(next.unreadActivities).toEqual([])
    expect(next.activityCounts).toEqual({})
    expect(next.unreadActivityCount).toBe(0)
  })
})
