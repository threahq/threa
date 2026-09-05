import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import Dexie, { liveQuery } from "dexie"
import { db, sequenceToNum, type CachedEvent, type CachedStream } from "@/db"
import { computeTimelineHoles } from "@/sync/contiguity"
import {
  TIMELINE_TAIL_EVENTS,
  composeStreamWindow,
  stampStreamEvents,
  loadStreamEvents,
  loadStreamPrefix,
  loadStreamTail,
  orderStreamEvents,
  shareEventIdentities,
  unionStreamRanges,
  useStreamEvents,
  useStreamFromStore,
} from "./stream-store"
import {
  getWorkspaceTableSnapshot,
  resetWorkspaceTableRegistry,
  subscribeWorkspaceTable,
} from "./workspace-table-registry"
import { makeCachedStream } from "@/test/workspace-rows"
import { bumpLaterOptimisticAnchors } from "@/sync/stream-sync"
import { requestStreamEventReadRefresh } from "./stream-event-read-refresh"
import { whenReadsSettled } from "./apply-window"
import { BOARD_RAIL_EVENT_TYPES } from "@/lib/board/board-rail-event-types"

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

async function putRawEvent(event: CachedEvent): Promise<void> {
  const request = indexedDB.open(db.name)
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("events", "readwrite")
      transaction.objectStore("events").put(event)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
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
    const unsubscribe = subscribeWorkspaceTable(workspaceId, "streams", () => {})
    await waitFor(() => expect(getWorkspaceTableSnapshot(workspaceId, "streams")).toBeDefined())
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
})

describe("bounded timeline read — tail and prefix", () => {
  const STREAM = "stream_bounded"

  function makeBroadcastEvent(streamId: string, sequence: string, broadcastSequence: string): CachedEvent {
    return { ...makeRealEvent(streamId, sequence), broadcastSequence } as CachedEvent
  }

  /** Seed `count` persisted events at sequences 1..count, inserted reversed. */
  async function seed(count: number, streamId = STREAM): Promise<void> {
    const seqs = Array.from({ length: count }, (_, i) => i + 1)
    await db.events.bulkPut([...seqs].reverse().map((n) => makeRealEvent(streamId, String(n))))
  }

  /** The production union of both ranges, at a given anchor. */
  async function readUnion(streamId: string, floor: number | null, tailFloor: number | null): Promise<CachedEvent[]> {
    const prefix = await loadStreamPrefix(streamId, floor, tailFloor)
    const tail = await loadStreamTail(streamId, tailFloor, tailFloor === null ? floor : null)
    return unionStreamRanges(prefix, tail)
  }

  /** Emissions of a subscription over `read`, counted while `run` writes. */
  async function countEmissions(read: () => Promise<unknown>, run: () => Promise<void>): Promise<number> {
    let emissions = 0
    let resolveFirst: (() => void) | undefined
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const subscription = liveQuery(read).subscribe(() => {
      emissions += 1
      resolveFirst?.()
    })
    try {
      await first
      const baseline = emissions
      await run()
      await new Promise((resolve) => setTimeout(resolve, 50))
      return emissions - baseline
    } finally {
      subscription.unsubscribe()
    }
  }

  beforeEach(async () => {
    await db.events.clear()
  })

  it("the unanchored tail read returns the newest N above the floor, in ascending order", async () => {
    await seed(TIMELINE_TAIL_EVENTS + 120)

    const tail = await loadStreamTail(STREAM, null, 1)

    expect(tail).toHaveLength(TIMELINE_TAIL_EVENTS)
    expect(tail.map((e) => e._sequenceNum)).toEqual(Array.from({ length: TIMELINE_TAIL_EVENTS }, (_, i) => 121 + i))
  })

  it("the two ranges are disjoint — a boundary row appears once and the union never duplicates an id", async () => {
    // The union is a bare concat with no dedupe: safety rests on the prefix's
    // exclusive upper bound `[floor, tailFloor)` never overlapping the tail's
    // inclusive `[tailFloor, max]`. This pins it — a future write path that
    // re-stamps `_sequenceNum` (or a bounds change to inclusive/inclusive)
    // would surface here as a duplicate React key, not in production.
    await seed(30)
    const tailFloor = 15
    const union = await readUnion(STREAM, 1, tailFloor)
    const boundary = union.filter((e) => e._sequenceNum === tailFloor)
    const ids = union.map((e) => e.id)
    expect({ boundaryCount: boundary.length, unique: new Set(ids).size, total: ids.length }).toEqual({
      boundaryCount: 1,
      unique: 30,
      total: 30,
    })
  })

  it("the union of tail and prefix equals today's single floored read", async () => {
    // The acceptance test: same fixture, both arms, deep-equal.
    await seed(TIMELINE_TAIL_EVENTS + 300)
    await db.events.bulkPut([
      makeOptimisticEvent(STREAM, "temp_pending", String(Date.now())),
      makeOptimisticEvent(STREAM, "temp_failed", String(Date.now() + 1)),
    ])

    const single = await loadStreamEvents(STREAM, 50)
    const tailFloor = (await loadStreamTail(STREAM, null, 50)).filter((e) => e._status == null)[0]._sequenceNum
    const split = await readUnion(STREAM, 50, tailFloor)

    expect(split).toEqual(single)
  })

  it("an unsent optimistic row above the tail floor is included exactly once", async () => {
    await seed(20)
    await db.events.put(makeOptimisticEvent(STREAM, "temp_new", String(Date.now())))

    const union = await readUnion(STREAM, 1, 15)

    expect(union.filter((e) => e.id === "temp_new")).toHaveLength(1)
    expect(union[union.length - 1].id).toBe("temp_new")

    // And on the pre-anchor emission, where the tail is capped at the newest N:
    // a legacy low-placeholder unsent row sits outside that window and is only
    // in the result because the unanchored tail merges the `_status` index.
    await seed(TIMELINE_TAIL_EVENTS + 50)
    await db.events.put(makeOptimisticEvent(STREAM, "temp_low", "5"))
    const unanchoredTail = await loadStreamTail(STREAM, null, 1)
    expect(unanchoredTail.filter((e) => e.id === "temp_low")).toHaveLength(1)
  })

  it("an optimistic row anchored inside the prefix still orders at its anchor", async () => {
    await seed(20)
    // Production optimistic rows carry a `Date.now()` sequence (so they sit in the
    // tail range) but anchor at the persisted row they were composed under.
    await db.events.put(makeOptimisticEvent(STREAM, "temp_anchored", String(Date.now()), undefined, 5))

    const union = await readUnion(STREAM, 1, 15)

    expect(union.map((e) => e.id).indexOf("temp_anchored")).toBe(5)
  })

  it("a new message wakes the tail read and not the prefix read", async () => {
    await seed(20)
    const write = async () => {
      await db.events.put(makeRealEvent(STREAM, "21"))
    }

    const tailEmissions = await countEmissions(() => loadStreamTail(STREAM, 15, null), write)
    await db.events.delete(`evt_${STREAM}_21`)
    const prefixEmissions = await countEmissions(() => loadStreamPrefix(STREAM, 1, 15), write)

    expect(tailEmissions).toBeGreaterThan(0)
    expect(prefixEmissions).toBe(0)
  })

  it("an edit to an old prefix row still wakes the prefix read", async () => {
    await seed(20)

    const prefixEmissions = await countEmissions(
      () => loadStreamPrefix(STREAM, 1, 15),
      async () => {
        await db.events.update(`evt_${STREAM}_3`, { _patchedAt: Date.now() })
      }
    )

    expect(prefixEmissions).toBeGreaterThan(0)
  })

  it("messages arriving during a visit land in the tail, and a stale prefix emission still composes a contiguous window", async () => {
    await db.events.bulkPut(
      Array.from({ length: 20 }, (_, i) => makeBroadcastEvent(STREAM, String(i + 1), String(i + 1)))
    )
    const tailFloor = 15

    // The prefix range is `[floor, tailFloor)`, so nothing arriving above the
    // floor can change it: holding the prefix's resolution is indistinguishable
    // from letting it re-run, which is why emission skew cannot uncover a range.
    const stalePrefix = await loadStreamPrefix(STREAM, 1, tailFloor)
    await db.events.bulkPut(
      Array.from({ length: 3 }, (_, i) => makeBroadcastEvent(STREAM, String(i + 21), String(i + 21)))
    )
    const freshPrefix = await loadStreamPrefix(STREAM, 1, tailFloor)
    expect(freshPrefix).toEqual(stalePrefix)

    const tail = await loadStreamTail(STREAM, tailFloor, null)
    const union = unionStreamRanges(stalePrefix, tail)

    expect(union.map((e) => e._sequenceNum)).toEqual(Array.from({ length: 23 }, (_, i) => i + 1))
    expect(computeTimelineHoles(union)).toEqual([])
  })

  it("nothing already rendered vanishes at any intermediate step of an older-page load", async () => {
    await seed(300)
    const tailFloor = 251

    const rendered = await readUnion(STREAM, 200, tailFloor)
    const renderedIds = rendered.map((e) => e.id)
    const widenedPrefix = await loadStreamPrefix(STREAM, 150, tailFloor)
    const tail = await loadStreamTail(STREAM, tailFloor, null)

    // Both interleavings of the two arms' emissions, and the fully-settled state.
    const steps = [
      unionStreamRanges(await loadStreamPrefix(STREAM, 200, tailFloor), tail),
      unionStreamRanges(widenedPrefix, tail),
    ]
    for (const step of steps) {
      const ids = new Set(step.map((e) => e.id))
      expect(renderedIds.filter((id) => !ids.has(id))).toEqual([])
    }
    expect(steps[1].map((e) => e._sequenceNum)).toEqual(Array.from({ length: 151 }, (_, i) => i + 150))

    // Neutralisation: the refuted design raised the tail floor on an older page.
    // With the floor raised, the old prefix no longer reaches the new tail and
    // rows the user was looking at disappear — this test fails against it.
    const raisedTail = await loadStreamTail(STREAM, 261, null)
    const raisedIds = new Set(
      unionStreamRanges(await loadStreamPrefix(STREAM, 200, tailFloor), raisedTail).map((e) => e.id)
    )
    expect(renderedIds.filter((id) => !raisedIds.has(id)).length).toBeGreaterThan(0)
  })

  it("a message arriving mid-latch never composes a window with a hole in it", async () => {
    // The pre-latch tail is the UNANCHORED capped read, whose lower bound moves
    // with every arriving message. Pairing it with an anchored prefix drops the
    // sequence at the tail floor, so the composition gates on both stamps.
    await db.events.bulkPut(
      Array.from({ length: 260 }, (_, i) => makeBroadcastEvent(STREAM, String(i + 1), String(i + 1)))
    )
    const holesAt: unknown[][] = []
    const track = (window: CachedEvent[] | undefined) => {
      if (window) holesAt.push(computeTimelineHoles(window))
      return window ?? null
    }

    // 1. Pre-latch: unstamped prefix (today's whole floored read) + unanchored tail.
    const prefixPre = stampStreamEvents(await loadStreamEvents(STREAM, 1), STREAM, null)
    const tailPre = stampStreamEvents(await loadStreamTail(STREAM, null, 1), STREAM, null)
    const windowPre = track(composeStreamWindow(prefixPre, tailPre, null))

    // 2. The tail floor latches at the oldest persisted row of that emission.
    const tailFloor = tailPre[0]._sequenceNum
    expect(tailFloor).toBe(61)

    // 3. A message arrives before the anchored reads resolve, so the still-live
    //    unanchored query re-emits shifted up by one: `[62..261]`, not `[61..261]`.
    await db.events.put(makeBroadcastEvent(STREAM, "261", "261"))
    const tailStale = stampStreamEvents(await loadStreamTail(STREAM, null, 1), STREAM, null)
    expect(tailStale[0]._sequenceNum).toBe(62)

    // 4. The anchored prefix resolves first — the exact interleave. Composing it
    //    with the stale tail would omit sequence 61.
    const prefixAnchored = stampStreamEvents(await loadStreamPrefix(STREAM, 1, tailFloor), STREAM, tailFloor)
    const windowSkewed = track(composeStreamWindow(prefixAnchored, tailStale, windowPre))
    expect(windowSkewed).toBe(windowPre)

    // 5. The anchored tail resolves; both stamps agree and the window settles.
    const tailAnchored = stampStreamEvents(await loadStreamTail(STREAM, tailFloor, null), STREAM, tailFloor)
    const windowFinal = track(composeStreamWindow(prefixAnchored, tailAnchored, windowSkewed))

    expect(windowFinal?.map((e) => e._sequenceNum)).toEqual(Array.from({ length: 261 }, (_, i) => i + 1))
    expect(holesAt).toEqual([[], [], []])

    // Neutralisation: without the tail's own stamp the gate can only compare the
    // prefix, so the skewed step composes and sequence 61 goes missing.
    const ungated = unionStreamRanges(prefixAnchored, tailStale)
    expect(ungated.map((e) => e._sequenceNum)).not.toContain(61)
    expect(computeTimelineHoles(ungated)).toEqual([
      { afterEventId: `evt_${STREAM}_60`, afterSequence: "60", missingCount: 1 },
    ])
  })

  it("a hole in the broadcast chain is still detected across the tail/prefix boundary", async () => {
    // Broadcast slot 15 never arrived; the gap straddles a tail floor of 16, so
    // the row before the hole is in the prefix and the row after it is in the tail.
    await db.events.bulkPut([
      ...Array.from({ length: 14 }, (_, i) => makeBroadcastEvent(STREAM, String(i + 1), String(i + 1))),
      ...Array.from({ length: 5 }, (_, i) => makeBroadcastEvent(STREAM, String(i + 16), String(i + 16))),
    ])

    const union = await readUnion(STREAM, 1, 16)

    expect(union.map((e) => e._sequenceNum)).toEqual([
      ...Array.from({ length: 14 }, (_, i) => i + 1),
      16,
      17,
      18,
      19,
      20,
    ])
    expect(computeTimelineHoles(union)).toEqual([
      { afterEventId: `evt_${STREAM}_14`, afterSequence: "14", missingCount: 1 },
    ])
  })
})

describe("useStreamEvents with the bounded read armed", () => {
  const STREAM = "stream_hook_bounded"
  const OTHER = "stream_hook_other"

  async function seed(streamId: string, count: number, from = 1): Promise<void> {
    await db.events.bulkPut(Array.from({ length: count }, (_, i) => makeRealEvent(streamId, String(from + i))))
  }

  /** Every `.between()` range opened on db.events while `capture` runs. */
  function recordRanges(): { ranges: unknown[][]; restore: () => void } {
    const ranges: unknown[][] = []
    const original = db.events.where.bind(db.events)
    const spy = vi.spyOn(db.events, "where").mockImplementation(((index: string) => {
      const clause = original(index)
      const between = clause.between.bind(clause)
      clause.between = ((...args: unknown[]) => {
        ranges.push(args)
        return (between as (...a: unknown[]) => unknown)(...args)
      }) as typeof clause.between
      return clause
    }) as typeof db.events.where)
    return { ranges, restore: () => spy.mockRestore() }
  }

  beforeEach(async () => {
    await db.events.clear()
  })

  it("re-reads IDB on resume when a frozen page missed the service worker's write notification", async () => {
    await seed(STREAM, 1)
    const { result } = renderHook(() => useStreamEvents(STREAM, 1))
    await waitFor(() => expect(result.current?.map((event) => event.sequence)).toEqual(["1"]))

    await putRawEvent(makeRealEvent(STREAM, "2"))
    expect((await db.events.where("streamId").equals(STREAM).toArray()).map((event) => event.sequence)).toEqual([
      "1",
      "2",
    ])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(result.current?.map((event) => event.sequence)).toEqual(["1"])

    await act(() => requestStreamEventReadRefresh([STREAM]))

    await waitFor(() => expect(result.current?.map((event) => event.sequence)).toEqual(["1", "2"]))
  })

  it("re-reads event-type rails when a newer event falls outside their observed index ranges", async () => {
    await db.events.bulkPut([
      { ...makeRealEvent(STREAM, "0"), eventType: "agent:follow_up_scheduled", payload: {} },
      makeRealEvent(STREAM, "1"),
    ])
    let boardEventIds: string[] = []
    let messageEventIds: string[] = []
    const boardSubscription = liveQuery(() =>
      db.events
        .where("[streamId+eventType]")
        .anyOf(BOARD_RAIL_EVENT_TYPES.map((eventType) => [STREAM, eventType]))
        .toArray()
    ).subscribe((events) => {
      boardEventIds = events.map((event) => event.id).sort()
    })
    const messageSubscription = liveQuery(() =>
      db.events.where("[streamId+eventType]").equals([STREAM, "message_created"]).toArray()
    ).subscribe((events) => {
      messageEventIds = events.map((event) => event.id).sort()
    })

    try {
      await waitFor(() =>
        expect({ boardEventIds, messageEventIds }).toEqual({
          boardEventIds: [`evt_${STREAM}_0`, `evt_${STREAM}_1`],
          messageEventIds: [`evt_${STREAM}_1`],
        })
      )
      await putRawEvent(makeRealEvent(STREAM, "2"))
      await putRawEvent({ ...makeRealEvent(STREAM, "3"), eventType: "member_joined", payload: {} })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect({ boardEventIds, messageEventIds }).toEqual({
        boardEventIds: [`evt_${STREAM}_0`, `evt_${STREAM}_1`],
        messageEventIds: [`evt_${STREAM}_1`],
      })

      await act(() => requestStreamEventReadRefresh([STREAM]))

      await waitFor(() =>
        expect({ boardEventIds, messageEventIds }).toEqual({
          boardEventIds: [`evt_${STREAM}_0`, `evt_${STREAM}_1`, `evt_${STREAM}_2`],
          messageEventIds: [`evt_${STREAM}_1`, `evt_${STREAM}_2`],
        })
      )
    } finally {
      boardSubscription.unsubscribe()
      messageSubscription.unsubscribe()
    }
  })

  it("paging older widens the prefix and never re-opens the tail range", async () => {
    await seed(STREAM, 300)

    const { ranges, restore } = recordRanges()
    try {
      const { result, rerender } = renderHook(({ floor }: { floor: number }) => useStreamEvents(STREAM, floor), {
        initialProps: { floor: 200 },
      })
      await waitFor(() => expect(result.current?.length).toBe(101))

      const tailRanges = ranges.filter((args) => Array.isArray(args[1]) && (args[1] as unknown[])[1] === Dexie.maxKey)
      const tailRangeCount = tailRanges.length
      const anchoredTailLower = tailRanges[tailRanges.length - 1][0]

      rerender({ floor: 150 })
      await waitFor(() => expect(result.current?.length).toBe(151))

      const tailRangesAfter = ranges.filter(
        (args) => Array.isArray(args[1]) && (args[1] as unknown[])[1] === Dexie.maxKey
      )
      expect(tailRangesAfter.length).toBe(tailRangeCount)
      expect(tailRangesAfter[tailRangesAfter.length - 1][0]).toEqual(anchoredTailLower)
      expect(result.current?.map((e) => e._sequenceNum)).toEqual(Array.from({ length: 151 }, (_, i) => i + 150))
    } finally {
      restore()
    }
  })

  it("a replace-window bootstrap that raises the floor above the latch re-latches the tail", async () => {
    // A long-offline reconnect resets the floor ratchet, so the floor can land
    // ABOVE the latched tail floor. Keeping the old latch inverts the prefix
    // range (permanently empty) and makes the tail re-read the whole
    // pre-disconnect history on every message.
    await seed(STREAM, 400)
    const latched = 400 - TIMELINE_TAIL_EVENTS + 1
    const raisedFloor = latched + 50

    const { ranges, restore } = recordRanges()
    try {
      const seen: (CachedEvent[] | undefined)[] = []
      const { result, rerender } = renderHook(
        ({ floor }: { floor: number }) => {
          const events = useStreamEvents(STREAM, floor)
          seen.push(events)
          return events
        },
        { initialProps: { floor: 1 } }
      )
      await waitFor(() => expect(result.current?.length).toBe(400))

      rerender({ floor: raisedFloor })
      await waitFor(() => expect(result.current?.[0]?._sequenceNum).toBe(raisedFloor))

      const tailLowerBounds = ranges
        .filter((args) => Array.isArray(args[1]) && (args[1] as unknown[])[1] === Dexie.maxKey)
        .map((args) => (args[0] as unknown[])[1])
      expect({
        window: result.current?.map((e) => e._sequenceNum),
        reLatchedAtOrAboveFloor: tailLowerBounds[tailLowerBounds.length - 1],
      }).toEqual({
        window: Array.from({ length: 400 - raisedFloor + 1 }, (_, i) => raisedFloor + i),
        reLatchedAtOrAboveFloor: raisedFloor,
      })

      // No emission after the floor rose ever dropped a row at or above the new
      // floor that a previous emission had shown (the no-vanish property).
      let covered = 0
      for (const events of seen) {
        if (!events) continue
        const above = events.filter((e) => e._sequenceNum >= raisedFloor)
        if (above.length === 0) continue
        if (events[0]._sequenceNum >= raisedFloor) {
          expect(above.length).toBeGreaterThanOrEqual(covered)
          covered = above.length
        }
      }
      expect(covered).toBe(400 - raisedFloor + 1)
    } finally {
      restore()
    }
  })

  // Bites the stale-stream guard as a whole; the tail half of that guard is
  // defensive only, since the anchor can only latch from a tail already stamped
  // for the current stream.
  it("never returns a window mixing two streams while a switch is in flight", async () => {
    await seed(STREAM, 40)
    await seed(OTHER, 40)

    const seen: (CachedEvent[] | undefined)[] = []
    const { result, rerender } = renderHook(
      ({ streamId }: { streamId: string }) => {
        const events = useStreamEvents(streamId, 1)
        seen.push(events)
        return events
      },
      { initialProps: { streamId: STREAM } }
    )
    await waitFor(() => expect(result.current?.length).toBe(40))

    rerender({ streamId: OTHER })
    await waitFor(() => expect(result.current?.[0]?.streamId).toBe(OTHER))

    for (const events of seen) {
      if (!events) continue
      expect(new Set(events.map((e) => e.streamId)).size).toBe(1)
    }
  })
})

describe("useStreamEvents as a tracked read", () => {
  const STREAM = "stream_tracked_read"

  beforeEach(async () => {
    await db.events.clear()
  })

  it("holds whenReadsSettled until the mounted window has read its rows", async () => {
    await db.events.bulkPut([makeRealEvent(STREAM, "1"), makeRealEvent(STREAM, "2")])
    const { result } = renderHook(() => useStreamEvents(STREAM, 1))

    await whenReadsSettled()

    expect(result.current?.map((event) => event.sequence)).toEqual(["1", "2"])
  })
})
