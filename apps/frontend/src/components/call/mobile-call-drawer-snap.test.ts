import { describe, it, expect } from "vitest"
import { nearestMode } from "./mobile-call-drawer-snap"

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
