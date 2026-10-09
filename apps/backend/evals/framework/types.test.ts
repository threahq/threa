import { describe, expect, test } from "bun:test"
import { createSpendGuard, createUsageAccumulator } from "./types"

describe("createUsageAccumulator", () => {
  test("aggregates reasoning tokens with the other eval usage totals", () => {
    const usage = createUsageAccumulator()

    usage.recordUsage({ promptTokens: 10, completionTokens: 6, reasoningTokens: 4, cost: 0.01 })
    usage.recordUsage({ promptTokens: 3, completionTokens: 2, reasoningTokens: 1, cost: 0.02 })

    expect(usage.getTotal()).toEqual({
      inputTokens: 13,
      outputTokens: 8,
      reasoningTokens: 5,
      totalCost: 0.03,
    })
  })
})

describe("createSpendGuard", () => {
  test("aborts once spend reaches the budget", () => {
    const spend = createSpendGuard(1)

    spend.add(0.6)
    expect(spend.signal.aborted).toBe(false)
    spend.add(0.4)

    expect(spend.signal.aborted).toBe(true)
    expect((spend.signal.reason as Error).message).toBe("Spent $1.00, reaching the $1 budget: run stopped")
  })

  test("never aborts on spend without a budget", () => {
    const spend = createSpendGuard()

    spend.add(10_000)

    expect(spend.signal.aborted).toBe(false)
  })
})
