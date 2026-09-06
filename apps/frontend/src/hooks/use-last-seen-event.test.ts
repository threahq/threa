import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { StreamEvent } from "@threa/types"
import { pickVisibleRange, advanceFrontier, useLastSeenEvent, type VisibleRow } from "./use-last-seen-event"

// Viewport spans y=0..100. Rows are in chronological (DOM) order.
const VIEWPORT_TOP = 0
const VIEWPORT_BOTTOM = 100

function pick(rows: VisibleRow[]): ReturnType<typeof pickVisibleRange> {
  return pickVisibleRange(rows, VIEWPORT_TOP, VIEWPORT_BOTTOM)
}

describe("pickVisibleRange", () => {
  it("returns the first and last rows intersecting the viewport", () => {
    const rows: VisibleRow[] = [
      { id: "a", top: 10, bottom: 40 },
      { id: "b", top: 40, bottom: 70 },
      { id: "c", top: 70, bottom: 95 },
    ]
    expect(pick(rows)).toEqual({ topId: "a", bottomId: "c" })
  })

  it("excludes rows scrolled entirely above the viewport top", () => {
    const rows: VisibleRow[] = [
      { id: "a", top: -80, bottom: -10 }, // fully above
      { id: "b", top: 5, bottom: 50 },
      { id: "c", top: 50, bottom: 95 },
    ]
    expect(pick(rows)).toEqual({ topId: "b", bottomId: "c" })
  })

  it("excludes rows entirely below the viewport (not yet seen)", () => {
    const rows: VisibleRow[] = [
      { id: "a", top: 10, bottom: 60 },
      { id: "b", top: 60, bottom: 99 },
      { id: "c", top: 120, bottom: 180 }, // below the fold
    ]
    expect(pick(rows)).toEqual({ topId: "a", bottomId: "b" })
  })

  it("counts a row taller than the viewport as both top and bottom", () => {
    const rows: VisibleRow[] = [{ id: "a", top: -50, bottom: 200 }]
    expect(pick(rows)).toEqual({ topId: "a", bottomId: "a" })
  })

  it("returns null when no rows intersect the viewport", () => {
    const rows: VisibleRow[] = [
      { id: "a", top: -80, bottom: -10 },
      { id: "b", top: 200, bottom: 260 },
    ]
    expect(pick(rows)).toBeNull()
  })

  it("returns null for an empty list", () => {
    expect(pick([])).toBeNull()
  })

  it("returns a single-row range when only one row is visible", () => {
    const rows: VisibleRow[] = [
      { id: "a", top: -80, bottom: -10 },
      { id: "b", top: 5, bottom: 50 },
      { id: "c", top: 200, bottom: 260 },
    ]
    expect(pick(rows)).toEqual({ topId: "b", bottomId: "b" })
  })
})

describe("advanceFrontier", () => {
  it("does NOT advance when landing at the live bottom with a gap above", () => {
    // Read up to row 4; viewport shows rows 27..30 (the tail). The gap 5..26 is
    // unseen, so the frontier must stay at 4 — opening at the bottom keeps the
    // unread above unread.
    expect(advanceFrontier(4, 27, 30, 5)).toBe(4)
  })

  it("advances to the bottom of the viewport when contiguous with the frontier", () => {
    // Jumped to the first unread (row 5, frontier+1) and it's at the top; advance
    // through what's on screen.
    expect(advanceFrontier(4, 5, 8, 5)).toBe(8)
  })

  it("advances when the viewport top sits above the frontier (overlap)", () => {
    expect(advanceFrontier(7, 5, 12, 8)).toBe(12)
  })

  it("does not advance when flinging past leaves a gap above the viewport", () => {
    // Frontier at 7, but a fast scroll put rows 20..25 on screen without 8..19
    // ever being visible — they stay unseen.
    expect(advanceFrontier(7, 20, 25, 8)).toBe(7)
  })

  it("does not retract when scrolling back up (bottom below the frontier)", () => {
    expect(advanceFrontier(20, 10, 15, 21)).toBe(20)
  })

  it("advances past bridged chrome when the gate says the first unread message is further down", () => {
    // Frontier at 1, a session card at 2 that never came on screen, the unread
    // message at 3. Raw adjacency (gate = 2) blocks; the real gate is 3.
    expect(advanceFrontier(1, 3, 3, 2)).toBe(1)
    expect(advanceFrontier(1, 3, 3, 3)).toBe(3)
  })

  it("treats an exactly-contiguous top (frontier + 1) as no gap", () => {
    expect(advanceFrontier(9, 10, 14, 10)).toBe(14)
  })
})

describe("useLastSeenEvent re-scan triggers", () => {
  // The container viewport spans y=0..100; rows carry mutable rects so a test
  // can "grow" the content (an embed loading) between scans.
  let roCallbacks: ResizeObserverCallback[]
  const saved: Record<string, unknown> = {}

  beforeEach(() => {
    roCallbacks = []
    const g = globalThis as Record<string, unknown>
    saved.raf = g.requestAnimationFrame
    saved.caf = g.cancelAnimationFrame
    saved.ro = g.ResizeObserver
    // Run rAF synchronously so a scheduled scan resolves within the act() block.
    // Return 0 (not a truthy id): the hook assigns the return value to its `raf`
    // guard *after* the callback runs here, so a truthy id would wedge the guard
    // and swallow the next schedule().
    g.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    }
    g.cancelAnimationFrame = () => {}
    // jsdom has no ResizeObserver; capture the callback so the test can fire it.
    g.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        roCallbacks.push(cb)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  })

  afterEach(() => {
    const g = globalThis as Record<string, unknown>
    g.requestAnimationFrame = saved.raf
    g.cancelAnimationFrame = saved.caf
    g.ResizeObserver = saved.ro
  })

  function rect(top: number, bottom: number): DOMRect {
    return {
      top,
      bottom,
      left: 0,
      right: 0,
      width: 0,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect
  }

  function fireResize() {
    act(() => {
      for (const cb of roCallbacks) cb([], {} as ResizeObserver)
    })
  }

  it("advances the frontier to the trailing row when an embed resizes it into view without a scroll", () => {
    // A short stream that fits the viewport fires no scroll event. The last row
    // starts below the fold (its embed hasn't loaded), so the first scan can't
    // reach it; a ResizeObserver-driven re-scan must mark it once it lands.
    const positions: Record<string, { top: number; bottom: number }> = {
      e0: { top: -50, bottom: -10 }, // scrolled above the viewport (already read)
      e1: { top: 10, bottom: 60 }, // visible
      e2: { top: 130, bottom: 180 }, // below the fold — not yet seen
    }

    const container = document.createElement("div")
    container.getBoundingClientRect = () => rect(0, 100)
    for (const id of Object.keys(positions)) {
      const row = document.createElement("div")
      row.setAttribute("data-event-id", id)
      row.getBoundingClientRect = () => rect(positions[id].top, positions[id].bottom)
      container.appendChild(row)
    }

    const events = [
      { id: "e0", sequence: "0", eventType: "message_created" },
      { id: "e1", sequence: "1", eventType: "message_created" },
      { id: "e2", sequence: "2", eventType: "message_created" },
    ] as unknown as StreamEvent[]
    const scrollContainerRef = { current: container }

    const { result } = renderHook(() =>
      useLastSeenEvent({ scrollContainerRef, events, streamId: "stream_1", lastReadEventId: "e0", enabled: true })
    )

    // First scan: e2 is below the fold, so the frontier stops at e1.
    expect(result.current.lastSeenEventId).toBe("e1")
    expect(result.current.atLastRow).toBe(false)

    // The embed loads and the trailing row resizes into the viewport.
    positions.e2 = { top: 65, bottom: 95 }
    fireResize()

    // The re-scan reaches the last row — the message that was stuck unread.
    expect(result.current.lastSeenEventId).toBe("e2")
    expect(result.current.atLastRow).toBe(true)
  })

  it("marks a message read when only an agent-session card sits between it and the pointer, off-screen", () => {
    // Kristoffer's prod streams, exactly: pointer on his own message, an
    // `agent_session:started` card next, then the bot's reply — which is taller
    // than a phone viewport. Landing inside that reply (deep link or unread
    // marker) leaves the card above the fold, so raw adjacency could never close
    // the run and the message stayed unread while being read.
    const positions: Record<string, { top: number; bottom: number }> = {
      e0: { top: -260, bottom: -210 }, // his message (the read pointer)
      e1: { top: -180, bottom: -140 }, // the session card — above the fold
      e2: { top: -40, bottom: 400 }, // the bot reply, taller than the viewport
    }

    const container = document.createElement("div")
    container.getBoundingClientRect = () => rect(0, 100)
    for (const id of Object.keys(positions)) {
      const row = document.createElement("div")
      row.setAttribute("data-event-id", id)
      row.getBoundingClientRect = () => rect(positions[id].top, positions[id].bottom)
      container.appendChild(row)
    }

    const events = [
      { id: "e0", sequence: "0", eventType: "message_created" },
      { id: "e1", sequence: "1", eventType: "agent_session:started" },
      { id: "e2", sequence: "2", eventType: "message_created" },
    ] as unknown as StreamEvent[]

    const { result } = renderHook(() =>
      useLastSeenEvent({
        scrollContainerRef: { current: container },
        events,
        streamId: "stream_1",
        lastReadEventId: "e0",
        enabled: true,
      })
    )

    expect(result.current.lastSeenEventId).toBe("e2")
    expect(result.current.atLastRow).toBe(true)
  })

  it("still refuses to skip an unseen MESSAGE above the viewport", () => {
    // The counterpart: same geometry, but the row between pointer and the
    // visible message is a real message. Progressive read must still block —
    // bridging is only ever for chrome.
    const positions: Record<string, { top: number; bottom: number }> = {
      e0: { top: -260, bottom: -210 },
      e1: { top: -180, bottom: -140 }, // an unread message, never on screen
      e2: { top: -40, bottom: 400 },
    }

    const container = document.createElement("div")
    container.getBoundingClientRect = () => rect(0, 100)
    for (const id of Object.keys(positions)) {
      const row = document.createElement("div")
      row.setAttribute("data-event-id", id)
      row.getBoundingClientRect = () => rect(positions[id].top, positions[id].bottom)
      container.appendChild(row)
    }

    const events = [
      { id: "e0", sequence: "0", eventType: "message_created" },
      { id: "e1", sequence: "1", eventType: "message_created" },
      { id: "e2", sequence: "2", eventType: "message_created" },
    ] as unknown as StreamEvent[]

    const { result } = renderHook(() =>
      useLastSeenEvent({
        scrollContainerRef: { current: container },
        events,
        streamId: "stream_1",
        lastReadEventId: "e0",
        enabled: true,
      })
    )

    expect(result.current.lastSeenEventId).toBeUndefined()
  })

  // Trailing chrome (agent-session terminals, command terminals, reactions)
  // renders NO `[data-event-id]` row, so the last loaded index is unreachable by
  // the frontier and by the viewport's bottom row. Before the gate bridged them,
  // every bot reply left atLastRow/tailVisible pinned false: auto-read went
  // permanently partial and the activity heal (gated on tailVisible) was dead.
  function mountWithRows(
    positions: Record<string, { top: number; bottom: number }>,
    events: StreamEvent[],
    lastReadEventId: string | null
  ) {
    const container = document.createElement("div")
    container.getBoundingClientRect = () => rect(0, 100)
    for (const id of Object.keys(positions)) {
      const row = document.createElement("div")
      row.setAttribute("data-event-id", id)
      row.getBoundingClientRect = () => rect(positions[id].top, positions[id].bottom)
      container.appendChild(row)
    }
    return renderHook(() =>
      useLastSeenEvent({
        scrollContainerRef: { current: container },
        events,
        streamId: "stream_1",
        lastReadEventId,
        enabled: true,
      })
    )
  }

  it("counts a full read when the loaded window ends in agent-session chrome that renders no row", () => {
    const { result } = mountWithRows(
      {
        e0: { top: -50, bottom: -10 }, // the read pointer, scrolled above
        e1: { top: 10, bottom: 60 }, // the bot reply — the last rendered row
      },
      [
        { id: "e0", sequence: "0", eventType: "message_created" },
        { id: "e1", sequence: "1", eventType: "message_created" },
        { id: "e2", sequence: "2", eventType: "agent_session:started" },
        { id: "e3", sequence: "3", eventType: "agent_session:completed" },
      ] as unknown as StreamEvent[],
      "e0"
    )

    expect({
      lastSeenEventId: result.current.lastSeenEventId,
      atLastRow: result.current.atLastRow,
      tailVisible: result.current.tailVisible,
    }).toEqual({ lastSeenEventId: "e1", atLastRow: true, tailVisible: true })
  })

  it.each(["reaction_added", "command_completed"])(
    "counts a full read when the window ends in a zero-height %s event",
    (trailingType) => {
      const { result } = mountWithRows(
        {
          e0: { top: -50, bottom: -10 },
          e1: { top: 10, bottom: 60 },
        },
        [
          { id: "e0", sequence: "0", eventType: "message_created" },
          { id: "e1", sequence: "1", eventType: "message_created" },
          { id: "e2", sequence: "2", eventType: trailingType },
        ] as unknown as StreamEvent[],
        "e0"
      )

      expect({
        lastSeenEventId: result.current.lastSeenEventId,
        atLastRow: result.current.atLastRow,
        tailVisible: result.current.tailVisible,
      }).toEqual({ lastSeenEventId: "e1", atLastRow: true, tailVisible: true })
    }
  )

  it("still reports a partial read when a trailing MESSAGE sits below the viewport", () => {
    // The counterpart to the bridging above: a real message at the tail blocks,
    // so auto-read stays partial and the heal stays off.
    const { result } = mountWithRows(
      {
        e0: { top: -50, bottom: -10 },
        e1: { top: 10, bottom: 60 },
        e2: { top: 130, bottom: 180 }, // below the fold — unread content
      },
      [
        { id: "e0", sequence: "0", eventType: "message_created" },
        { id: "e1", sequence: "1", eventType: "message_created" },
        { id: "e2", sequence: "2", eventType: "message_created" },
      ] as unknown as StreamEvent[],
      "e0"
    )

    expect({
      lastSeenEventId: result.current.lastSeenEventId,
      atLastRow: result.current.atLastRow,
      tailVisible: result.current.tailVisible,
    }).toEqual({ lastSeenEventId: "e1", atLastRow: false, tailVisible: false })
  })

  it("drives unreadAboveViewport off the first unread MESSAGE, not the trailing chrome", () => {
    const { result } = mountWithRows(
      {
        e0: { top: -260, bottom: -210 }, // the read pointer
        e1: { top: -180, bottom: -140 }, // an unread message, scrolled off the top
        e2: { top: 10, bottom: 60 }, // what the viewer is looking at
      },
      [
        { id: "e0", sequence: "0", eventType: "message_created" },
        { id: "e1", sequence: "1", eventType: "message_created" },
        { id: "e2", sequence: "2", eventType: "message_created" },
        { id: "e3", sequence: "3", eventType: "agent_session:completed" },
      ] as unknown as StreamEvent[],
      "e0"
    )

    expect({
      unreadAboveViewport: result.current.unreadAboveViewport,
      atLastRow: result.current.atLastRow,
    }).toEqual({ unreadAboveViewport: true, atLastRow: false })
  })

  it("clears unreadAboveViewport once the last unread MESSAGE is read, trailing chrome notwithstanding", () => {
    const { result } = mountWithRows(
      {
        e0: { top: -50, bottom: -10 },
        e1: { top: 10, bottom: 60 },
      },
      [
        { id: "e0", sequence: "0", eventType: "message_created" },
        { id: "e1", sequence: "1", eventType: "message_created" },
        { id: "e2", sequence: "2", eventType: "agent_session:completed" },
      ] as unknown as StreamEvent[],
      "e0"
    )

    expect(result.current.unreadAboveViewport).toBe(false)
  })

  it("re-arms the scan when the virtualized scroller late-mounts after enabled (scrollContainerEl)", () => {
    // The bug behind the stuck-unread divider: the virtualized timeline flips
    // `enabled` true BEFORE virtua mounts its scroller (a ref callback). The
    // attach effect must re-run when the element finally mounts — a ref change
    // alone never re-runs an effect, so a viewport-fitting stream (no scroll to
    // re-trigger a scan) would leave its frontier stuck and the divider red.
    const positions: Record<string, { top: number; bottom: number }> = {
      e0: { top: -50, bottom: -10 }, // already read, scrolled above
      e1: { top: 10, bottom: 55 }, // visible
      e2: { top: 60, bottom: 95 }, // visible (short stream fits the viewport)
    }

    const container = document.createElement("div")
    container.getBoundingClientRect = () => rect(0, 100)
    for (const id of Object.keys(positions)) {
      const row = document.createElement("div")
      row.setAttribute("data-event-id", id)
      row.getBoundingClientRect = () => rect(positions[id].top, positions[id].bottom)
      container.appendChild(row)
    }

    const events = [
      { id: "e0", sequence: "0", eventType: "message_created" },
      { id: "e1", sequence: "1", eventType: "message_created" },
      { id: "e2", sequence: "2", eventType: "message_created" },
    ] as unknown as StreamEvent[]
    // The ref starts null (scroller not mounted) and is populated by virtua's ref
    // callback when it mounts — mirrored here by mutating `.current`.
    const scrollContainerRef: { current: HTMLElement | null } = { current: null }

    const { result, rerender } = renderHook(
      ({ el }) =>
        useLastSeenEvent({
          scrollContainerRef,
          scrollContainerEl: el,
          events,
          streamId: "stream_1",
          lastReadEventId: "e0",
          enabled: true,
        }),
      { initialProps: { el: null as HTMLElement | null } }
    )

    // Scroller not mounted yet → nothing to scan, frontier can't advance.
    expect(result.current.lastSeenEventId).toBeUndefined()

    // Virtua mounts the scroller: the ref goes live AND the element surfaces as
    // reactive state. The element dep is what re-runs the attach effect; mutating
    // the ref alone (no element change) would not, which is the original bug.
    act(() => {
      scrollContainerRef.current = container
      rerender({ el: container })
    })

    // Re-armed: the frontier advances to the trailing visible row, so auto-read
    // can fire and the divider clears.
    expect(result.current.lastSeenEventId).toBe("e2")
    expect(result.current.atLastRow).toBe(true)
  })

  it("advances to the trailing unread row when armed after the cold-load settle parks the tail", () => {
    // The opened-fresh-at-bottom bug: the virtualized list parks at the live
    // bottom over several settle frames. If read-tracking arms mid-settle the
    // scan reads a not-yet-parked viewport and, with no guaranteed re-scan once
    // the settle converges, the trailing unread row stays out of the frontier and
    // never auto-reads. The component now holds `enabled` false until the settle
    // completes; this pins the contract that scope relies on — arming with the
    // tail already on screen advances the frontier to the last row so auto-read
    // fires (and the push/divider clear). e0 is the viewer's read pointer, e1 the
    // single trailing unread (mirrors "oh, nice").
    const positions: Record<string, { top: number; bottom: number }> = {
      e0: { top: 35, bottom: 65 }, // read pointer, visible above the tail
      e1: { top: 65, bottom: 95 }, // the trailing unread row, parked above the composer
    }

    const container = document.createElement("div")
    container.getBoundingClientRect = () => rect(0, 100)
    for (const id of Object.keys(positions)) {
      const row = document.createElement("div")
      row.setAttribute("data-event-id", id)
      row.getBoundingClientRect = () => rect(positions[id].top, positions[id].bottom)
      container.appendChild(row)
    }

    const events = [
      { id: "e0", sequence: "0", eventType: "message_created" },
      { id: "e1", sequence: "1", eventType: "message_created" },
    ] as unknown as StreamEvent[]
    const scrollContainerRef = { current: container }

    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useLastSeenEvent({ scrollContainerRef, events, streamId: "stream_1", lastReadEventId: "e0", enabled }),
      { initialProps: { enabled: false } }
    )

    // Still settling → not armed, frontier can't advance.
    expect(result.current.lastSeenEventId).toBeUndefined()
    expect(result.current.atLastRow).toBe(false)

    // Settle complete: the tail is parked on screen and tracking arms.
    act(() => rerender({ enabled: true }))

    // The frontier advances to the trailing row, so auto-read fires for it.
    expect(result.current.lastSeenEventId).toBe("e1")
    expect(result.current.atLastRow).toBe(true)
  })

  it("sweeps from the landing row when a gesture moved the viewport off it before tracking armed", () => {
    // Unread-marker landing: e1 (the first unread) was placed at the top behind
    // the settle mask; a wheel before the reveal moved the viewport down to
    // e3..e4 and aborted the refine loop. Without the seed the first scan sees a
    // gap (e1..e2 never scanned) and the read-through marks nothing.
    const positions: Record<string, { top: number; bottom: number }> = {
      e0: { top: -130, bottom: -100 }, // read pointer, scrolled off above
      e1: { top: -100, bottom: -70 }, // first unread — the landing row
      e2: { top: -70, bottom: -40 },
      e3: { top: 10, bottom: 40 },
      e4: { top: 40, bottom: 70 },
      e5: { top: 130, bottom: 160 }, // below the viewport
    }
    const container = document.createElement("div")
    container.getBoundingClientRect = () => rect(0, 100)
    for (const id of Object.keys(positions)) {
      const row = document.createElement("div")
      row.setAttribute("data-event-id", id)
      row.getBoundingClientRect = () => rect(positions[id].top, positions[id].bottom)
      container.appendChild(row)
    }
    const events = Object.keys(positions).map((id, i) => ({
      id,
      sequence: String(i),
      eventType: "message_created",
    })) as unknown as StreamEvent[]
    const scrollContainerRef = { current: container }
    // The landing's refine loop stamped its last write before the reveal.
    const programmaticScrollAtRef = { current: performance.now() }
    const sweepOriginRef = { current: "e1" as string | null }

    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useLastSeenEvent({
          scrollContainerRef,
          events,
          streamId: "stream_1",
          lastReadEventId: "e0",
          enabled,
          programmaticScrollAtRef,
          sweepOriginRef,
        }),
      { initialProps: { enabled: false } }
    )
    expect(result.current.lastSeenEventId).toBeUndefined()

    act(() => rerender({ enabled: true }))

    expect(result.current.lastSeenEventId).toBe("e4")
    expect(result.current.atLastRow).toBe(false)
    // Consumed by the arm: a later re-arm starts from a clean baseline.
    expect(sweepOriginRef.current).toBeNull()
  })

  it("treats the same off-landing viewport as a gap when no landing row was handed over", () => {
    const positions: Record<string, { top: number; bottom: number }> = {
      e0: { top: -130, bottom: -100 },
      e1: { top: -100, bottom: -70 },
      e2: { top: -70, bottom: -40 },
      e3: { top: 10, bottom: 40 },
      e4: { top: 40, bottom: 70 },
    }
    const container = document.createElement("div")
    container.getBoundingClientRect = () => rect(0, 100)
    for (const id of Object.keys(positions)) {
      const row = document.createElement("div")
      row.setAttribute("data-event-id", id)
      row.getBoundingClientRect = () => rect(positions[id].top, positions[id].bottom)
      container.appendChild(row)
    }
    const events = Object.keys(positions).map((id, i) => ({
      id,
      sequence: String(i),
      eventType: "message_created",
    })) as unknown as StreamEvent[]
    const scrollContainerRef = { current: container }

    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useLastSeenEvent({ scrollContainerRef, events, streamId: "stream_1", lastReadEventId: "e0", enabled }),
      { initialProps: { enabled: false } }
    )
    act(() => rerender({ enabled: true }))

    expect(result.current.lastSeenEventId).toBeUndefined()
    expect(result.current.unreadAboveViewport).toBe(true)
  })

  it("does not re-read a still-visible row when the read pointer moves backward (mark-as-unread), until a scroll", () => {
    // A short, fully-read stream: every row is on screen and the pointer is at
    // the tail (e3). Marking e2 unread moves the pointer back to e1 while e2 is
    // still visible — the frontier must NOT auto-advance back to the tail (which
    // would let auto-mark immediately re-read it). A real scroll resumes it.
    const positions: Record<string, { top: number; bottom: number }> = {
      e0: { top: 5, bottom: 30 },
      e1: { top: 30, bottom: 55 },
      e2: { top: 55, bottom: 80 },
      e3: { top: 80, bottom: 98 },
    }

    const container = document.createElement("div")
    container.getBoundingClientRect = () => rect(0, 100)
    for (const id of Object.keys(positions)) {
      const row = document.createElement("div")
      row.setAttribute("data-event-id", id)
      row.getBoundingClientRect = () => rect(positions[id].top, positions[id].bottom)
      container.appendChild(row)
    }

    const events = [
      { id: "e0", sequence: "0", eventType: "message_created" },
      { id: "e1", sequence: "1", eventType: "message_created" },
      { id: "e2", sequence: "2", eventType: "message_created" },
      { id: "e3", sequence: "3", eventType: "message_created" },
    ] as unknown as StreamEvent[]
    const scrollContainerRef = { current: container }

    const { result, rerender } = renderHook(
      ({ lastReadEventId }) =>
        useLastSeenEvent({ scrollContainerRef, events, streamId: "stream_1", lastReadEventId, enabled: true }),
      { initialProps: { lastReadEventId: "e3" as string | null } }
    )

    // Fully read: pointer at the tail, nothing to emit.
    expect(result.current.lastSeenEventId).toBeUndefined()
    expect(result.current.atLastRow).toBe(true)

    // Mark e2 unread → the pointer lands on e1.
    act(() => rerender({ lastReadEventId: "e1" }))

    // The frontier is pinned at e1; e3 must NOT be emitted as seen even though it
    // is still on screen, so auto-mark won't undo the unread.
    expect(result.current.lastSeenEventId).toBeUndefined()
    expect(result.current.atLastRow).toBe(false)

    // A genuine user scroll lifts the pin and normal advancement resumes.
    act(() => {
      container.dispatchEvent(new Event("scroll"))
    })
    expect(result.current.lastSeenEventId).toBe("e3")
    expect(result.current.atLastRow).toBe(true)
  })

  it("pins when the read pointer clears to null (marking the only message unread)", () => {
    // A single-message stream that's been read. Marking it unread sets the
    // pointer to null (no previous message) — readIndex becomes -1. The frontier
    // must still pull back and pin so the visible row isn't instantly re-read.
    const positions: Record<string, { top: number; bottom: number }> = {
      e0: { top: 10, bottom: 60 },
    }

    const container = document.createElement("div")
    container.getBoundingClientRect = () => rect(0, 100)
    const row = document.createElement("div")
    row.setAttribute("data-event-id", "e0")
    row.getBoundingClientRect = () => rect(positions.e0.top, positions.e0.bottom)
    container.appendChild(row)

    const events = [{ id: "e0", sequence: "0", eventType: "message_created" }] as unknown as StreamEvent[]
    const scrollContainerRef = { current: container }

    const { result, rerender } = renderHook(
      ({ lastReadEventId }) =>
        useLastSeenEvent({ scrollContainerRef, events, streamId: "stream_1", lastReadEventId, enabled: true }),
      { initialProps: { lastReadEventId: "e0" as string | null } }
    )

    // Read: pointer at the only message, nothing to emit.
    expect(result.current.lastSeenEventId).toBeUndefined()
    expect(result.current.atLastRow).toBe(true)

    // Mark it unread → pointer clears to null.
    act(() => rerender({ lastReadEventId: null }))

    // Pinned: e0 must NOT be emitted as seen even though it's on screen.
    expect(result.current.lastSeenEventId).toBeUndefined()
    expect(result.current.atLastRow).toBe(false)

    // A user scroll resumes normal advancement.
    act(() => {
      container.dispatchEvent(new Event("scroll"))
    })
    expect(result.current.lastSeenEventId).toBe("e0")
    expect(result.current.atLastRow).toBe(true)
  })

  it("does not re-pin when the lagging read pointer catches up below the advanced frontier", () => {
    // The frontier legitimately leads the read pointer while reading (it advances
    // on scroll; the markAsRead round-trip lags). When the pointer then catches up
    // to a value still below the frontier, that is NOT a retreat and must not pin —
    // otherwise auto-read freezes after a mark-unread.
    const positions: Record<string, { top: number; bottom: number }> = {
      e0: { top: 5, bottom: 23 },
      e1: { top: 23, bottom: 41 },
      e2: { top: 41, bottom: 59 },
      e3: { top: 59, bottom: 77 },
      e4: { top: 77, bottom: 95 },
    }

    const container = document.createElement("div")
    container.getBoundingClientRect = () => rect(0, 100)
    for (const id of Object.keys(positions)) {
      const row = document.createElement("div")
      row.setAttribute("data-event-id", id)
      row.getBoundingClientRect = () => rect(positions[id].top, positions[id].bottom)
      container.appendChild(row)
    }

    const events = [
      { id: "e0", sequence: "0", eventType: "message_created" },
      { id: "e1", sequence: "1", eventType: "message_created" },
      { id: "e2", sequence: "2", eventType: "message_created" },
      { id: "e3", sequence: "3", eventType: "message_created" },
      { id: "e4", sequence: "4", eventType: "message_created" },
    ] as unknown as StreamEvent[]
    const scrollContainerRef = { current: container }

    const { result, rerender } = renderHook(
      ({ lastReadEventId }) =>
        useLastSeenEvent({ scrollContainerRef, events, streamId: "stream_1", lastReadEventId, enabled: true }),
      { initialProps: { lastReadEventId: "e0" as string | null } }
    )

    // All rows visible and contiguous → frontier runs to the last row, ahead of
    // the pointer (still at e0).
    expect(result.current.lastSeenEventId).toBe("e4")
    expect(result.current.atLastRow).toBe(true)

    // The pointer catches up to e2 — forward, but below the frontier (e4). No pin:
    // the frontier stays at the last row and atLastRow remains true.
    act(() => rerender({ lastReadEventId: "e2" }))
    expect(result.current.atLastRow).toBe(true)
    expect(result.current.lastSeenEventId).toBe("e4")
  })

  it("rolls lastSeenEventId back to undefined when the read pointer retreats (mark-as-unread)", () => {
    // The core auto-mark bug: lastSeenEventId used to be a forward-only latch, so
    // after a backward pointer move it stayed at the old high value and auto-mark
    // re-fired it, undoing the mark-as-unread. It must roll back to undefined when
    // the pointer is pulled to/below the frontier.
    const positions: Record<string, { top: number; bottom: number }> = {
      e0: { top: 5, bottom: 23 },
      e1: { top: 23, bottom: 41 },
      e2: { top: 41, bottom: 59 },
      e3: { top: 59, bottom: 77 },
      e4: { top: 77, bottom: 95 },
    }

    const container = document.createElement("div")
    container.getBoundingClientRect = () => rect(0, 100)
    for (const id of Object.keys(positions)) {
      const row = document.createElement("div")
      row.setAttribute("data-event-id", id)
      row.getBoundingClientRect = () => rect(positions[id].top, positions[id].bottom)
      container.appendChild(row)
    }

    const events = [
      { id: "e0", sequence: "0", eventType: "message_created" },
      { id: "e1", sequence: "1", eventType: "message_created" },
      { id: "e2", sequence: "2", eventType: "message_created" },
      { id: "e3", sequence: "3", eventType: "message_created" },
      { id: "e4", sequence: "4", eventType: "message_created" },
    ] as unknown as StreamEvent[]
    const scrollContainerRef = { current: container }

    const { result, rerender } = renderHook(
      ({ lastReadEventId }) =>
        useLastSeenEvent({ scrollContainerRef, events, streamId: "stream_1", lastReadEventId, enabled: true }),
      { initialProps: { lastReadEventId: "e2" as string | null } }
    )

    // Frontier runs ahead of the pointer (e2) to the last visible row.
    expect(result.current.lastSeenEventId).toBe("e4")

    // Mark-as-unread retreats the pointer to e0. lastSeenEventId must NOT stay at
    // "e4" (which auto-mark would re-fire) — it rolls back to undefined.
    act(() => rerender({ lastReadEventId: "e0" }))
    expect(result.current.lastSeenEventId).toBeUndefined()
  })

  it("re-resolves lastSeenEventId when the trailing row's id is swapped in place (optimistic send reconciled)", () => {
    // The viewer sends their own message: it renders immediately as an
    // optimistic `temp_` row at the bottom, and the frontier advances to it
    // (no gap, viewport covers it). When the server echo lands, the optimistic
    // row is reconciled to its real id in the SAME array slot — same length, no
    // scroll, no resize — so neither the scroll listener nor the ResizeObserver
    // fires. Without depending on `events` itself (not just `.length`), the
    // frontier's index stays correct but `lastSeenEventId` stays pinned to the
    // now-dead `temp_` id forever, and auto-mark-as-read refuses to ever persist
    // a `temp_`-prefixed id — so the viewer's own send never gets marked read.
    const positions: Record<string, { top: number; bottom: number }> = {
      e0: { top: 5, bottom: 50 },
      temp_abc: { top: 50, bottom: 95 },
    }

    const container = document.createElement("div")
    container.getBoundingClientRect = () => rect(0, 100)
    for (const id of Object.keys(positions)) {
      const row = document.createElement("div")
      row.setAttribute("data-event-id", id)
      row.getBoundingClientRect = () => rect(positions[id].top, positions[id].bottom)
      container.appendChild(row)
    }

    const optimisticEvents = [
      { id: "e0", sequence: "0", eventType: "message_created" },
      { id: "temp_abc", sequence: "1", eventType: "message_created" },
    ] as unknown as StreamEvent[]
    const scrollContainerRef = { current: container }

    const { result, rerender } = renderHook(
      ({ events }) =>
        useLastSeenEvent({ scrollContainerRef, events, streamId: "stream_1", lastReadEventId: "e0", enabled: true }),
      { initialProps: { events: optimisticEvents } }
    )

    // Frontier advances straight through to the optimistic row.
    expect(result.current.lastSeenEventId).toBe("temp_abc")

    // Server echo reconciles the optimistic row to its real id, same slot, same
    // array length — no scroll or resize accompanies this.
    container.querySelector('[data-event-id="temp_abc"]')!.setAttribute("data-event-id", "evt_real")
    const reconciledEvents = [
      { id: "e0", sequence: "0", eventType: "message_created" },
      { id: "evt_real", sequence: "1", eventType: "message_created" },
    ] as unknown as StreamEvent[]
    act(() => rerender({ events: reconciledEvents }))

    // Must re-resolve to the real id — staying on "temp_abc" would permanently
    // block auto-mark-as-read for this stream.
    expect(result.current.lastSeenEventId).toBe("evt_real")
  })

  it("never lets a relocated aside anchor row drive the frontier — at the viewport bottom or top", () => {
    // Sequence order: e1..e5 then the aside row (created last, anchored on e2).
    // `attachAsideAnchors` renders it right after e2, so by index it is the
    // newest row while on screen it sits among the oldest.
    const events = [
      { id: "e1", sequence: "1", eventType: "message_created" },
      { id: "e2", sequence: "2", eventType: "message_created" },
      { id: "e3", sequence: "3", eventType: "message_created" },
      { id: "e4", sequence: "4", eventType: "message_created" },
      { id: "e5", sequence: "5", eventType: "message_created" },
      { id: "aside", sequence: "6", eventType: "aside:anchored" },
    ] as unknown as StreamEvent[]
    const mount = (positions: Record<string, { top: number; bottom: number }>, lastReadEventId: string) => {
      const container = document.createElement("div")
      container.getBoundingClientRect = () => rect(0, 100)
      for (const id of ["e1", "e2", "aside", "e3", "e4", "e5"]) {
        const row = document.createElement("div")
        row.setAttribute("data-event-id", id)
        row.getBoundingClientRect = () => rect(positions[id].top, positions[id].bottom)
        container.appendChild(row)
      }
      return renderHook(() =>
        useLastSeenEvent({
          scrollContainerRef: { current: container },
          events,
          streamId: "s",
          lastReadEventId,
          enabled: true,
        })
      )
    }

    // Bottom: e2 and the aside row fill the viewport; e3..e5 are below the fold.
    // The aside's index (5) must not become the frontier — e3/e4 were never seen.
    const bottom = mount(
      {
        e1: { top: -50, bottom: -10 },
        e2: { top: 0, bottom: 50 },
        aside: { top: 50, bottom: 70 },
        e3: { top: 110, bottom: 150 },
        e4: { top: 160, bottom: 200 },
        e5: { top: 210, bottom: 250 },
      },
      "e1"
    )
    expect(bottom.result.current.lastSeenEventId).toBe("e2")
    expect(bottom.result.current.atLastRow).toBe(false)

    // Top: the aside row is the topmost visible row above e3/e4, pointer at e2.
    // Its index would read as a gap; skipping it keeps the run contiguous.
    const top = mount(
      {
        e1: { top: -100, bottom: -60 },
        e2: { top: -50, bottom: -10 },
        aside: { top: 0, bottom: 20 },
        e3: { top: 20, bottom: 60 },
        e4: { top: 60, bottom: 100 },
        e5: { top: 110, bottom: 150 },
      },
      "e2"
    )
    expect(top.result.current.lastSeenEventId).toBe("e4")
    expect(top.result.current.unreadAboveViewport).toBe(false)
  })

  it("ignores foreign rows (the thread parent banner) instead of vetoing the scan", () => {
    // A thread renders its parent message as a timeline row carrying the PARENT
    // stream's event id — never present in the thread's own window. In a short
    // thread that row stays at the top of the viewport forever, so if the scan
    // bails on the unmappable id (instead of skipping the row), the frontier
    // never advances and the thread never auto-reads: the prod ghost-unread bug.
    const positions: Record<string, { top: number; bottom: number }> = {
      parent_evt: { top: 5, bottom: 45 }, // parent-stream event id, not in `events`
      e0: { top: 55, bottom: 95 }, // the thread's only reply — visible
    }

    const container = document.createElement("div")
    container.getBoundingClientRect = () => rect(0, 100)
    for (const id of Object.keys(positions)) {
      const row = document.createElement("div")
      row.setAttribute("data-event-id", id)
      row.getBoundingClientRect = () => rect(positions[id].top, positions[id].bottom)
      container.appendChild(row)
    }

    const events = [{ id: "e0", sequence: "2", eventType: "message_created" }] as unknown as StreamEvent[]
    const scrollContainerRef = { current: container }

    const { result } = renderHook(() =>
      useLastSeenEvent({
        scrollContainerRef,
        events,
        streamId: "stream_thread",
        // A fresh thread member's member_added watermark is remapped to null by
        // StreamContent (it's suppressed from the rendered window): nothing read.
        lastReadEventId: null,
        enabled: true,
      })
    )

    expect(result.current.lastSeenEventId).toBe("e0")
    expect(result.current.atLastRow).toBe(true)
  })

  it("pins a backward read-set that moves an outside-window pointer into the loaded window", () => {
    const container = document.createElement("div")
    container.getBoundingClientRect = () => rect(0, 100)
    const events = ["e0", "e1", "e2"].map((id, index) => ({
      id,
      sequence: String(100 + index),
      eventType: "message_created",
    })) as unknown as StreamEvent[]
    for (const [index, event] of events.entries()) {
      const row = document.createElement("div")
      row.setAttribute("data-event-id", event.id)
      row.getBoundingClientRect = () => rect(5 + index * 30, 30 + index * 30)
      container.appendChild(row)
    }
    const scrollContainerRef = { current: container }

    const { result, rerender } = renderHook(
      ({ lastReadEventId, lastReadSequence }) =>
        useLastSeenEvent({
          scrollContainerRef,
          events,
          streamId: "stream_1",
          lastReadEventId,
          lastReadSequence,
          enabled: true,
        }),
      { initialProps: { lastReadEventId: "newer_outside_window", lastReadSequence: 200n } }
    )

    expect(result.current.lastSeenEventId).toBeUndefined()
    act(() => rerender({ lastReadEventId: "e0", lastReadSequence: 100n }))
    expect(result.current.lastSeenEventId).toBeUndefined()
    expect(result.current.atLastRow).toBe(false)

    act(() => container.dispatchEvent(new Event("scroll")))
    expect(result.current.lastSeenEventId).toBe("e2")
  })

  it("does not emit a mark target while the read pointer sits outside the loaded window", () => {
    // Mark-as-unread on the oldest loaded row moves the pointer to a message below
    // the loaded window, so it is unresolvable in `events`. Emitting the stale
    // frontier would re-mark it read and undo the unread.
    const positions: Record<string, { top: number; bottom: number }> = {
      e0: { top: 5, bottom: 23 },
      e1: { top: 23, bottom: 41 },
      e2: { top: 41, bottom: 59 },
      e3: { top: 59, bottom: 77 },
      e4: { top: 77, bottom: 95 },
    }

    const container = document.createElement("div")
    container.getBoundingClientRect = () => rect(0, 100)
    for (const id of Object.keys(positions)) {
      const row = document.createElement("div")
      row.setAttribute("data-event-id", id)
      row.getBoundingClientRect = () => rect(positions[id].top, positions[id].bottom)
      container.appendChild(row)
    }

    const events = [
      { id: "e0", sequence: "0", eventType: "message_created" },
      { id: "e1", sequence: "1", eventType: "message_created" },
      { id: "e2", sequence: "2", eventType: "message_created" },
      { id: "e3", sequence: "3", eventType: "message_created" },
      { id: "e4", sequence: "4", eventType: "message_created" },
    ] as unknown as StreamEvent[]
    const scrollContainerRef = { current: container }

    const { result, rerender } = renderHook(
      ({ lastReadEventId }) =>
        useLastSeenEvent({ scrollContainerRef, events, streamId: "stream_1", lastReadEventId, enabled: true }),
      { initialProps: { lastReadEventId: "e0" as string | null } }
    )

    expect(result.current.lastSeenEventId).toBe("e4")

    // Pointer moves to a message older than the loaded window (id not in events).
    act(() => rerender({ lastReadEventId: "older_than_window" }))
    expect(result.current.lastSeenEventId).toBeUndefined()
  })

  // The pointer's event is often not in the window: a thread's watermark is born
  // on its hidden member_added event, and the cache may lack the row the
  // watermark names. Resolution goes by sequence so the same rule holds on every
  // surface; an id miss must never read as "unknowable".
  function mountWindow(positions: Record<string, { top: number; bottom: number }>): HTMLDivElement {
    const container = document.createElement("div")
    container.getBoundingClientRect = () => rect(0, 100)
    for (const id of Object.keys(positions)) {
      const row = document.createElement("div")
      row.setAttribute("data-event-id", id)
      row.getBoundingClientRect = () => rect(positions[id].top, positions[id].bottom)
      container.appendChild(row)
    }
    return container
  }
  const seqEvents = (seqs: number[]) =>
    seqs.map((n) => ({ id: `e${n}`, sequence: String(n), eventType: "message_created" })) as unknown as StreamEvent[]

  it("resolves a pointer whose event is missing from a head-loaded window by sequence (born-read hidden member_added)", () => {
    const container = mountWindow({
      e2: { top: 5, bottom: 35 },
      e3: { top: 35, bottom: 65 },
      e4: { top: 65, bottom: 95 },
    })
    const scrollContainerRef = { current: container }

    const { result } = renderHook(() =>
      useLastSeenEvent({
        scrollContainerRef,
        events: seqEvents([2, 3, 4]),
        streamId: "stream_1",
        lastReadEventId: "e_member_added",
        lastReadSequence: 1n,
        hasOlderEvents: false,
        enabled: true,
      })
    )

    expect(result.current.lastSeenEventId).toBe("e4")
    expect(result.current.atLastRow).toBe(true)
  })

  it("keeps a pointer below a window with older pages unloaded unknowable", () => {
    const container = mountWindow({
      e2: { top: 5, bottom: 35 },
      e3: { top: 35, bottom: 65 },
      e4: { top: 65, bottom: 95 },
    })
    const scrollContainerRef = { current: container }

    const { result } = renderHook(() =>
      useLastSeenEvent({
        scrollContainerRef,
        events: seqEvents([2, 3, 4]),
        streamId: "stream_1",
        lastReadEventId: "e_below_window",
        lastReadSequence: 1n,
        hasOlderEvents: true,
        enabled: true,
      })
    )

    expect(result.current.lastSeenEventId).toBeUndefined()
  })

  it("holds a pointer below the window unknowable until older-page knowledge arrives", () => {
    const container = mountWindow({ e2: { top: 5, bottom: 50 } })
    const scrollContainerRef = { current: container }
    const { result, rerender } = renderHook(
      ({ hasOlderEvents }: { hasOlderEvents: boolean | null }) =>
        useLastSeenEvent({
          scrollContainerRef,
          events: seqEvents([2]),
          streamId: "stream_1",
          lastReadEventId: "e_below_window",
          lastReadSequence: 1n,
          hasOlderEvents,
          enabled: true,
        }),
      { initialProps: { hasOlderEvents: null as boolean | null } }
    )
    expect(result.current.lastSeenEventId).toBeUndefined()

    act(() => rerender({ hasOlderEvents: false }))
    expect(result.current.lastSeenEventId).toBe("e2")
  })

  it("resumes after a transient backward pointer flap without a scroll (stale snapshot, not an unread)", () => {
    // The pointer is read from two sources that settle at different times: the
    // read response advances the query cache to seq 2, then the stream
    // bootstrap's stale IDB row (seq 1) publishes, then the response's own row
    // (seq 2). Nobody marked anything unread, so once the pointer is back at 2
    // and the reply below it (e3) is on screen, the reply must still be read.
    const container = mountWindow({ e2: { top: 5, bottom: 50 } })
    const scrollContainerRef = { current: container }
    type Props = { events: StreamEvent[]; lastReadEventId: string; lastReadSequence: bigint }
    const { result, rerender } = renderHook(
      ({ events, lastReadEventId, lastReadSequence }: Props) =>
        useLastSeenEvent({
          scrollContainerRef,
          events,
          streamId: "stream_1",
          lastReadEventId,
          lastReadSequence,
          hasOlderEvents: false,
          enabled: true,
        }),
      { initialProps: { events: seqEvents([2]), lastReadEventId: "e1", lastReadSequence: 1n } }
    )
    expect(result.current.lastSeenEventId).toBe("e2")

    act(() => rerender({ events: seqEvents([2]), lastReadEventId: "e2", lastReadSequence: 2n }))
    expect(result.current.lastSeenEventId).toBeUndefined()

    act(() => rerender({ events: seqEvents([2]), lastReadEventId: "e1", lastReadSequence: 1n }))
    expect(result.current.lastSeenEventId).toBeUndefined()

    const reply = document.createElement("div")
    reply.setAttribute("data-event-id", "e3")
    reply.getBoundingClientRect = () => rect(50, 95)
    container.appendChild(reply)
    act(() => rerender({ events: seqEvents([1, 2, 3]), lastReadEventId: "e2", lastReadSequence: 2n }))
    expect(result.current.lastSeenEventId).toBe("e3")
  })

  it("resolves a pointer between loaded rows to the last row at or below it", () => {
    // e2 is scrolled off the top; the viewport starts at e4. With the pointer
    // resolved to e2 the viewport is contiguous with it and reads through to e6.
    // Resolved to "nothing read" instead, e2 would be an unseen gap and nothing
    // would be emitted.
    const container = mountWindow({
      e2: { top: -40, bottom: -10 },
      e4: { top: 5, bottom: 50 },
      e6: { top: 50, bottom: 95 },
    })
    const scrollContainerRef = { current: container }

    const { result } = renderHook(() =>
      useLastSeenEvent({
        scrollContainerRef,
        events: seqEvents([2, 4, 6]),
        streamId: "stream_1",
        lastReadEventId: "e_hidden_3",
        lastReadSequence: 3n,
        hasOlderEvents: false,
        enabled: true,
      })
    )

    expect(result.current.lastSeenEventId).toBe("e6")
  })
})
