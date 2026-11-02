import { describe, it, expect } from "vitest"
import {
  placeSelectionPill,
  clampToBounds,
  isSelectionVisible,
  HANDLE_CLEARANCE_PX,
  type Box,
  type PlacementInput,
} from "./selection-pill-placement"

const SIZE = { width: 180, height: 44 }

/** The drawer's scrollable region on a phone, already clear of the reserved band. */
const BOUNDS: Box = { top: 120, bottom: 700, left: 0, right: 400 }

function line(top: number, left = 100, right = 300, height = 20): Box {
  return { top, bottom: top + height, left, right }
}

function input(overrides: Partial<PlacementInput> = {}): PlacementInput {
  const last = line(300)
  return { last, union: last, size: SIZE, bounds: BOUNDS, ...overrides }
}

describe("placeSelectionPill", () => {
  it("goes below the selection, clear of the drag handles, centred on the range", () => {
    const last = line(300, 100, 300)
    expect(placeSelectionPill(input({ last, union: last }))).toEqual({
      top: 320 + HANDLE_CLEARANCE_PX,
      left: 200 - SIZE.width / 2,
    })
  })

  it("measures below from the last line of a multi-line selection", () => {
    const union: Box = { top: 300, bottom: 380, left: 40, right: 360 }
    expect(placeSelectionPill(input({ last: line(360), union })).top).toBe(380 + HANDLE_CLEARANCE_PX)
  })

  it("parks at the floor when the selection runs out of room below it", () => {
    const last = line(670)
    const union: Box = { top: 300, bottom: 690, left: 100, right: 300 }
    expect(placeSelectionPill(input({ last, union }))).toEqual({
      top: BOUNDS.bottom - SIZE.height,
      left: 200 - SIZE.width / 2,
    })
  })

  it("clamps to the left edge rather than centring off-screen", () => {
    const last = line(300, 0, 20)
    expect(placeSelectionPill(input({ last, union: last })).left).toBe(12)
  })

  it("clamps to the right edge rather than centring off-screen", () => {
    const last = line(300, 380, 400)
    expect(placeSelectionPill(input({ last, union: last })).left).toBe(400 - 12 - SIZE.width)
  })

  it("never places inside the reserved bottom band", () => {
    for (const top of [200, 400, 600, BOUNDS.bottom - 30, BOUNDS.bottom + 50]) {
      const last = line(top)
      const placed = placeSelectionPill(input({ last, union: last }))
      expect(placed.top + SIZE.height).toBeLessThanOrEqual(BOUNDS.bottom)
      expect(placed.top).toBeGreaterThanOrEqual(BOUNDS.top)
    }
  })
})

describe("isSelectionVisible", () => {
  it("is false once the selection has scrolled clear of the readable area", () => {
    expect(isSelectionVisible(line(400), BOUNDS)).toBe(true)
    expect(isSelectionVisible(line(20), BOUNDS)).toBe(false)
    expect(isSelectionVisible(line(760), BOUNDS)).toBe(false)
    expect(isSelectionVisible(line(110), BOUNDS)).toBe(true)
  })
})

describe("clampToBounds", () => {
  it("pulls a parked point back inside on every edge", () => {
    expect(clampToBounds({ top: -400, left: -400 }, SIZE, BOUNDS)).toEqual({ top: 120, left: 12 })
    expect(clampToBounds({ top: 9999, left: 9999 }, SIZE, BOUNDS)).toEqual({
      top: BOUNDS.bottom - SIZE.height,
      left: 400 - 12 - SIZE.width,
    })
  })

  it("leaves a point that already fits alone", () => {
    expect(clampToBounds({ top: 400, left: 100 }, SIZE, BOUNDS)).toEqual({ top: 400, left: 100 })
  })
})
