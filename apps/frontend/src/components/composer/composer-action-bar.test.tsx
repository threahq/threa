import { describe, it, expect } from "vitest"
import { planActionOverflow, planTriggerVisibility } from "./composer-action-bar"

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

describe("planTriggerVisibility", () => {
  it("keeps every trigger before the first measurement (width 0)", () => {
    expect(planTriggerVisibility(0, 3)).toBe(3)
  })

  it("keeps every trigger at roomy and floored widths", () => {
    expect(planTriggerVisibility(800, 3)).toBe(3)
    // ~210px: "+" Aa Send (3 slots) + 3 triggers = 6 slots = 204px → all fit.
    expect(planTriggerVisibility(210, 3)).toBe(3)
  })

  it("drops triggers from the tail only when squeezed past the all-folded minimum", () => {
    // ~170px → 5 slots: 3 reserved (+ Aa Send) leaves room for 2 triggers.
    expect(planTriggerVisibility(170, 3)).toBe(2)
    // ~140px → 4 slots: room for 1 trigger.
    expect(planTriggerVisibility(140, 3)).toBe(1)
    // ~100px → 2 slots: nothing left for triggers, but never negative.
    expect(planTriggerVisibility(100, 3)).toBe(0)
    expect(planTriggerVisibility(40, 3)).toBe(0)
  })

  it("never reports more visible than exist", () => {
    expect(planTriggerVisibility(800, 1)).toBe(1)
    expect(planTriggerVisibility(800, 0)).toBe(0)
  })

  it("the all-folded bar plus visible triggers fits the width (no spill)", () => {
    const CONTROL_PX = 34
    for (const width of [120, 150, 180, 210, 240, 300]) {
      const visible = planTriggerVisibility(width, 3)
      // Worst case: every action folded, so inline = "+" + Aa + Send + visible triggers.
      const inlineControls = 3 + visible
      expect(inlineControls * CONTROL_PX).toBeLessThanOrEqual(width)
    }
  })
})
