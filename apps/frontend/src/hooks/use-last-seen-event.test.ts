import { describe, it, expect } from "vitest"
import { pickVisibleRange, advanceFrontier, type VisibleRow } from "./use-last-seen-event"

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
