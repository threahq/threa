import { describe, it, expect, beforeEach } from "vitest"
import { db, sequenceToNum, type CachedEvent } from "@/db"
import { loadStreamEvents, shareEventIdentities } from "./stream-store"

const WORKSPACE_ID = "ws_1"

function makeRealEvent(streamId: string, sequence: string): CachedEvent {
  const sequenceNum = sequenceToNum(sequence)
  return {
    id: `evt_${streamId}_${sequence}`,
    workspaceId: WORKSPACE_ID,
    streamId,
    sequence,
    _sequenceNum: sequenceNum,
    eventType: "message_created",
    payload: { messageId: `evt_${streamId}_${sequence}`, contentMarkdown: sequence },
    actorId: "user_1",
    actorType: "user",
    createdAt: new Date(2026, 0, 1, 0, 0, sequenceNum).toISOString(),
    _cachedAt: Date.now(),
  }
}

function makeOptimisticEvent(streamId: string, clientId: string, placeholderSeq: string): CachedEvent {
  const sequenceNum = sequenceToNum(placeholderSeq)
  return {
    id: clientId,
    workspaceId: WORKSPACE_ID,
    streamId,
    sequence: placeholderSeq,
    _sequenceNum: sequenceNum,
    eventType: "message_created",
    payload: { messageId: clientId, contentMarkdown: clientId },
    actorId: "user_1",
    actorType: "user",
    createdAt: new Date().toISOString(),
    _clientId: clientId,
    _status: "pending",
    _cachedAt: Date.now(),
  }
}

describe("loadStreamEvents", () => {
  beforeEach(async () => {
    await db.events.clear()
  })

  it("returns events ASC by _sequenceNum with no floor", async () => {
    const streamId = "stream_1"
    await db.events.bulkPut([
      makeRealEvent(streamId, "3"),
      makeRealEvent(streamId, "1"),
      makeRealEvent(streamId, "5"),
      makeRealEvent(streamId, "2"),
      makeRealEvent(streamId, "4"),
    ])

    const events = await loadStreamEvents(streamId, null)

    expect(events.map((e) => e.sequence)).toEqual(["1", "2", "3", "4", "5"])
  })

  it("returns events ASC by _sequenceNum when a floor is provided", async () => {
    const streamId = "stream_1"
    await db.events.bulkPut([
      makeRealEvent(streamId, "3"),
      makeRealEvent(streamId, "1"),
      makeRealEvent(streamId, "5"),
      makeRealEvent(streamId, "2"),
      makeRealEvent(streamId, "4"),
    ])

    const events = await loadStreamEvents(streamId, 1)

    expect(events.map((e) => e.sequence)).toEqual(["1", "2", "3", "4", "5"])
  })

  it("places optimistic events with Date.now() placeholder seqs after real events in a new channel", async () => {
    // Mirrors the bug scenario: empty channel after refresh, user fires off
    // 5 messages in rapid succession. All 5 are optimistic with placeholder
    // sequences in send order.
    const streamId = "stream_new"
    const t0 = 1714428000000
    await db.events.bulkPut([
      makeOptimisticEvent(streamId, "temp_1", String(t0 + 1)),
      makeOptimisticEvent(streamId, "temp_2", String(t0 + 2)),
      makeOptimisticEvent(streamId, "temp_3", String(t0 + 3)),
      makeOptimisticEvent(streamId, "temp_4", String(t0 + 4)),
      makeOptimisticEvent(streamId, "temp_5", String(t0 + 5)),
    ])

    const events = await loadStreamEvents(streamId, null)

    expect(events.map((e) => e.id)).toEqual(["temp_1", "temp_2", "temp_3", "temp_4", "temp_5"])
  })

  it("preserves order across the optimistic→real swap (newly-created channel)", async () => {
    // Bug repro: send 5 messages in a fresh channel. As each acks, the
    // optimistic event is replaced with a real one (server-assigned low seq).
    // The visible array must stay ASC by send order at every step — the just-
    // acked message must not "move up to the top".
    const streamId = "stream_new"
    const t0 = 1714428000000

    // All 5 sent (still pending)
    await db.events.bulkPut([
      makeOptimisticEvent(streamId, "temp_1", String(t0 + 1)),
      makeOptimisticEvent(streamId, "temp_2", String(t0 + 2)),
      makeOptimisticEvent(streamId, "temp_3", String(t0 + 3)),
      makeOptimisticEvent(streamId, "temp_4", String(t0 + 4)),
      makeOptimisticEvent(streamId, "temp_5", String(t0 + 5)),
    ])

    let events = await loadStreamEvents(streamId, null)
    expect(events.map((e) => e.id)).toEqual(["temp_1", "temp_2", "temp_3", "temp_4", "temp_5"])

    // Ack message 1: real evt_…_1 takes its place with server seq=1
    await db.transaction("rw", db.events, async () => {
      await db.events.put(makeRealEvent(streamId, "1"))
      await db.events.delete("temp_1")
    })
    events = await loadStreamEvents(streamId, null)
    expect(events.map((e) => e.sequence)).toEqual(["1", String(t0 + 2), String(t0 + 3), String(t0 + 4), String(t0 + 5)])

    // Ack messages 2, 3, 4, 5 in order
    for (const seq of ["2", "3", "4", "5"]) {
      await db.transaction("rw", db.events, async () => {
        await db.events.put(makeRealEvent(streamId, seq))
        await db.events.delete(`temp_${seq}`)
      })
    }

    events = await loadStreamEvents(streamId, null)
    expect(events.map((e) => e.sequence)).toEqual(["1", "2", "3", "4", "5"])
  })

  it("preserves order with a mixed pending+real window (channel with history)", async () => {
    // Channel already has messages 1–3 from a prior session (bootstrap floor=1).
    // User sends a new message — optimistic with placeholder seq lands at end.
    const streamId = "stream_with_history"
    const t0 = 1714428000000

    await db.events.bulkPut([
      makeRealEvent(streamId, "1"),
      makeRealEvent(streamId, "2"),
      makeRealEvent(streamId, "3"),
      makeOptimisticEvent(streamId, "temp_x", String(t0 + 1)),
    ])

    const events = await loadStreamEvents(streamId, 1)
    expect(events.map((e) => e.id)).toEqual([
      "evt_stream_with_history_1",
      "evt_stream_with_history_2",
      "evt_stream_with_history_3",
      "temp_x",
    ])
  })

  it("merges pending events that fell outside the count-capped window in ASC order", async () => {
    // Defensive: if a pending event's _sequenceNum is somehow lower than the
    // window of latest events, the merge step must still place it correctly
    // by _sequenceNum rather than appending at the end.
    const streamId = "stream_fallback"

    // Stuff the stream with > DEFAULT_IDB_EVENT_LIMIT (150) real events so the
    // window cap matters. Insert one pending event with a deliberately low
    // _sequenceNum (simulating a hypothetical alternative scheme).
    const reals: CachedEvent[] = []
    for (let i = 1; i <= 200; i++) {
      reals.push(makeRealEvent(streamId, String(i)))
    }
    const lowPending = makeOptimisticEvent(streamId, "temp_low", "10")
    await db.events.bulkPut([...reals, lowPending])

    const events = await loadStreamEvents(streamId, null)

    // Pending event must appear before the events with seq=11..200, between
    // seq=10 and seq=51 (the floor of the latest 150 real events).
    const ids = events.map((e) => e.id)
    const lowIdx = ids.indexOf("temp_low")
    expect(lowIdx).toBeGreaterThanOrEqual(0)
    // It sorts by _sequenceNum=10, which falls before all reals in the window
    // (seqs 51..200 — 200 reals capped to latest 150 = seqs 51..200).
    expect(ids[0]).toBe("temp_low")
  })

  it("returns a large floored window fully ASC without an unsent merge", async () => {
    // Exercises the fast path: a floor is known and there are no pending/failed
    // rows, so the result comes straight off the compound index in ASC order
    // with no comparison sort. Insert out of order to prove the order is the
    // index's, not insertion order.
    const streamId = "stream_big"
    const seqs = Array.from({ length: 250 }, (_, i) => i + 1)
    // Reverse (worst-case out-of-order) so the input order is deterministic and
    // can never coincidentally match the expected ASC output.
    const shuffled = [...seqs].reverse()
    await db.events.bulkPut(shuffled.map((n) => makeRealEvent(streamId, String(n))))

    const events = await loadStreamEvents(streamId, 1)

    expect(events.map((e) => e._sequenceNum)).toEqual(seqs)
  })

  it("excludes pending events below the floor when one is provided", async () => {
    // Floor-bounded reads must not pull in unsent events with
    // `_sequenceNum < fromSequenceNum`, or the window contract breaks.
    const streamId = "stream_floored"
    await db.events.bulkPut([
      makeRealEvent(streamId, "100"),
      makeRealEvent(streamId, "101"),
      // Pending event below the floor — must be filtered out.
      makeOptimisticEvent(streamId, "temp_below", "50"),
      // Pending event above the floor — must be kept.
      makeOptimisticEvent(streamId, "temp_above", "999999"),
    ])

    const events = await loadStreamEvents(streamId, 100)

    expect(events.map((e) => e.id)).toEqual(["evt_stream_floored_100", "evt_stream_floored_101", "temp_above"])
  })
})

describe("shareEventIdentities", () => {
  function reEmit(rows: CachedEvent[]): CachedEvent[] {
    // Simulate a liveQuery re-run: same stored bytes, all-new object identities.
    return rows.map((row) => ({ ...row, payload: { ...(row.payload as Record<string, unknown>) } }))
  }

  it("returns the previous array identity when nothing changed", () => {
    const prev = [makeRealEvent("stream_1", "100"), makeRealEvent("stream_1", "200")]
    expect(shareEventIdentities(prev, reEmit(prev))).toBe(prev)
  })

  it("reuses unchanged row identities when one row changed", () => {
    const a = makeRealEvent("stream_1", "100")
    const b = makeRealEvent("stream_1", "200")
    const next = reEmit([a, b])
    next[1]._patchedAt = Date.now() // a socket patch landed on b

    const shared = shareEventIdentities([a, b], next)
    expect(shared).not.toBe(next)
    expect(shared[0]).toBe(a)
    expect(shared[1]).toBe(next[1])
  })

  it("produces a new row identity when each write marker changes", () => {
    const base = makeRealEvent("stream_1", "100")
    const markers: Array<Partial<CachedEvent>> = [
      { _cachedAt: base._cachedAt + 1 },
      { _patchedAt: 123 },
      { _status: "pending" },
      { sequence: "999", _sequenceNum: 999 },
    ]
    for (const marker of markers) {
      const next = { ...reEmit([base])[0], ...marker }
      const shared = shareEventIdentities([base], [next])
      expect(shared[0]).toBe(next)
    }
  })

  it("keeps unchanged identities when a new row is appended (live message arrival)", () => {
    const a = makeRealEvent("stream_1", "100")
    const c = makeRealEvent("stream_1", "300")
    const next = [...reEmit([a]), c]

    const shared = shareEventIdentities([a], next)
    expect(shared).not.toBe(next.slice(0, 1))
    expect(shared[0]).toBe(a)
    expect(shared[1]).toBe(c)
    expect(shared).toHaveLength(2)
  })

  it("keeps unchanged identities when an older page is prepended", () => {
    const b = makeRealEvent("stream_1", "200")
    const olderPage = [makeRealEvent("stream_1", "50"), makeRealEvent("stream_1", "100")]
    const next = [...olderPage, ...reEmit([b])]

    const shared = shareEventIdentities([b], next)
    expect(shared[2]).toBe(b)
  })

  it("passes the array through when there is no previous emission", () => {
    const next = [makeRealEvent("stream_1", "100")]
    expect(shareEventIdentities(null, next)).toBe(next)
  })
})
