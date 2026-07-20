import { describe, expect, it } from "vitest"
import { nextOptimisticSequence } from "./optimistic-sequence"

describe("nextOptimisticSequence", () => {
  it("stays monotonic when multiple sends share a millisecond", () => {
    const first = BigInt(nextOptimisticSequence(1_000))
    const second = BigInt(nextOptimisticSequence(1_000))

    expect(second).toBe(first + 1n)
  })
})
