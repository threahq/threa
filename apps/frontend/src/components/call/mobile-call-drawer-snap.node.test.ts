import { describe, it, expect } from "vitest"
import { nearestMode, nearestStep } from "./mobile-call-drawer-snap"

describe("nearestStep — generic detent index", () => {
  // The desktop dock's side widths: rail 56, panel 320, wide 520, full (content) 900.
  const steps = [56, 320, 520, 900]

  it("returns the index of the detent at each resting size", () => {
    expect(nearestStep(56, 0, steps)).toBe(0)
    expect(nearestStep(320, 0, steps)).toBe(1)
    expect(nearestStep(520, 0, steps)).toBe(2)
    expect(nearestStep(900, 0, steps)).toBe(3)
  })

  it("resolves each midpoint to the nearer detent", () => {
    // Midpoints: 56|320 = 188, 320|520 = 420, 520|900 = 710.
    expect(nearestStep(187, 0, steps)).toBe(0)
    expect(nearestStep(189, 0, steps)).toBe(1)
    expect(nearestStep(419, 0, steps)).toBe(1)
    expect(nearestStep(421, 0, steps)).toBe(2)
    expect(nearestStep(709, 0, steps)).toBe(2)
    expect(nearestStep(711, 0, steps)).toBe(3)
  })

  it("a fast grow flick advances one detent past nearest", () => {
    expect(nearestStep(70, 1, steps)).toBe(1)
    expect(nearestStep(520, 1, steps)).toBe(3)
  })

  it("a fast shrink flick drops one detent below nearest", () => {
    expect(nearestStep(500, -1, steps)).toBe(1)
    expect(nearestStep(320, -1, steps)).toBe(0)
  })

  it("clamps at the ends (no flick past the last/first detent)", () => {
    expect(nearestStep(900, 1, steps)).toBe(3)
    expect(nearestStep(56, -1, steps)).toBe(0)
  })

  it("sub-threshold velocity falls back to nearest", () => {
    expect(nearestStep(500, -0.2, steps)).toBe(2)
    expect(nearestStep(120, 0.2, steps)).toBe(0)
  })
})

// Detents (px): min 44, compact 80, standard 248, full-snap 420.
// Midpoints: min|compact 62, compact|standard 164, standard|full 334.

describe("nearestMode — nearest detent (no flick)", () => {
  it("snaps to the detent at each resting height", () => {
    expect(nearestMode(44, 0)).toBe("min")
    expect(nearestMode(80, 0)).toBe("compact")
    expect(nearestMode(248, 0)).toBe("standard")
    expect(nearestMode(500, 0)).toBe("full")
  })

  it("resolves each midpoint to the correct side", () => {
    expect(nearestMode(61, 0)).toBe("min")
    expect(nearestMode(63, 0)).toBe("compact")
    expect(nearestMode(163, 0)).toBe("compact")
    expect(nearestMode(165, 0)).toBe("standard")
    expect(nearestMode(333, 0)).toBe("standard")
    expect(nearestMode(335, 0)).toBe("full")
  })
})

describe("nearestMode — velocity flick bias", () => {
  it("a fast downward flick advances one detent in the drag direction", () => {
    // Near the tab but flicked down fast → jumps up to compact.
    expect(nearestMode(50, 1)).toBe("compact")
    // At standard, flicked down → jumps to full even without dragging all the way.
    expect(nearestMode(248, 1)).toBe("full")
  })

  it("a fast upward flick drops one detent in the drag direction", () => {
    // Near standard, flicked up fast → drops to compact.
    expect(nearestMode(240, -1)).toBe("compact")
    // At compact, flicked up → drops to the tab.
    expect(nearestMode(80, -1)).toBe("min")
  })

  it("velocity below the flick threshold falls back to nearest", () => {
    expect(nearestMode(240, -0.2)).toBe("standard")
    expect(nearestMode(90, 0.2)).toBe("compact")
  })
})
