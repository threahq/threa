import { describe, expect, it } from "vitest"
import { resolveAsideOpenSurface } from "./surface"

describe("aside surface resolution", () => {
  it("should open into the remembered reading surface, docking by default", () => {
    expect([
      resolveAsideOpenSurface({ remembered: null, callDocked: false }),
      resolveAsideOpenSurface({ remembered: "fullscreen", callDocked: false }),
      resolveAsideOpenSurface({ remembered: "dock", callDocked: false }),
    ]).toEqual(["dock", "fullscreen", "dock"])
  })

  it("should yield the right edge to a docked call by opening fullscreen instead", () => {
    expect([
      resolveAsideOpenSurface({ remembered: null, callDocked: true }),
      resolveAsideOpenSurface({ remembered: "dock", callDocked: true }),
      resolveAsideOpenSurface({ remembered: "fullscreen", callDocked: true }),
    ]).toEqual(["fullscreen", "fullscreen", "fullscreen"])
  })
})
