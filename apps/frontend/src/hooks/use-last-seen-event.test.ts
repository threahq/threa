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
    expect(advanceFrontier(4, 27, 30)).toBe(4)
  })

  it("advances to the bottom of the viewport when contiguous with the frontier", () => {
    // Jumped to the first unread (row 5, frontier+1) and it's at the top; advance
    // through what's on screen.
    expect(advanceFrontier(4, 5, 8)).toBe(8)
  })

  it("advances when the viewport top sits above the frontier (overlap)", () => {
    expect(advanceFrontier(7, 5, 12)).toBe(12)
  })

  it("does not advance when flinging past leaves a gap above the viewport", () => {
    // Frontier at 7, but a fast scroll put rows 20..25 on screen without 8..19
    // ever being visible — they stay unseen.
    expect(advanceFrontier(7, 20, 25)).toBe(7)
  })

  it("does not retract when scrolling back up (bottom below the frontier)", () => {
    expect(advanceFrontier(20, 10, 15)).toBe(20)
  })

  it("treats an exactly-contiguous top (frontier + 1) as no gap", () => {
    expect(advanceFrontier(9, 10, 14)).toBe(14)
  })
})

describe("useLastSeenEvent re-scan on content resize", () => {
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

    const events = [{ id: "e0" }, { id: "e1" }, { id: "e2" }] as unknown as StreamEvent[]
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

    const events = [{ id: "e0" }, { id: "e1" }, { id: "e2" }, { id: "e3" }] as unknown as StreamEvent[]
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
})
