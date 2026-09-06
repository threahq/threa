import { describe, test, expect } from "bun:test"
import { calculateBackoffMs } from "@threahq/backend-common"

describe("calculateBackoffMs", () => {
  test("should calculate exponential backoff without jitter when random=0", () => {
    const results = [1, 2, 3, 4, 5].map((retryCount) =>
      calculateBackoffMs({ baseMs: 1000, retryCount, random: () => 0 })
    )

    expect(results).toEqual([
      1000, // 1000 * 2^0 = 1000
      2000, // 1000 * 2^1 = 2000
      4000, // 1000 * 2^2 = 4000
      8000, // 1000 * 2^3 = 8000
      16000, // 1000 * 2^4 = 16000
    ])
  })

  test("should add jitter based on random value", () => {
    const withoutJitter = calculateBackoffMs({
      baseMs: 1000,
      retryCount: 1,
      random: () => 0,
    })

    const withHalfJitter = calculateBackoffMs({
      baseMs: 1000,
      retryCount: 1,
      random: () => 0.5,
    })

    const withFullJitter = calculateBackoffMs({
      baseMs: 1000,
      retryCount: 1,
      random: () => 1,
    })

    expect(withoutJitter).toBe(1000)
    expect(withHalfJitter).toBe(1500) // 1000 + 0.5 * 1000
    expect(withFullJitter).toBe(2000) // 1000 + 1.0 * 1000
  })

  test("should cap at maxMs", () => {
    const result = calculateBackoffMs({
      baseMs: 1000,
      retryCount: 20, // Would be 1000 * 2^19 = huge
      maxMs: 30000,
      random: () => 0,
    })

    expect(result).toBe(30000)
  })

  test("should use default maxMs of 5 minutes", () => {
    const result = calculateBackoffMs({
      baseMs: 1000,
      retryCount: 20,
      random: () => 0,
    })

    expect(result).toBe(5 * 60 * 1000)
  })

  test("should handle retryCount of 1 correctly", () => {
    const result = calculateBackoffMs({
      baseMs: 500,
      retryCount: 1,
      random: () => 0,
    })

    // 500 * 2^0 = 500
    expect(result).toBe(500)
  })

  test("should use real Math.random when not provided", () => {
    const results = new Set<number>()

    for (let i = 0; i < 10; i++) {
      results.add(calculateBackoffMs({ baseMs: 1000, retryCount: 1 }))
    }

    // With real randomness, we should get varying results
    // (extremely unlikely to get the same value 10 times)
    expect(results.size).toBeGreaterThan(1)
  })
})
