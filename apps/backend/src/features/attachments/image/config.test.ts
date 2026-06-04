import { describe, expect, it } from "bun:test"
import { planGifThumbnailFrames } from "./config"

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

describe("planGifThumbnailFrames", () => {
  it("keeps every frame when the source is already under the cap", () => {
    const plan = planGifThumbnailFrames(Array(5).fill(100), 5) // 10fps
    expect(plan.dropped).toBe(false)
    expect(plan.keep).toEqual([0, 1, 2, 3, 4])
    expect(plan.delays).toEqual([100, 100, 100, 100, 100])
  })

  it("drops frames for a high-framerate source while preserving total duration", () => {
    const raw = Array(12).fill(25) // 40fps, 300ms total
    const plan = planGifThumbnailFrames(raw, 12)
    expect(plan.dropped).toBe(true)
    expect(plan.keep.length).toBeLessThan(12)
    expect(plan.keep.length).toBeGreaterThan(1)
    // Re-timing folds dropped frames' delays in, so duration is unchanged.
    expect(sum(plan.delays)).toBe(sum(raw))
    // Effective rate stays at or under the cap (min interval ~67ms at 15fps).
    for (const d of plan.delays) expect(d).toBeGreaterThanOrEqual(66)
  })

  it("normalises missing/zero frame delays to the browser default", () => {
    // All-zero delays would otherwise collapse the animation away.
    const plan = planGifThumbnailFrames([0, 0, 0, 0], 4)
    expect(plan.dropped).toBe(false)
    expect(plan.keep).toEqual([0, 1, 2, 3])
    expect(plan.delays).toEqual([100, 100, 100, 100])
  })

  it("respects a custom max framerate", () => {
    const raw = Array(10).fill(100) // 10fps
    const slow = planGifThumbnailFrames(raw, 10, 5) // cap at 5fps → 200ms interval
    expect(slow.dropped).toBe(true)
    expect(slow.keep.length).toBeLessThan(10)
    expect(sum(slow.delays)).toBe(sum(raw))
  })
})
