import { describe, expect, it } from "vitest"
import { computeMetrics } from "./metrics"

describe("computeMetrics", () => {
  it("should measure spend against the operator ceiling when it is below the budget", () => {
    const now = Date.now()
    const metrics = computeMetrics({
      totalCost: 12,
      budgetAmount: 100,
      operatorCeilingUsd: 10,
      periodStart: new Date(now - 10 * 86_400_000).toISOString(),
      periodEnd: new Date(now + 20 * 86_400_000).toISOString(),
    })

    expect({
      enforcedLimit: metrics.enforcedLimit,
      percentUsed: metrics.percentUsed,
      status: metrics.status,
      statusCopy: metrics.statusCopy,
    }).toEqual({
      enforcedLimit: 10,
      percentUsed: 120,
      status: "over",
      statusCopy: "Limit reached. AI is off until the cycle resets.",
    })
  })
})
