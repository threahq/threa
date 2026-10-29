import { describe, it, expect } from "vitest"
import {
  anchorSurfaceAtPointer,
  clampSquareToViewport,
  placementOverlapsProtected,
  resolveAvoidanceOffset,
  type FloatingSurfaceGeometry,
  type Rect,
} from "./call-surface-geometry"

const VIEWPORT = { width: 1024, height: 768 }

// The ring stack as the browser lays it out: 320px wide, anchored 16px from the
// bottom-right corner. One card is 72px tall, each extra card adds 80px.
function ringStack(cards = 1, viewport = VIEWPORT): Rect {
  const height = cards * 72 + (cards - 1) * 8
  return { x: viewport.width - 16 - 320, y: viewport.height - 16 - height, width: 320, height }
}

// The floating square's interactive groups where its CSS puts them, so the unit
// tests score the same shapes FloatingCallSquare measures at runtime: the whole
// header band (grip, title and action pair are one drag surface), and (connected)
// the centred controls row at the bottom or (joining) the PreJoinGate action block
// centred in the body.
const HEADER_HEIGHT = 45

function headerBand(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: HEADER_HEIGHT }
}

function connectedSquare(rect: Rect): FloatingSurfaceGeometry {
  return {
    rect,
    protectedRects: [headerBand(rect), { x: rect.x + 47, y: rect.y + rect.height - 44, width: 246, height: 36 }],
  }
}

function joiningSquare(rect: Rect): FloatingSurfaceGeometry {
  return {
    rect,
    protectedRects: [
      headerBand(rect),
      { x: rect.x + 54, y: rect.y + 40 + (rect.height - 40) / 2 - 52, width: 232, height: 104 },
    ],
  }
}

function bare(rect: Rect): FloatingSurfaceGeometry {
  return { rect, protectedRects: [] }
}

function shifted(rect: Rect, offset: { x: number; y: number }): Rect {
  return { ...rect, x: rect.x + offset.x, y: rect.y + offset.y }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

function onScreen(rect: Rect, viewport = VIEWPORT, margin = 8): boolean {
  return (
    rect.x >= margin &&
    rect.y >= margin &&
    rect.x + rect.width <= viewport.width - margin &&
    rect.y + rect.height <= viewport.height - margin
  )
}

describe("clampSquareToViewport", () => {
  const size = { width: 200, height: 200 }
  const viewport = { width: 1000, height: 800 }

  it("passes an in-bounds position through unchanged", () => {
    expect(clampSquareToViewport({ x: 100, y: 100 }, size, viewport)).toEqual({ x: 100, y: 100 })
  })

  it("clamps past each edge back to the on-screen bound", () => {
    expect(clampSquareToViewport({ x: -50, y: -50 }, size, viewport)).toEqual({ x: 8, y: 8 })
    expect(clampSquareToViewport({ x: 5000, y: 5000 }, size, viewport)).toEqual({ x: 792, y: 592 })
  })

  it("respects a custom margin", () => {
    expect(clampSquareToViewport({ x: 0, y: 0 }, size, viewport, 20)).toEqual({ x: 20, y: 20 })
    expect(clampSquareToViewport({ x: 9999, y: 9999 }, size, viewport, 20)).toEqual({ x: 780, y: 580 })
  })

  it("clamps to the margin (never negative) when the square is larger than the viewport", () => {
    const big = { width: 2000, height: 2000 }
    expect(clampSquareToViewport({ x: 400, y: 400 }, big, viewport)).toEqual({ x: 8, y: 8 })
    expect(clampSquareToViewport({ x: -400, y: -400 }, big, viewport)).toEqual({ x: 8, y: 8 })
  })
})

describe("anchorSurfaceAtPointer", () => {
  it("centers and clamps a surface at the pointer", () => {
    const size = { width: 200, height: 48 }
    const viewport = { width: 1000, height: 800 }
    expect(anchorSurfaceAtPointer({ x: 500, y: 400 }, size, viewport)).toEqual({ x: 400, y: 376 })
    expect(anchorSurfaceAtPointer({ x: 500, y: 400 }, size, viewport, { x: 180, y: 24 })).toEqual({
      x: 320,
      y: 376,
    })
    expect(anchorSurfaceAtPointer({ x: 10, y: 10 }, size, viewport)).toEqual({ x: 8, y: 8 })
  })
})

describe("resolveAvoidanceOffset", () => {
  it("stays put with no obstacle, no overlap, or a degenerate rect", () => {
    const ring = ringStack()
    expect(resolveAvoidanceOffset(ring, null, VIEWPORT)).toEqual({ x: 0, y: 0 })
    // Clear of the ring by more than the gap.
    expect(resolveAvoidanceOffset(ring, connectedSquare({ x: 40, y: 40, width: 340, height: 320 }), VIEWPORT)).toEqual({
      x: 0,
      y: 0,
    })
    expect(
      resolveAvoidanceOffset(
        { ...ring, width: 0, height: 0 },
        connectedSquare({ x: 676, y: 440, width: 340, height: 320 }),
        VIEWPORT
      )
    ).toEqual({ x: 0, y: 0 })
    expect(resolveAvoidanceOffset(ring, bare({ x: 676, y: 440, width: 0, height: 0 }), VIEWPORT)).toEqual({
      x: 0,
      y: 0,
    })
  })

  it("lifts the ring above a bottom-right expanded square", () => {
    const square = connectedSquare({ x: 676, y: 440, width: 340, height: 320 })
    const ring = ringStack()
    const offset = resolveAvoidanceOffset(ring, square, VIEWPORT)
    expect(offset).toEqual({ x: 0, y: -324 })
    expect(overlaps(shifted(ring, offset), square.rect)).toBe(false)
    expect(onScreen(shifted(ring, offset))).toBe(true)
  })

  it("keeps the gap — a merely adjacent obstacle still displaces the ring", () => {
    const square = connectedSquare({ x: 676, y: 440, width: 340, height: 320 })
    const ring = { x: 688, y: 400, width: 320, height: 32 }
    expect(resolveAvoidanceOffset(ring, square, VIEWPORT)).toEqual({ x: 0, y: -4 })
  })

  it("escapes sideways when a tall square leaves no headroom", () => {
    const tall = connectedSquare({ x: 676, y: 8, width: 340, height: 740 })
    const ring = ringStack()
    const offset = resolveAvoidanceOffset(ring, tall, VIEWPORT)
    expect(offset).toEqual({ x: -344, y: 0 })
    expect(overlaps(shifted(ring, offset), tall.rect)).toBe(false)
    expect(onScreen(shifted(ring, offset))).toBe(true)
  })

  it("drops below, then moves right, when those are the only clear directions", () => {
    const ring = { x: 688, y: 660, width: 320, height: 40 }
    const capping = bare({ x: 8, y: 8, width: 1008, height: 672 })
    expect(resolveAvoidanceOffset(ring, capping, VIEWPORT)).toEqual({ x: 0, y: 32 })

    const leftHalf = bare({ x: 8, y: 8, width: 600, height: 752 })
    const narrowRing = { x: 500, y: 660, width: 160, height: 40 }
    expect(resolveAvoidanceOffset(narrowRing, leftHalf, VIEWPORT)).toEqual({ x: 120, y: 0 })
  })

  it("clears a multi-card stack as one block", () => {
    const square = connectedSquare({ x: 676, y: 440, width: 340, height: 320 })
    const stack = ringStack(3)
    const offset = resolveAvoidanceOffset(stack, square, VIEWPORT)
    expect(overlaps(shifted(stack, offset), square.rect)).toBe(false)
    expect(onScreen(shifted(stack, offset))).toBe(true)
  })

  it("keeps every measured control group clear when nothing fits, over minimizing total overlap", () => {
    // Reachable desktop layout: 640x500 viewport, expanded square parked in its
    // clamped bottom-right home, three stacked ring cards. Every escape direction
    // runs off-screen, so the fallback ranks clamped placements.
    const viewport = { width: 640, height: 500 }
    const square = connectedSquare({ x: 292, y: 172, width: 340, height: 320 })
    const stack = ringStack(3, viewport)
    expect(stack).toEqual({ x: 304, y: 252, width: 320, height: 232 })

    // Clamped "left" (-296, 0) is the only placement that clears both groups:
    // clamped "above" carries less total overlap but rides onto the header band,
    // and staying put lies across the controls row.
    const offset = resolveAvoidanceOffset(stack, square, viewport)
    expect(offset).toEqual({ x: -296, y: 0 })

    const placed = shifted(stack, offset)
    for (const region of square.protectedRects) expect(overlaps(placed, region)).toBe(false)
    expect(onScreen(placed, viewport)).toBe(true)
  })

  it("keeps the header band clear rather than taking the least-overlap placement", () => {
    // 800x700, a tall connected square dragged near the top-left, two ring cards.
    // Nothing fits, and the clamped "above" placement rides up onto the header —
    // grip, title and action pair — a region a fixed bottom-strip guess never
    // protected.
    const viewport = { width: 800, height: 700 }
    const square = connectedSquare({ x: 176, y: 56, width: 340, height: 490 })
    const stack = ringStack(2, viewport)

    const above = { x: 0, y: -524 }
    expect(overlaps(shifted(stack, above), square.protectedRects[0]!)).toBe(true)

    const offset = resolveAvoidanceOffset(stack, square, viewport)
    expect(offset).toEqual({ x: 0, y: 8 })
    const placed = shifted(stack, offset)
    for (const region of square.protectedRects) expect(overlaps(placed, region)).toBe(false)
    expect(onScreen(placed, viewport)).toBe(true)
  })

  it("keeps the joining gate's actions clear — its controls are mid-surface, not at the bottom", () => {
    // Same 800x700 desktop, square still joining (or showing a permission error):
    // the Cancel / Try again block sits centred in the body and the bottom band is
    // empty padding, so protecting a bottom strip protects nothing that exists.
    const viewport = { width: 800, height: 700 }
    const square = joiningSquare({ x: 302, y: 8, width: 340, height: 490 })
    const stack = ringStack(3, viewport)

    const above = { x: 0, y: -444 }
    expect(overlaps(shifted(stack, above), square.protectedRects[1]!)).toBe(true)

    const offset = resolveAvoidanceOffset(stack, square, viewport)
    expect(offset).toEqual({ x: -456, y: 0 })
    const placed = shifted(stack, offset)
    for (const region of square.protectedRects) expect(overlaps(placed, region)).toBe(false)
    expect(onScreen(placed, viewport)).toBe(true)
  })

  it("finds a placement between two groups that box the ring in on different axes", () => {
    // 640x500, the joining square dragged to mid-screen, three stacked ring cards.
    // The header band only clears by moving down, the gate block only by moving
    // left — every single-axis retreat leaves one of them covered, so the fallback
    // has to combine them.
    const viewport = { width: 640, height: 500 }
    const square = joiningSquare({ x: 276, y: 208, width: 340, height: 240 })
    const stack = ringStack(3, viewport)
    expect(stack).toEqual({ x: 304, y: 252, width: 320, height: 232 })

    // Exhaustive, not a sample: no on-screen placement that moves one axis alone
    // clears both groups.
    for (let y = 8; y <= viewport.height - 8 - stack.height; y++) {
      expect(square.protectedRects.some((region) => overlaps({ ...stack, y }, region))).toBe(true)
    }
    for (let x = 8; x <= viewport.width - 8 - stack.width; x++) {
      expect(square.protectedRects.some((region) => overlaps({ ...stack, x }, region))).toBe(true)
    }

    const offset = resolveAvoidanceOffset(stack, square, viewport)
    expect(offset).toEqual({ x: -296, y: 8 })
    const placed = shifted(stack, offset)
    for (const region of square.protectedRects) expect(overlaps(placed, region)).toBe(false)
    expect(onScreen(placed, viewport)).toBe(true)
  })

  it("threads the ring between groups when no whole-obstacle retreat clears them", () => {
    // Three marked groups (the count is whatever the surface's DOM reports): a
    // tall right-hand group, a small top group, and a band across the body. Every
    // whole-obstacle retreat clamps to a screen edge and lands on one of them, so
    // only a placement derived from the groups' own edges clears all three.
    const viewport = { width: 800, height: 700 }
    const square: FloatingSurfaceGeometry = {
      rect: { x: 290, y: 8, width: 260, height: 500 },
      protectedRects: [
        { x: 300, y: 378, width: 200, height: 120 },
        { x: 300, y: 8, width: 40, height: 32 },
        { x: 502, y: 8, width: 40, height: 120 },
      ],
    }
    const stack = ringStack(4, viewport)

    for (const corner of [
      { x: 8, y: 8 },
      { x: 8, y: 380 },
      { x: 472, y: 8 },
      { x: 472, y: 380 },
    ]) {
      const at = { ...stack, ...corner }
      expect(square.protectedRects.some((region) => overlaps(at, region))).toBe(true)
    }

    const offset = resolveAvoidanceOffset(stack, square, viewport)
    const placed = shifted(stack, offset)
    expect(placed).toEqual({ x: 8, y: 54, width: 320, height: 312 })
    for (const region of square.protectedRects) expect(overlaps(placed, region)).toBe(false)
    expect(onScreen(placed, viewport)).toBe(true)
  })

  it("stays put on a tie rather than translating the ring for nothing", () => {
    // Obstacle fills the whole safe area: every clamped candidate lands on the
    // identical fully-overlapped rect, so the stay-put seed must hold.
    const viewport = { width: 400, height: 400 }
    const square = connectedSquare({ x: 8, y: 8, width: 384, height: 384 })
    const ring = { x: 8, y: 8, width: 384, height: 384 }
    expect(resolveAvoidanceOffset(ring, square, viewport)).toEqual({ x: 0, y: 0 })
  })

  it("stays on-screen with the least residual overlap when nothing fits", () => {
    const viewport = { width: 400, height: 400 }
    // No protected groups, so the second-tier total-overlap ranking decides.
    const square = bare({ x: 40, y: 40, width: 320, height: 320 })
    const ring = { x: 60, y: 300, width: 320, height: 72 }
    const offset = resolveAvoidanceOffset(ring, square, viewport)
    expect(offset).toEqual({ x: 0, y: -292 })
    expect(onScreen(shifted(ring, offset), viewport)).toBe(true)
  })
})

describe("placementOverlapsProtected", () => {
  it("reports clear with no obstacle and for a placement that cleared every group", () => {
    const ring = ringStack()
    expect(placementOverlapsProtected(ring, { x: 0, y: 0 }, null)).toBe(false)

    const square = connectedSquare({ x: 676, y: 440, width: 340, height: 320 })
    const offset = resolveAvoidanceOffset(ring, square, VIEWPORT)
    expect(placementOverlapsProtected(ring, offset, square)).toBe(false)
  })

  it("judges the offset it is handed, not the one geometry would prefer", () => {
    const ring = ringStack()
    const square = connectedSquare({ x: 676, y: 440, width: 340, height: 320 })
    // Staying put is what the ring renders if the caller never applies the policy.
    expect(placementOverlapsProtected(ring, { x: 0, y: 0 }, square)).toBe(true)
  })

  it("reports the crowded viewport where no placement clears the controls", () => {
    // 400x400 with an expanded square in its clamped home and four stacked cards:
    // the ring is wider than the gap on either side of the square and taller than
    // the band above it, so every on-screen placement lies across the header.
    const viewport = { width: 400, height: 400 }
    const square = connectedSquare({ x: 52, y: 72, width: 340, height: 320 })
    const stack = ringStack(4, viewport)

    for (let x = 8; x <= viewport.width - 8 - stack.width; x++) {
      for (let y = 8; y <= viewport.height - 8 - stack.height; y++) {
        expect(square.protectedRects.some((region) => overlaps({ ...stack, x, y }, region))).toBe(true)
      }
    }

    const offset = resolveAvoidanceOffset(stack, square, viewport)
    expect(placementOverlapsProtected(stack, offset, square)).toBe(true)
    expect(onScreen(shifted(stack, offset), viewport)).toBe(true)
  })
})
