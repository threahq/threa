import { describe, it, expect } from "vitest"
import { pickBottomSeenId, type VisibleRow } from "./use-last-seen-event"

// Viewport spans y=0..100. Rows are in chronological (DOM) order.
const VIEWPORT_TOP = 0
const VIEWPORT_BOTTOM = 100

function pick(rows: VisibleRow[]): string | null {
  return pickBottomSeenId(rows, VIEWPORT_TOP, VIEWPORT_BOTTOM)
}

describe("pickBottomSeenId", () => {
  it("returns the bottom-most row whose top has entered the viewport", () => {
    const rows: VisibleRow[] = [
      { id: "a", top: 10, bottom: 40 },
      { id: "b", top: 40, bottom: 70 },
      { id: "c", top: 70, bottom: 95 },
    ]
    expect(pick(rows)).toBe("c")
  })

  it("ignores rows entirely below the viewport (not yet seen)", () => {
    const rows: VisibleRow[] = [
      { id: "a", top: 10, bottom: 60 },
      { id: "b", top: 60, bottom: 99 },
      // Below the fold — top has not crossed the viewport bottom.
      { id: "c", top: 120, bottom: 180 },
      { id: "d", top: 180, bottom: 240 },
    ]
    expect(pick(rows)).toBe("b")
  })

  it("counts a row taller than the viewport as seen once its top scrolls past", () => {
    const rows: VisibleRow[] = [
      { id: "a", top: -50, bottom: 200 }, // top above viewport, spans whole screen
    ]
    expect(pick(rows)).toBe("a")
  })

  it("ignores rows scrolled entirely above the viewport top", () => {
    const rows: VisibleRow[] = [
      { id: "a", top: -80, bottom: -10 }, // fully above
      { id: "b", top: 5, bottom: 50 },
    ]
    expect(pick(rows)).toBe("b")
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

  it("picks the last row when the whole window fits in the viewport", () => {
    const rows: VisibleRow[] = [
      { id: "a", top: 0, bottom: 20 },
      { id: "b", top: 20, bottom: 40 },
      { id: "c", top: 40, bottom: 60 },
    ]
    expect(pick(rows)).toBe("c")
  })
})
