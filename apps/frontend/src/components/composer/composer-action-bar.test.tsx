import { describe, it, expect } from "vitest"
import { planActionOverflow } from "./composer-action-bar"

// Mirrors the real bar's secondary actions: array order is the left-to-right
// display order; `collapsePriority` (lower folds first) is independent of it.
const ACTIONS = [
  { key: "emoji", collapsePriority: 2 },
  { key: "mention", collapsePriority: 3 },
  { key: "command", collapsePriority: 0 },
  { key: "attach", collapsePriority: 4 },
  { key: "expand", collapsePriority: 1 },
]

const keys = (list: { key: string }[]) => list.map((a) => a.key)

// 5 pinned controls (Aa + Send + mic + stash + schedule) → reserved = 6 * 34 = 204px.
const PINNED = 5

describe("planActionOverflow", () => {
  it("keeps everything inline before the first measurement (width 0)", () => {
    const { inline, overflow } = planActionOverflow(ACTIONS, 0, PINNED)
    expect(keys(inline)).toEqual(keys(ACTIONS))
    expect(overflow).toHaveLength(0)
  })

  it("keeps everything inline on a roomy bar", () => {
    const { inline, overflow } = planActionOverflow(ACTIONS, 2000, PINNED)
    expect(keys(inline)).toEqual(keys(ACTIONS))
    expect(overflow).toHaveLength(0)
  })

  it("folds the lowest-priority actions first as the bar narrows", () => {
    // ~360px: room for 4 inline → only the single lowest priority (command) folds.
    const narrow = planActionOverflow(ACTIONS, 360, PINNED)
    expect(keys(narrow.overflow)).toEqual(["command"])
    expect(keys(narrow.inline)).toEqual(["emoji", "mention", "attach", "expand"])

    // ~300px: room for 2 inline → the three lowest priorities fold.
    const narrower = planActionOverflow(ACTIONS, 300, PINNED)
    expect(new Set(keys(narrower.overflow))).toEqual(new Set(["command", "expand", "emoji"]))
    expect(keys(narrower.inline)).toEqual(["mention", "attach"])
  })

  it("preserves display order within both the inline and overflow lists", () => {
    const { inline, overflow } = planActionOverflow(ACTIONS, 300, PINNED)
    // Each result is a subsequence of the original display order.
    expect(keys(inline)).toEqual(keys(ACTIONS).filter((k) => keys(inline).includes(k)))
    expect(keys(overflow)).toEqual(keys(ACTIONS).filter((k) => keys(overflow).includes(k)))
  })

  it("folds monotonically — a narrower bar never folds fewer actions", () => {
    let previous = 0
    for (const width of [600, 500, 440, 400, 360, 320, 280, 240, 200]) {
      const { overflow } = planActionOverflow(ACTIONS, width, PINNED)
      expect(overflow.length).toBeGreaterThanOrEqual(previous)
      previous = overflow.length
    }
  })

  it("reclaims inline room when fewer controls are pinned", () => {
    // Same width, but no mic/stash/schedule pinned → more space for actions.
    const withPickers = planActionOverflow(ACTIONS, 320, 5)
    const withoutPickers = planActionOverflow(ACTIONS, 320, 2)
    expect(withoutPickers.overflow.length).toBeLessThan(withPickers.overflow.length)
  })
})
