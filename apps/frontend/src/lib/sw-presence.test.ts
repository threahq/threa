import { describe, expect, it } from "vitest"
import { isWithinPresenceWindow, PRESENCE_INTERACTION_WINDOW_MS } from "./sw-presence"

describe("isWithinPresenceWindow", () => {
  const now = 1_000_000_000_000

  it("is present right after an interaction", () => {
    expect(isWithinPresenceWindow(now, now)).toBe(true)
  })

  it("is present just inside the window", () => {
    expect(isWithinPresenceWindow(now - (PRESENCE_INTERACTION_WINDOW_MS - 1), now)).toBe(true)
  })

  it("is not present at exactly the window boundary", () => {
    expect(isWithinPresenceWindow(now - PRESENCE_INTERACTION_WINDOW_MS, now)).toBe(false)
  })

  it("is not present once the window has elapsed (walked-away focused tab)", () => {
    expect(isWithinPresenceWindow(now - (PRESENCE_INTERACTION_WINDOW_MS + 1), now)).toBe(false)
  })

  it("is not present when no interaction was ever recorded", () => {
    expect(isWithinPresenceWindow(null, now)).toBe(false)
  })
})
