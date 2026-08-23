import { describe, expect, it } from "vitest"
import {
  ASIDE_TAB_HEIGHT,
  asideMobileHeight,
  asideMobileSteps,
  nearestAsideSurface,
  steppedAsideSurface,
} from "./aside-mobile-snap"

const VIEWPORT = 800

describe("aside mobile snap", () => {
  it("rests at the tab, the peek and the whole viewport", () => {
    expect(asideMobileSteps(VIEWPORT)).toEqual([ASIDE_TAB_HEIGHT, 360, VIEWPORT])
    expect(asideMobileHeight("minimized", VIEWPORT)).toBe(ASIDE_TAB_HEIGHT)
    expect(asideMobileHeight("dock", VIEWPORT)).toBe(360)
    expect(asideMobileHeight("fullscreen", VIEWPORT)).toBe(VIEWPORT)
  })

  it("settles on the nearest surface when the drag stops", () => {
    expect(nearestAsideSurface(80, 0, VIEWPORT)).toBe("minimized")
    expect(nearestAsideSurface(340, 0, VIEWPORT)).toBe("dock")
    expect(nearestAsideSurface(700, 0, VIEWPORT)).toBe("fullscreen")
  })

  it("advances a detent on a flick, in the flick's direction", () => {
    // Barely off the peek, flicked up — the pull counts even though the pointer
    // never travelled to fullscreen.
    expect(nearestAsideSurface(380, 1.2, VIEWPORT)).toBe("fullscreen")
    expect(nearestAsideSurface(340, -1.2, VIEWPORT)).toBe("minimized")
  })

  it("parks in the strip when the sheet is dragged to the floor", () => {
    expect(nearestAsideSurface(ASIDE_TAB_HEIGHT, 0, VIEWPORT)).toBe("minimized")
  })

  it("steps one detent at a time for the keyboard, clamped at both ends", () => {
    expect(steppedAsideSurface("dock", 1)).toBe("fullscreen")
    expect(steppedAsideSurface("dock", -1)).toBe("minimized")
    expect(steppedAsideSurface("fullscreen", 1)).toBe("fullscreen")
    expect(steppedAsideSurface("minimized", -1)).toBe("minimized")
  })
})
