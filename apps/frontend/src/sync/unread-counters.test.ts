import { describe, it, expect } from "vitest"
import {
  applyStreamActivityOrdinal,
  applyStreamReadOrdinal,
  applyStreamsReadAllOrdinals,
  applyActivityCounts,
  isLegacyUnreadCounterEntry,
  type UnreadCounterState,
} from "./unread-counters"

function makeState(overrides: Partial<UnreadCounterState> = {}): UnreadCounterState {
  return {
    unreadCounts: {},
    mentionCounts: {},
    activityCounts: {},
    unreadActivityCount: 0,
    latestOrdinals: {},
    ...overrides,
  }
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
    // Someone else's message 7 already applied, then own message 6 arrives late:
    // read advances to 6, message 7 stays unread.
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
    // The seeded baseline makes the SAME event idempotent from here on.
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
  const seeded = makeState({
    unreadCounts: { s1: 3 },
    mentionCounts: { s1: 2 },
    activityCounts: { s1: 2, s2: 1 },
    unreadActivityCount: 3,
    latestOrdinals: { s1: 8 },
  })

  it("leaves messages past the read position unread", () => {
    // Read up to ordinal 6 of 8: two messages remain unread.
    const next = applyStreamReadOrdinal(seeded, "s1", 6)
    expect(next.unreadCounts.s1).toBe(2)
  })

  it("zeroes mention/activity counts and rederives the workspace total", () => {
    const next = applyStreamReadOrdinal(seeded, "s1", 8)
    expect(next.unreadCounts.s1).toBe(0)
    expect(next.mentionCounts.s1).toBe(0)
    expect(next.activityCounts.s1).toBe(0)
    expect(next.unreadActivityCount).toBe(1) // s2's count survives
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

  it("lands in log order between two absolute activity applies", () => {
    // activity counts 2 → read zeroes → activity counts 1: final state is the
    // last entry's absolute value, exactly as the log orders them.
    let state = makeState()
    state = applyActivityCounts(state, "s1", { mentionCount: 1, activityCount: 2 })
    state = applyStreamReadOrdinal(state, "s1", 5)
    expect(state.activityCounts.s1).toBe(0)
    state = applyActivityCounts(state, "s1", { mentionCount: 0, activityCount: 1 })
    expect(state.mentionCounts.s1).toBe(0)
    expect(state.activityCounts.s1).toBe(1)
    expect(state.unreadActivityCount).toBe(1)
  })
})

describe("applyStreamsReadAllOrdinals", () => {
  it("applies each stream's absolute read position", () => {
    const state = makeState({
      unreadCounts: { s1: 2, s2: 5 },
      activityCounts: { s1: 1, s2: 2 },
      unreadActivityCount: 3,
      latestOrdinals: { s1: 4, s2: 10 },
    })
    const next = applyStreamsReadAllOrdinals(state, [
      { streamId: "s1", lastReadOrdinal: 4 },
      { streamId: "s2", lastReadOrdinal: 10 },
    ])
    expect(next.unreadCounts).toEqual({ s1: 0, s2: 0 })
    expect(next.activityCounts).toEqual({ s1: 0, s2: 0 })
    expect(next.unreadActivityCount).toBe(0)
  })
})

describe("applyActivityCounts", () => {
  it("sets absolute counts and derives the total as Σ activityCounts", () => {
    const state = makeState({ activityCounts: { s1: 1, s2: 4 }, unreadActivityCount: 5 })
    const next = applyActivityCounts(state, "s1", { mentionCount: 2, activityCount: 3 })
    expect(next.mentionCounts.s1).toBe(2)
    expect(next.activityCounts).toEqual({ s1: 3, s2: 4 })
    expect(next.unreadActivityCount).toBe(7)
  })

  it("converges on duplicate apply and allows decreases (LWW)", () => {
    const state = makeState({ activityCounts: { s1: 5 }, unreadActivityCount: 5 })
    const once = applyActivityCounts(state, "s1", { mentionCount: 0, activityCount: 2 })
    expect(applyActivityCounts(once, "s1", { mentionCount: 0, activityCount: 2 })).toEqual(once)
    expect(once.unreadActivityCount).toBe(2)
  })
})

describe("isLegacyUnreadCounterEntry", () => {
  it("detects missing absolute fields per counter event type", () => {
    expect(isLegacyUnreadCounterEntry("stream:activity", { streamId: "s1" })).toBe(true)
    expect(isLegacyUnreadCounterEntry("stream:activity", { streamId: "s1", messageOrdinal: 3 })).toBe(false)
    expect(isLegacyUnreadCounterEntry("stream:read", { streamId: "s1" })).toBe(true)
    expect(isLegacyUnreadCounterEntry("stream:read", { streamId: "s1", lastReadOrdinal: 0 })).toBe(false)
    expect(isLegacyUnreadCounterEntry("stream:read_all", { streamIds: [] })).toBe(true)
    expect(isLegacyUnreadCounterEntry("stream:read_all", { streamIds: [], reads: [] })).toBe(false)
    expect(isLegacyUnreadCounterEntry("activity:created", { activity: {} })).toBe(true)
    expect(isLegacyUnreadCounterEntry("activity:created", { counts: { mentionCount: 1, activityCount: 2 } })).toBe(
      false
    )
  })

  it("never marks non-counter events legacy", () => {
    expect(isLegacyUnreadCounterEntry("message:created", {})).toBe(false)
    expect(isLegacyUnreadCounterEntry("workspace_user:added", undefined)).toBe(false)
  })
})
