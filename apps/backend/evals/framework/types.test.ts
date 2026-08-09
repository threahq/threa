import { describe, expect, test } from "bun:test"
import { createUsageAccumulator } from "./types"

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
