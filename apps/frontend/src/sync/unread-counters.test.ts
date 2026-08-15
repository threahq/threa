import { describe, it, expect } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { db } from "@/db"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { LiveCommitBatch } from "./catch-up-batch"
import type { Activity } from "@threa/types"
import {
  applyStreamActivityOrdinal,
  applyStreamReadOrdinal,
  applyStreamReadSet,
  applyStreamReadMessages,
  applyStreamsReadAllOrdinals,
  applyMovedSourceOrdinal,
  deriveActivityCounts,
  upsertActivity,
  dropActivitiesById,
  dropActivitiesForStream,
  dropMessageActivities,
  dropReactionActivity,
  reconcileActivities,
  rehomeActivities,
  clearActivities,
  diffCounterStreams,
  mergeBootstrapUnreadFields,
  pruneCounterTouches,
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
    const next = applyStreamActivityOrdinal(seeded, "s1", 6, { isOwnMessage: false })
    expect(next.unreadCounts.s1).toBe(2)
    expect(next.latestOrdinals?.s1).toBe(6)
  })

  it("converges on duplicate apply", () => {
    const once = applyStreamActivityOrdinal(seeded, "s1", 6, { isOwnMessage: false })
    const twice = applyStreamActivityOrdinal(once, "s1", 6, { isOwnMessage: false })
    expect(twice).toEqual(once)
  })

  it("converges on out-of-order apply (sweep-rescued late sync ids)", () => {
    const inOrder = applyStreamActivityOrdinal(
      applyStreamActivityOrdinal(seeded, "s1", 6, { isOwnMessage: false }),
      "s1",
      7,
      { isOwnMessage: false }
    )
    const outOfOrder = applyStreamActivityOrdinal(
      applyStreamActivityOrdinal(seeded, "s1", 7, { isOwnMessage: false }),
      "s1",
      6,
      { isOwnMessage: false }
    )
    expect(outOfOrder).toEqual(inOrder)
    expect(outOfOrder.unreadCounts.s1).toBe(3)
  })

  it("advances the read position to the message for own sends (server auto-advance mirror)", () => {
    const next = applyStreamActivityOrdinal(seeded, "s1", 6, { isOwnMessage: true })
    expect(next.unreadCounts.s1).toBe(0)
    expect(next.latestOrdinals?.s1).toBe(6)
  })

  it("keeps newer messages unread when an own send applies out of order", () => {
    const other = applyStreamActivityOrdinal(seeded, "s1", 7, { isOwnMessage: false })
    const own = applyStreamActivityOrdinal(other, "s1", 6, { isOwnMessage: true })
    expect(own.unreadCounts.s1).toBe(1)
    expect(own.latestOrdinals?.s1).toBe(7)
  })

  it("seeds a baseline as the legacy increment when none exists", () => {
    const noBaseline = makeState({ unreadCounts: { s1: 2 }, latestOrdinals: undefined })
    const next = applyStreamActivityOrdinal(noBaseline, "s1", 9, { isOwnMessage: false })
    expect(next.unreadCounts.s1).toBe(3)
    expect(next.latestOrdinals?.s1).toBe(9)
    const again = applyStreamActivityOrdinal(next, "s1", 9, { isOwnMessage: false })
    expect(again.unreadCounts.s1).toBe(3)
  })

  it("seeds a zero-unread baseline for own sends without a baseline", () => {
    const noBaseline = makeState({ unreadCounts: { s1: 2 }, latestOrdinals: undefined })
    const next = applyStreamActivityOrdinal(noBaseline, "s1", 9, { isOwnMessage: true })
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

  it("does not drop held activity on a strictly stale read (below the current position)", () => {
    // Caught up at ordinal 8; a reaction then arrives. A stale read-to-3 (e.g.
    // out-of-order delivery) must not wipe activity that arrived after the real read.
    let state = makeState({ unreadCounts: { s1: 0 }, latestOrdinals: { s1: 8 } })
    state = upsertActivity(state, act("a1", "s1", "mention"))
    expect(state.unreadActivityCount).toBe(1)
    expect(applyStreamReadOrdinal(state, "s1", 3).unreadActivityCount).toBe(1)
    // A read at the current position (the D5 caught-up heal) still clears it.
    expect(applyStreamReadOrdinal(state, "s1", 8).unreadActivityCount).toBe(0)
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

describe("dropActivitiesById", () => {
  it("drops only the listed ids across streams and re-derives counts", () => {
    const state = makeState({
      unreadActivities: [act("a1", "s1"), act("a2", "s1"), act("a3", "s2"), act("a4", null)],
    })
    const next = dropActivitiesById(state, ["a1", "a3", "a_unknown"])
    expect(next.unreadActivities.map((a) => a.id)).toEqual(["a2", "a4"])
    expect(next.activityCounts).toEqual({ s1: 1 })
    expect(next.unreadActivityCount).toBe(2)
  })

  it("is idempotent — dropping already-absent ids is a same-reference no-op", () => {
    const state = makeState({ unreadActivities: [act("a2", "s1")] })
    expect(dropActivitiesById(state, ["a1"])).toBe(state)
    expect(dropActivitiesById(state, [])).toBe(state)
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
  it("re-homes only the moved messages' rows, leaving the rest in the source stream", () => {
    const state = makeState({ unreadActivities: [act("a1", "s1"), act("a2", "s1"), act("a3", "s3")] })
    // Only a1's message moved; a2 stays in s1.
    const next = rehomeActivities(state, "s1", "s2", ["msg_a1"])
    expect(next.activityCounts).toEqual({ s1: 1, s2: 1, s3: 1 })
    expect(next.unreadActivities.find((a) => a.id === "a1")?.streamId).toBe("s2")
    expect(next.unreadActivities.find((a) => a.id === "a2")?.streamId).toBe("s1")
  })

  it("is a no-op when no moved message has a held row", () => {
    const state = makeState({ unreadActivities: [act("a1", "s1")] })
    expect(rehomeActivities(state, "s1", "s2", ["msg_other"])).toBe(state)
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

describe("sparse read overlay invariant", () => {
  describe("applyStreamActivityOrdinal (overlay-aware)", () => {
    it("subtracts the overlay when reconstructing the read position", () => {
      // latest 5, unread 1, overlay of 2 above the watermark → watermark = 5-1-2 = 2.
      const seeded = makeState({
        unreadCounts: { s1: 1 },
        latestOrdinals: { s1: 5 },
        readMessageIds: { s1: ["m8", "m9"] },
      })
      // A new other-message arrives: unread rises by one, overlay unchanged.
      const next = applyStreamActivityOrdinal(seeded, "s1", 6, { isOwnMessage: false })
      expect(next.unreadCounts.s1).toBe(2)
      expect(next.latestOrdinals?.s1).toBe(6)
      expect(next.readMessageIds?.s1).toEqual(["m8", "m9"])
    })

    it("converges on duplicate apply with an overlay present", () => {
      const seeded = makeState({
        unreadCounts: { s1: 1 },
        latestOrdinals: { s1: 5 },
        readMessageIds: { s1: ["m9"] },
      })
      const once = applyStreamActivityOrdinal(seeded, "s1", 6, { isOwnMessage: false })
      const twice = applyStreamActivityOrdinal(once, "s1", 6, { isOwnMessage: false })
      expect(twice).toEqual(once)
    })
  })

  describe("applyStreamReadMessages", () => {
    it("SETs the overlay, max-merges the watermark, and recomputes unread", () => {
      // latest 10, watermark at 4 (unread 6), no overlay yet.
      const seeded = makeState({ unreadCounts: { s1: 6 }, latestOrdinals: { s1: 10 } })
      // A conversation read covers 3 messages above the watermark; watermark unmoved.
      const next = applyStreamReadMessages(seeded, "s1", { readMessageIds: ["m5", "m7", "m9"], lastReadOrdinal: 4 })
      expect(next.readMessageIds?.s1).toEqual(["m5", "m7", "m9"])
      expect(next.unreadCounts.s1).toBe(3) // 10 - 4 - 3
      expect(next.latestOrdinals?.s1).toBe(10)
    })

    it("is idempotent on duplicate apply (absolute snapshot)", () => {
      const seeded = makeState({ unreadCounts: { s1: 6 }, latestOrdinals: { s1: 10 } })
      const once = applyStreamReadMessages(seeded, "s1", { readMessageIds: ["m5", "m7"], lastReadOrdinal: 4 })
      const twice = applyStreamReadMessages(once, "s1", { readMessageIds: ["m5", "m7"], lastReadOrdinal: 4 })
      expect(twice.unreadCounts.s1).toBe(once.unreadCounts.s1)
      expect(twice.readMessageIds?.s1).toEqual(["m5", "m7"])
    })

    it("converges under out-of-order snapshots (later snapshot wins the set)", () => {
      const seeded = makeState({ unreadCounts: { s1: 6 }, latestOrdinals: { s1: 10 } })
      // Snapshot B (watermark 4, overlay 2) then stale snapshot A (watermark 2, overlay 1):
      // the overlay SETs to A's set but the watermark max-merges, so it stays at 4.
      const b = applyStreamReadMessages(seeded, "s1", { readMessageIds: ["m6", "m8"], lastReadOrdinal: 4 })
      const then = applyStreamReadMessages(b, "s1", { readMessageIds: ["m6"], lastReadOrdinal: 2 })
      expect(then.latestOrdinals?.s1).toBe(10)
      expect(then.readMessageIds?.s1).toEqual(["m6"])
      expect(then.unreadCounts.s1).toBe(5) // 10 - 4 - 1 (watermark held at 4)
    })

    it("seeds from no baseline (overlay + watermark, unread derived)", () => {
      const noBaseline = makeState({ unreadCounts: { s1: 3 }, latestOrdinals: undefined })
      const next = applyStreamReadMessages(noBaseline, "s1", { readMessageIds: ["m5"], lastReadOrdinal: 4 })
      expect(next.latestOrdinals?.s1).toBe(4)
      expect(next.readMessageIds?.s1).toEqual(["m5"])
      expect(next.unreadCounts.s1).toBe(0)
    })

    it("drops the overlay key when the snapshot is empty", () => {
      const seeded = makeState({
        unreadCounts: { s1: 3 },
        latestOrdinals: { s1: 10 },
        readMessageIds: { s1: ["m5", "m7"] },
      })
      const next = applyStreamReadMessages(seeded, "s1", { readMessageIds: [], lastReadOrdinal: 5 })
      expect(next.readMessageIds?.s1).toBeUndefined()
      expect(next.unreadCounts.s1).toBe(5) // 10 - 5 - 0
    })
  })

  describe("applyStreamReadOrdinal readMessageIds param", () => {
    it("SETs the overlay when carried and folds it into unread", () => {
      const seeded = makeState({ unreadCounts: { s1: 6 }, latestOrdinals: { s1: 10 } })
      const next = applyStreamReadOrdinal(seeded, "s1", 5, ["m8"])
      expect(next.readMessageIds?.s1).toEqual(["m8"])
      expect(next.unreadCounts.s1).toBe(4) // 10 - 5 - 1
    })

    it("leaves the overlay untouched when the field is absent (rollout compat)", () => {
      const seeded = makeState({
        unreadCounts: { s1: 4 },
        latestOrdinals: { s1: 10 },
        readMessageIds: { s1: ["m8", "m9"] },
      })
      const next = applyStreamReadOrdinal(seeded, "s1", 6)
      expect(next.readMessageIds?.s1).toEqual(["m8", "m9"])
      expect(next.unreadCounts.s1).toBe(2) // 10 - 6 - 2
    })

    it("preserves the D2 activity-drop coupling overlay-aware", () => {
      // watermark = latest - unread - overlay = 10 - 4 - 2 = 4. A read AT the
      // reconstructed watermark still clears held activity (D5 heal); a strictly
      // stale read below it does not.
      const seeded = makeState({
        unreadCounts: { s1: 4 },
        latestOrdinals: { s1: 10 },
        readMessageIds: { s1: ["m8", "m9"] },
        unreadActivities: [act("a1", "s1", "mention")],
      })
      expect(applyStreamReadOrdinal(seeded, "s1", 4, ["m8", "m9"]).unreadActivityCount).toBe(0)
      expect(applyStreamReadOrdinal(seeded, "s1", 3, ["m8", "m9"]).unreadActivityCount).toBe(1)
    })
  })

  describe("applyStreamReadSet readMessageIds param", () => {
    it("SETs the overlay (including empty) alongside the backward pointer", () => {
      const seeded = makeState({
        unreadCounts: { s1: 0 },
        latestOrdinals: { s1: 10 },
        readMessageIds: { s1: ["m8"] },
      })
      // Mark-unread regresses the watermark to 5 and deletes overlay ids above it.
      const next = applyStreamReadSet(seeded, "s1", 5, [])
      expect(next.readMessageIds?.s1).toBeUndefined()
      expect(next.unreadCounts.s1).toBe(5) // 10 - 5 - 0
    })

    it("leaves the overlay untouched when the field is absent", () => {
      const seeded = makeState({
        unreadCounts: { s1: 0 },
        latestOrdinals: { s1: 10 },
        readMessageIds: { s1: ["m8"] },
      })
      const next = applyStreamReadSet(seeded, "s1", 5)
      expect(next.readMessageIds?.s1).toEqual(["m8"])
      expect(next.unreadCounts.s1).toBe(4) // 10 - 5 - 1
    })
  })

  describe("applyStreamsReadAllOrdinals clears overlays", () => {
    it("wipes each read stream's overlay set", () => {
      const state = makeState({
        unreadCounts: { s1: 2, s2: 5 },
        latestOrdinals: { s1: 4, s2: 10 },
        readMessageIds: { s1: ["m3"], s2: ["m9", "m10"] },
      })
      const next = applyStreamsReadAllOrdinals(state, [
        { streamId: "s1", lastReadOrdinal: 4 },
        { streamId: "s2", lastReadOrdinal: 10 },
      ])
      expect(next.readMessageIds).toEqual({})
      expect(next.unreadCounts).toEqual({ s1: 0, s2: 0 })
    })
  })
})

describe("applyMovedSourceOrdinal", () => {
  it("SETs the source latest ordinal downward and keeps the read position stable", () => {
    // latest 5, unread 2 → watermark 3. Move drops the source count to 4.
    const state = makeState({ unreadCounts: { s1: 2 }, latestOrdinals: { s1: 5 } })
    const next = applyMovedSourceOrdinal(state, "s1", 4)
    expect(next.latestOrdinals?.s1).toBe(4)
    expect(next.unreadCounts.s1).toBe(1) // 4 - 3
  })

  it("clamps unread at zero when the drop lands at or below the read position", () => {
    const state = makeState({ unreadCounts: { s1: 2 }, latestOrdinals: { s1: 5 } })
    const next = applyMovedSourceOrdinal(state, "s1", 3)
    expect(next.latestOrdinals?.s1).toBe(3)
    expect(next.unreadCounts.s1).toBe(0) // 3 - 3, clamped
  })

  it("heals the phantom-unread move sequence (activity 2 → move to 1 → read 1 → 0)", () => {
    let state = makeState({ unreadCounts: { s1: 1 }, latestOrdinals: { s1: 1 } })
    state = applyStreamActivityOrdinal(state, "s1", 2, { isOwnMessage: false })
    expect(state.unreadCounts.s1).toBe(2)
    state = applyMovedSourceOrdinal(state, "s1", 1)
    expect(state.latestOrdinals?.s1).toBe(1)
    state = applyStreamReadOrdinal(state, "s1", 1)
    expect(state.unreadCounts.s1).toBe(0)
  })

  it("drops moved ids from the source overlay so a stale entry can't hide genuine unread", () => {
    // Messages 1..5, watermark at 1, m2 overlay-read → unread 3 ({m3,m4,m5}).
    // m2 (overlay-read) + m3 (unread) move to a thread → source count 3.
    // True post-move state: watermark 1, overlay empty, unread 2 ({m4,m5}).
    // With a stale m2 entry the math yields 1 — hiding a genuinely unread row.
    const state = makeState({
      unreadCounts: { s1: 3 },
      latestOrdinals: { s1: 5 },
      readMessageIds: { s1: ["m2"] },
    })
    const next = applyMovedSourceOrdinal(state, "s1", 3, ["m2", "m3"])
    expect(next.readMessageIds).toEqual({})
    expect(next.unreadCounts.s1).toBe(2)
  })

  it("leaves the overlay untouched when no moved id is in it", () => {
    const state = makeState({
      unreadCounts: { s1: 2 },
      latestOrdinals: { s1: 5 },
      readMessageIds: { s1: ["m4"] },
    })
    const next = applyMovedSourceOrdinal(state, "s1", 4, ["m2"])
    expect(next.readMessageIds).toEqual({ s1: ["m4"] })
    expect(next.unreadCounts.s1).toBe(1)
  })

  it("without the source-ordinal fix the read cannot clear the phantom (regression guard)", () => {
    let state = makeState({ unreadCounts: { s1: 1 }, latestOrdinals: { s1: 1 } })
    state = applyStreamActivityOrdinal(state, "s1", 2, { isOwnMessage: false })
    // Skip applyMovedSourceOrdinal: latest stays inflated at 2 (max-merge only).
    const read = applyStreamReadOrdinal(state, "s1", 1)
    expect(read.unreadCounts.s1).toBe(1) // stuck — the exact bug the fix removes
  })
})

describe("dropMessageActivities", () => {
  const state = makeState({
    unreadActivities: [
      act("a1", "s1", "reaction", { messageId: "m1" }),
      act("a2", "s1", "mention", { messageId: "m2" }),
    ],
  })

  it("drops every held row for the deleted message", () => {
    const next = dropMessageActivities(state, "m1")
    expect(next.unreadActivities.map((a) => a.id)).toEqual(["a2"])
    expect(next.unreadActivityCount).toBe(1)
  })

  it("is a no-op (same reference) when no row matches", () => {
    expect(dropMessageActivities(state, "m_absent")).toBe(state)
  })
})

describe("reconcileActivities", () => {
  it("replaces the held set wholesale with the server rows", () => {
    const state = makeState({ unreadActivities: [act("a1", "s1"), act("a2", "s2")] })
    const next = reconcileActivities(state, [act("a2", "s2"), act("a3", "s3", "mention")])
    expect(next.unreadActivities.map((a) => a.id)).toEqual(["a2", "a3"])
    expect(next.activityCounts).toEqual({ s2: 1, s3: 1 })
    expect(next.mentionCounts).toEqual({ s3: 1 })
    expect(next.unreadActivityCount).toBe(2)
  })

  it("drops self rows from the server set", () => {
    const state = makeState()
    const next = reconcileActivities(state, [act("a1", "s1"), act("a2", "s1", "message", { isSelf: true })])
    expect(next.unreadActivities.map((a) => a.id)).toEqual(["a1"])
    expect(next.unreadActivityCount).toBe(1)
  })

  it("empties the held set when the server shows nothing unread", () => {
    const state = makeState({ unreadActivities: [act("a1", "s1")] })
    const next = reconcileActivities(state, [])
    expect(next.unreadActivities).toEqual([])
    expect(next.unreadActivityCount).toBe(0)
  })
})

describe("diffCounterStreams", () => {
  it("collects streams whose unread, ordinal, overlay, or held rows changed", () => {
    const prev = makeState({
      unreadCounts: { s1: 1, s2: 0, s5: 2 },
      latestOrdinals: { s1: 5, s2: 3, s5: 9 },
      readMessageIds: { s3: ["m1"] },
      unreadActivities: [act("a1", "s4")],
    })
    const next = makeState({
      unreadCounts: { s1: 2, s2: 0, s5: 2 },
      latestOrdinals: { s1: 6, s2: 3, s5: 9 },
      readMessageIds: { s3: ["m1", "m2"] },
      unreadActivities: [act("a1", "s4"), act("a2", "s6")],
    })
    expect(diffCounterStreams(prev, next)).toEqual(new Set(["s1", "s3", "s6"]))
  })

  it("returns empty for identical states", () => {
    const state = makeState({ unreadCounts: { s1: 1 }, unreadActivities: [act("a1", "s1")] })
    expect(diffCounterStreams(state, state)).toEqual(new Set())
  })
})

describe("mergeBootstrapUnreadFields", () => {
  const bootstrap = {
    unreadCounts: { s1: 4, s2: 2 },
    messageCounts: { s1: 10, s2: 8 },
    readMessageIds: { s2: ["m1"] },
    mutedStreamIds: ["s9"],
    unreadActivities: [act("a1", "s1"), act("a2", "s2")],
  } as unknown as import("@threa/types").WorkspaceBootstrap

  it("takes the server snapshot wholesale when nothing local was touched during the fetch", () => {
    const merged = mergeBootstrapUnreadFields(
      bootstrap,
      {
        // Drifted local zero from before the fetch — must lose to the server.
        unreadCounts: { s1: 0 },
        latestOrdinals: { s1: 10 },
        mutedStreamIds: [],
        counterTouchedAt: { s1: Date.now() - 60_000 },
      },
      Date.now() - 1000
    )
    expect(merged.unreadCounts).toEqual({ s1: 4, s2: 2 })
    expect(merged.latestOrdinals).toEqual({ s1: 10, s2: 8 })
    expect(merged.counterTouchedAt).toEqual({})
    expect(merged.unreadActivities.map((a) => a.id).sort()).toEqual(["a1", "a2"])
  })

  it("keeps the local triple (and held rows) only for streams touched during the fetch window", () => {
    const fetchStartedAt = Date.now() - 1000
    const touchedAt = fetchStartedAt + 500
    const merged = mergeBootstrapUnreadFields(
      bootstrap,
      {
        unreadCounts: { s1: 5, s2: 0 },
        latestOrdinals: { s1: 11, s2: 8 },
        readMessageIds: {},
        mutedStreamIds: [],
        unreadActivities: [act("a1", "s1"), act("a3", "s1")],
        counterTouchedAt: { s1: touchedAt, s2: fetchStartedAt - 500 },
      },
      fetchStartedAt
    )
    expect(merged.unreadCounts).toEqual({ s1: 5, s2: 2 })
    expect(merged.latestOrdinals).toEqual({ s1: 11, s2: 8 })
    expect(merged.readMessageIds).toEqual({ s2: ["m1"] })
    expect(merged.unreadActivities.map((a) => a.id).sort()).toEqual(["a1", "a2", "a3"])
    expect(merged.activityCounts).toEqual({ s1: 2, s2: 1 })
    expect(merged.counterTouchedAt).toEqual({ s1: touchedAt })
  })

  it("keeps local mute membership for mute-touched streams only", () => {
    const fetchStartedAt = Date.now() - 1000
    const merged = mergeBootstrapUnreadFields(
      bootstrap,
      {
        unreadCounts: {},
        mutedStreamIds: ["s1"],
        mutedTouchedAt: { s1: fetchStartedAt + 100 },
      },
      fetchStartedAt
    )
    expect(merged.mutedStreamIds.sort()).toEqual(["s1", "s9"])
  })

  it("a mute-only touch does not freeze that stream's counters (and vice versa)", () => {
    const fetchStartedAt = Date.now() - 1000
    const merged = mergeBootstrapUnreadFields(
      bootstrap,
      {
        // s1: drifted local zero + a mute toggle during the fetch. The mute
        // must survive; the counters must still heal from the server.
        unreadCounts: { s1: 0 },
        latestOrdinals: { s1: 10 },
        mutedStreamIds: ["s1"],
        mutedTouchedAt: { s1: fetchStartedAt + 100 },
      },
      fetchStartedAt
    )
    expect(merged.unreadCounts).toEqual({ s1: 4, s2: 2 })
    expect(merged.mutedStreamIds.sort()).toEqual(["s1", "s9"])
    // Counter-touched stream keeps counters but takes server mute membership.
    const counterOnly = mergeBootstrapUnreadFields(
      bootstrap,
      {
        unreadCounts: { s9: 1 },
        latestOrdinals: { s9: 3 },
        mutedStreamIds: [],
        counterTouchedAt: { s9: fetchStartedAt + 100 },
      },
      fetchStartedAt
    )
    expect(counterOnly.unreadCounts.s9).toBe(1)
    expect(counterOnly.mutedStreamIds).toEqual(["s9"])
  })

  it("without a local row or fetch timestamp the server snapshot wins", () => {
    const merged = mergeBootstrapUnreadFields(bootstrap, undefined, undefined)
    expect(merged.unreadCounts).toEqual({ s1: 4, s2: 2 })
    expect(merged.mutedStreamIds).toEqual(["s9"])
  })
})

describe("pruneCounterTouches", () => {
  it("keeps stamps at or after the cutoff and drops the rest", () => {
    expect(pruneCounterTouches({ s1: 100, s2: 200, s3: 300 }, 200)).toEqual({ s2: 200, s3: 300 })
    expect(pruneCounterTouches(undefined, 200)).toEqual({})
    expect(pruneCounterTouches({ s1: 100 }, undefined)).toEqual({})
  })
})

describe("coalesced live commit", () => {
  const seeded = makeState({ unreadCounts: { s1: 1 }, latestOrdinals: { s1: 5 } })

  it("out-of-order ordinals converge under coalescing", async () => {
    const workspaceId = "ws_fold"
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), {
      streams: [],
      streamMemberships: [],
      ...seeded,
      // The bootstrap's ordinal field is `messageCounts` (toCounterState).
      messageCounts: seeded.latestOrdinals,
    })
    await db.unreadState.put({ id: workspaceId, workspaceId, ...seeded, mutedStreamIds: [] } as never)

    const batch = new LiveCommitBatch(queryClient, workspaceId)
    // Two activities for one stream, delivered in the wrong order in one task.
    batch.applyCounter((state) => applyStreamActivityOrdinal(state, "s1", 7, { isOwnMessage: false }))
    batch.applyCounter((state) => applyStreamActivityOrdinal(state, "s1", 6, { isOwnMessage: false }))
    await batch.flush()

    const perEvent = applyStreamActivityOrdinal(
      applyStreamActivityOrdinal(seeded, "s1", 7, { isOwnMessage: false }),
      "s1",
      6,
      { isOwnMessage: false }
    )
    const folded = queryClient.getQueryData<{
      unreadCounts: Record<string, number>
      messageCounts: Record<string, number>
    }>(workspaceKeys.bootstrap(workspaceId))
    const persisted = await db.unreadState.get(workspaceId)

    expect({
      cache: { unreadCounts: folded?.unreadCounts, latestOrdinals: folded?.messageCounts },
      idb: { unreadCounts: persisted?.unreadCounts, latestOrdinals: persisted?.latestOrdinals },
    }).toEqual({
      cache: { unreadCounts: perEvent.unreadCounts, latestOrdinals: perEvent.latestOrdinals },
      idb: { unreadCounts: perEvent.unreadCounts, latestOrdinals: perEvent.latestOrdinals },
    })
    expect(perEvent.unreadCounts.s1).toBe(3)
  })
})
