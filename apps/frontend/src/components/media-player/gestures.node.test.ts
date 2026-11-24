import { describe, it, expect } from "vitest"
import { NUDGE_CHAIN_MS, isNudgeChainActive, nextNudgeChain, tapZone, zoneDirection } from "./gestures"

describe("nextNudgeChain", () => {
  it("accumulates same-direction nudges inside the window", () => {
    const first = nextNudgeChain(null, 1, 10, 0)
    const second = nextNudgeChain(first, 1, 10, 500)
    const third = nextNudgeChain(second, 1, 10, 500 + NUDGE_CHAIN_MS)
    expect([first, second, third]).toEqual([
      { direction: 1, totalSeconds: 10, lastAt: 0 },
      { direction: 1, totalSeconds: 20, lastAt: 500 },
      { direction: 1, totalSeconds: 30, lastAt: 500 + NUDGE_CHAIN_MS },
    ])
  })

  it("starts a new chain after the window lapses", () => {
    const first = nextNudgeChain(null, -1, 10, 0)
    expect(nextNudgeChain(first, -1, 10, NUDGE_CHAIN_MS + 1)).toEqual({
      direction: -1,
      totalSeconds: 10,
      lastAt: NUDGE_CHAIN_MS + 1,
    })
  })

  it("starts a new chain when the direction flips", () => {
    const first = nextNudgeChain(nextNudgeChain(null, 1, 10, 0), 1, 10, 100)
    expect(nextNudgeChain(first, -1, 10, 200)).toEqual({ direction: -1, totalSeconds: 10, lastAt: 200 })
  })

  it("reports whether a chain is still open", () => {
    const chain = nextNudgeChain(null, 1, 5, 1000)
    expect([
      isNudgeChainActive(null, 1000),
      isNudgeChainActive(chain, 1000 + NUDGE_CHAIN_MS),
      isNudgeChainActive(chain, 1001 + NUDGE_CHAIN_MS),
    ]).toEqual([false, true, false])
  })
})

describe("tapZone", () => {
  it("splits the surface into thirds", () => {
    expect([tapZone(0, 300), tapZone(99, 300), tapZone(150, 300), tapZone(201, 300), tapZone(300, 300)]).toEqual([
      "left",
      "left",
      "center",
      "right",
      "right",
    ])
  })

  it("treats an unmeasured surface as center", () => {
    expect(tapZone(10, 0)).toBe("center")
  })

  it("maps side zones to nudge directions", () => {
    expect([zoneDirection("left"), zoneDirection("center"), zoneDirection("right")]).toEqual([-1, null, 1])
  })
})
