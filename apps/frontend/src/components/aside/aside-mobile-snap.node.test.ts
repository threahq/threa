import { describe, expect, it } from "vitest"
import {
  ASIDE_DISMISS_HEIGHT,
  asideMobileHeight,
  asideMobileSteps,
  nearestAsideDetent,
  steppedAsideDetent,
} from "./aside-mobile-snap"

const VIEWPORT = 800

describe("aside mobile snap", () => {
  it("rests at the floor, the peek and the whole viewport", () => {
    expect(asideMobileSteps(VIEWPORT)).toEqual([ASIDE_DISMISS_HEIGHT, 360, VIEWPORT])
    expect(asideMobileHeight("closed", VIEWPORT)).toBe(ASIDE_DISMISS_HEIGHT)
    expect(asideMobileHeight("peek", VIEWPORT)).toBe(360)
    expect(asideMobileHeight("full", VIEWPORT)).toBe(VIEWPORT)
  })

  it("settles on the nearest detent when the drag stops", () => {
    expect(nearestAsideDetent(80, 0, VIEWPORT)).toBe("closed")
    expect(nearestAsideDetent(340, 0, VIEWPORT)).toBe("peek")
    expect(nearestAsideDetent(700, 0, VIEWPORT)).toBe("full")
  })

  it("advances a detent on a flick, in the flick's direction", () => {
    // Barely off the peek, flicked up — the pull counts even though the pointer
    // never travelled to fullscreen.
    expect(nearestAsideDetent(380, 1.2, VIEWPORT)).toBe("full")
    expect(nearestAsideDetent(340, -1.2, VIEWPORT)).toBe("closed")
  })

  it("dismisses when the sheet is dragged to the floor — an aside is left, not parked", () => {
    expect(nearestAsideDetent(ASIDE_DISMISS_HEIGHT, 0, VIEWPORT)).toBe("closed")
  })

  it("steps one detent at a time for the keyboard, clamped at both ends", () => {
    expect(steppedAsideDetent("peek", 1)).toBe("full")
    expect(steppedAsideDetent("peek", -1)).toBe("closed")
    expect(steppedAsideDetent("full", 1)).toBe("full")
    expect(steppedAsideDetent("closed", -1)).toBe("closed")
  })
})
