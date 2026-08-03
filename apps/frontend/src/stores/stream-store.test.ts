import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { db, sequenceToNum, type CachedEvent, type CachedStream } from "@/db"
import { loadStreamEvents, orderStreamEvents, shareEventIdentities, useStreamFromStore } from "./stream-store"
import {
  allocateWorkspaceTableToken,
  getWorkspaceTableSnapshot,
  resetWorkspaceTableRegistry,
  setWorkspaceReadMode,
  subscribeWorkspaceTable,
} from "./workspace-table-registry"
import { makeCachedStream } from "@/test/workspace-rows"
import { bumpLaterOptimisticAnchors } from "@/sync/stream-sync"

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

function makeOptimisticEvent(
  streamId: string,
  clientId: string,
  placeholderSeq: string,
  createdAt = new Date(2026, 0, 2).toISOString(),
  anchorSequenceNum?: number
): CachedEvent {
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
    createdAt,
    _clientId: clientId,
    _status: "pending",
    _anchorSequenceNum: anchorSequenceNum,
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

  it("merges optimistic events outside the count-capped window by createdAt", async () => {
    const streamId = "stream_fallback"
    const reals: CachedEvent[] = []
    for (let i = 1; i <= 200; i++) {
      reals.push(makeRealEvent(streamId, String(i)))
    }
    const oldPending = makeOptimisticEvent(streamId, "temp_old", "10", new Date(2026, 0, 1, 0, 0, 10).toISOString(), 10)
    await db.events.bulkPut([...reals, oldPending])

    const events = await loadStreamEvents(streamId, null)

    expect(events[0].id).toBe("temp_old")
  })

  it("keeps an editing optimistic row at its anchor", async () => {
    const streamId = "stream_editing"
    const editing = makeOptimisticEvent(streamId, "temp_editing", "1000", "2026-01-01T00:00:01.000Z", 1)
    editing._status = "editing"
    await db.events.bulkPut([
      makeRealEvent(streamId, "1"),
      makeRealEvent(streamId, "2"),
      makeRealEvent(streamId, "3"),
      editing,
    ])

    const events = await loadStreamEvents(streamId, 1)

    expect(events.map((event) => event.id)).toEqual([
      "evt_stream_editing_1",
      "temp_editing",
      "evt_stream_editing_2",
      "evt_stream_editing_3",
    ])
  })

  it("preserves optimistic order when creation timestamps match", async () => {
    const streamId = "stream_same_millisecond"
    const createdAt = "2026-01-01T20:30:00.000Z"
    await db.events.bulkPut([
      makeOptimisticEvent(streamId, "temp_z", "1000", createdAt, 0),
      makeOptimisticEvent(streamId, "temp_a", "1001", createdAt, 0),
    ])

    const events = await loadStreamEvents(streamId, null)

    expect(events.map((event) => event.id)).toEqual(["temp_z", "temp_a"])
  })

  it("places a legacy row older than all loaded history before that history", () => {
    const streamId = "stream_legacy_oldest"
    const legacy = makeOptimisticEvent(streamId, "temp_legacy", "1000", "1990-01-01T00:00:00.000Z")

    const events = orderStreamEvents([makeRealEvent(streamId, "1"), makeRealEvent(streamId, "2"), legacy])

    expect(events.map((event) => event.id)).toEqual([
      "temp_legacy",
      "evt_stream_legacy_oldest_1",
      "evt_stream_legacy_oldest_2",
    ])
  })

  it("starts a clock-skewed optimistic row after its observed persisted tail", async () => {
    const streamId = "stream_slow_clock"
    const optimistic = makeOptimisticEvent(streamId, "temp_slow", "1714428000000", "1990-01-01T00:00:00.000Z", 2)
    await db.events.bulkPut([
      makeRealEvent(streamId, "1"),
      makeRealEvent(streamId, "2"),
      makeRealEvent(streamId, "3"),
      optimistic,
    ])

    const events = await loadStreamEvents(streamId, 1)

    expect(events.map((event) => event.id)).toEqual([
      "evt_stream_slow_clock_1",
      "evt_stream_slow_clock_2",
      "temp_slow",
      "evt_stream_slow_clock_3",
    ])
  })

  it("preserves thread chronology while anchoring optimistic rows", () => {
    const streamId = "stream_thread"
    const first = makeRealEvent(streamId, "1")
    first.createdAt = "2026-01-02T00:00:00.000Z"
    const movedOlder = makeRealEvent(streamId, "2")
    movedOlder.createdAt = "2026-01-01T00:00:00.000Z"
    const future = makeRealEvent(streamId, "3")
    future.createdAt = "2026-01-03T00:00:00.000Z"
    const optimistic = makeOptimisticEvent(streamId, "temp_thread", "1000", "1990-01-01T00:00:00.000Z", 1)

    const events = orderStreamEvents([first, movedOlder, future, optimistic], (a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    )

    expect(events.map((event) => event.id)).toEqual([
      "evt_stream_thread_2",
      "evt_stream_thread_1",
      "temp_thread",
      "evt_stream_thread_3",
    ])
  })

  it("keeps later optimistic sends after an earlier send confirms", async () => {
    const streamId = "stream_partial_ack"
    const first = makeOptimisticEvent(streamId, "temp_first", "1000", "2026-01-01T00:00:01.000Z", 1)
    const second = makeOptimisticEvent(streamId, "temp_second", "1001", "2026-01-01T00:00:02.000Z", 1)
    await db.events.bulkPut([makeRealEvent(streamId, "1"), first, second])

    await db.transaction("rw", db.events, async () => {
      await bumpLaterOptimisticAnchors(streamId, first._sequenceNum, 2, first.id)
      await db.events.delete(first.id)
      await db.events.put(makeRealEvent(streamId, "2"))
    })

    const events = await loadStreamEvents(streamId, 1)

    expect(events.map((event) => event.id)).toEqual([
      "evt_stream_partial_ack_1",
      "evt_stream_partial_ack_2",
      "temp_second",
    ])
  })

  it("bumps a deterministic later row when cross-tab optimistic sequences tie", async () => {
    const streamId = "stream_cross_tab_tie"
    const confirmed = makeOptimisticEvent(streamId, "temp_a", "1000", "2026-01-01T00:00:01.000Z", 1)
    const later = makeOptimisticEvent(streamId, "temp_z", "1000", "2026-01-01T00:00:01.000Z", 1)
    await db.events.bulkPut([confirmed, later])

    await bumpLaterOptimisticAnchors(streamId, confirmed._sequenceNum, 2, confirmed.id)

    expect((await db.events.get(later.id))?._anchorSequenceNum).toBe(2)
  })

  it("lets a failed optimistic command move above newer persisted events", async () => {
    const streamId = "stream_failed_command"
    const failed = makeOptimisticEvent(streamId, "temp_cmd", "1714428000000", "2036-01-01T20:30:00.000Z", 1)
    failed.eventType = "command_dispatched"
    failed._status = "failed"
    failed.payload = { commandId: failed.id, name: "thinking", args: "low", status: "dispatched" }
    const newer = makeRealEvent(streamId, "2")
    newer.createdAt = "2026-01-01T21:13:00.000Z"
    await db.events.bulkPut([makeRealEvent(streamId, "1"), failed, newer])

    const events = await loadStreamEvents(streamId, 1)

    expect(events.map((event) => event.id)).toEqual([
      "evt_stream_failed_command_1",
      "temp_cmd",
      "evt_stream_failed_command_2",
    ])
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

describe("useStreamFromStore", () => {
  const REGISTRY_WORKSPACE = "ws_registry"
  const OTHER_WORKSPACE = "ws_other"

  function makeStream(id: string, workspaceId: string, overrides: Partial<CachedStream> = {}): CachedStream {
    return makeCachedStream(workspaceId, id, overrides)
  }

  /** Bring up the shared registry entry the fast path reads, and wait for its first emission. */
  async function primeRegistry(workspaceId: string): Promise<() => void> {
    const token = allocateWorkspaceTableToken()
    const unsubscribe = subscribeWorkspaceTable(workspaceId, "streams", token, () => {})
    await waitFor(() => expect(getWorkspaceTableSnapshot(workspaceId, "streams", token)).toBeDefined())
    return unsubscribe
  }

  /**
   * Wait until a render counter stops moving. The fallback live query emits its
   * "registry owns this" marker asynchronously after mount, so a count sampled
   * right after the first resolve can still take one more render that has
   * nothing to do with the write under test.
   */
  async function settle(count: () => number): Promise<void> {
    let last = -1
    await waitFor(() => {
      const current = count()
      const stable = current === last
      last = current
      expect(stable).toBe(true)
    })
  }

  let releaseRegistry: (() => void) | null = null

  beforeEach(async () => {
    resetWorkspaceTableRegistry()
    await db.streams.clear()
    setWorkspaceReadMode("shared")
  })

  afterEach(() => {
    releaseRegistry?.()
    releaseRegistry = null
    resetWorkspaceTableRegistry()
    vi.restoreAllMocks()
  })

  it("a stream row present in the workspace registry resolves without a per-key live query", async () => {
    await db.streams.bulkPut([makeStream("stream_a", REGISTRY_WORKSPACE), makeStream("stream_b", REGISTRY_WORKSPACE)])
    releaseRegistry = await primeRegistry(REGISTRY_WORKSPACE)
    const get = vi.spyOn(db.streams, "get")

    const { result } = renderHook(() => useStreamFromStore("stream_a"))

    await waitFor(() => expect(result.current?.id).toBe("stream_a"))
    expect(get).not.toHaveBeenCalled()
  })

  it("a stream row absent from the registry falls back to the per-key read", async () => {
    await db.streams.put(makeStream("stream_registry", REGISTRY_WORKSPACE))
    releaseRegistry = await primeRegistry(REGISTRY_WORKSPACE)
    // A socket write that landed before its workspace bootstrapped: in IDB, in no
    // registry entry.
    await db.streams.put(makeStream("stream_socket", OTHER_WORKSPACE))
    const get = vi.spyOn(db.streams, "get")

    const { result } = renderHook(() => useStreamFromStore("stream_socket"))

    await waitFor(() => expect(result.current?.id).toBe("stream_socket"))
    expect(get).toHaveBeenCalledWith("stream_socket")
  })

  it("a change to one stream re-renders only its readers", async () => {
    await db.streams.bulkPut([makeStream("stream_a", REGISTRY_WORKSPACE), makeStream("stream_b", REGISTRY_WORKSPACE)])
    releaseRegistry = await primeRegistry(REGISTRY_WORKSPACE)

    let rendersA = 0
    let rendersB = 0
    const readerA = renderHook(() => {
      rendersA += 1
      return useStreamFromStore("stream_a")
    })
    const readerB = renderHook(() => {
      rendersB += 1
      return useStreamFromStore("stream_b")
    })
    await waitFor(() => expect(readerA.result.current?.id).toBe("stream_a"))
    await waitFor(() => expect(readerB.result.current?.id).toBe("stream_b"))
    await settle(() => rendersB)
    const rendersBBefore = rendersB

    await db.streams.put(makeStream("stream_a", REGISTRY_WORKSPACE, { displayName: "renamed" }))

    await waitFor(() => expect(readerA.result.current?.displayName).toBe("renamed"))
    expect(rendersB).toBe(rendersBBefore)
    expect(rendersA).toBeGreaterThan(0)
  })

  it("the row reference is stable across an unrelated streams write", async () => {
    await db.streams.bulkPut([makeStream("stream_a", REGISTRY_WORKSPACE), makeStream("stream_b", REGISTRY_WORKSPACE)])
    releaseRegistry = await primeRegistry(REGISTRY_WORKSPACE)

    const readerA = renderHook(() => useStreamFromStore("stream_a"))
    const readerB = renderHook(() => useStreamFromStore("stream_b"))
    await waitFor(() => expect(readerA.result.current?.id).toBe("stream_a"))
    await waitFor(() => expect(readerB.result.current?.id).toBe("stream_b"))
    const rowA = readerA.result.current

    await db.streams.put(makeStream("stream_b", REGISTRY_WORKSPACE, { displayName: "renamed" }))

    await waitFor(() => expect(readerB.result.current?.displayName).toBe("renamed"))
    expect(readerA.result.current).toBe(rowA)
  })

  it("a row removed from the registry resolves to undefined, never a stale or sentinel value", async () => {
    await db.streams.bulkPut([makeStream("stream_a", REGISTRY_WORKSPACE), makeStream("stream_b", REGISTRY_WORKSPACE)])
    releaseRegistry = await primeRegistry(REGISTRY_WORKSPACE)

    const observed: unknown[] = []
    const { result } = renderHook(() => {
      const row = useStreamFromStore("stream_a")
      observed.push(row)
      return row
    })
    await waitFor(() => expect(result.current?.id).toBe("stream_a"))

    // Pin the fallback read open: the removal must resolve to `undefined` off the
    // registry emission alone, not by waiting for a per-key re-read.
    vi.spyOn(db.streams, "get").mockReturnValue(new Promise(() => {}) as never)
    await db.streams.delete("stream_a")

    await waitFor(() => expect(result.current).toBeUndefined())
    for (const value of observed) {
      if (value === undefined) continue
      expect(typeof value).toBe("object")
      expect((value as CachedStream).id).toBe("stream_a")
    }
  })

  it("an on→off flip holds the resolved row and opens no whole-table read per reader", async () => {
    await db.streams.put(makeStream("stream_a", REGISTRY_WORKSPACE, { displayName: "Held Channel" }))
    releaseRegistry = await primeRegistry(REGISTRY_WORKSPACE)

    const observed: (CachedStream | undefined)[] = []
    const readers = [0, 1, 2].map(() =>
      renderHook(() => {
        const row = useStreamFromStore("stream_a")
        observed.push(row)
        return row
      })
    )
    for (const reader of readers) await waitFor(() => expect(reader.result.current?.id).toBe("stream_a"))
    const held = readers.map((reader) => reader.result.current)

    const where = vi.spyOn(db.streams, "where")
    await act(async () => {
      setWorkspaceReadMode("off")
    })

    readers.forEach((reader, index) => expect(reader.result.current).toBe(held[index]))
    for (const reader of readers) {
      await waitFor(() => expect(reader.result.current?.displayName).toBe("Held Channel"))
    }
    expect(observed).not.toContain(undefined)
    // The flip must not migrate the readers' row registrations into private
    // entries: that opens one whole-table streams query PER READER — the cost the
    // kill switch exists to remove. The one expected call is the table
    // subscriber's own re-key.
    expect(where.mock.calls.length).toBe(1)
  })
})
