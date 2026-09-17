import { describe, expect, it } from "vitest"
import { computeMetrics } from "./metrics"

describe("computeMetrics", () => {
  it("should measure spend against the operator ceiling when it is below the budget", () => {
    const now = Date.now()
    const metrics = computeMetrics({
      totalCost: 12,
      budgetAmount: 100,
      operatorCeilingUsd: 10,
      aiDisabled: false,
      operatorAiDisabled: false,
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

  it.each([
    {
      name: "the limit is $0",
      input: { budgetAmount: 0, aiDisabled: false, operatorAiDisabled: false },
      expected: { percentUsed: 100, status: "over", statusCopy: "The limit is $0, so AI is off." },
    },
    {
      name: "an admin turned AI off",
      input: { budgetAmount: 50, aiDisabled: true, operatorAiDisabled: false },
      expected: { percentUsed: 0, status: "over", statusCopy: "AI is turned off for this workspace." },
    },
    {
      name: "Threa turned AI off",
      input: { budgetAmount: 50, aiDisabled: true, operatorAiDisabled: true },
      expected: { percentUsed: 0, status: "over", statusCopy: "Threa has turned AI off for this workspace." },
    },
  ])("should report AI as stopped when $name", ({ input, expected }) => {
    const now = Date.now()
    const metrics = computeMetrics({
      totalCost: 0,
      operatorCeilingUsd: 100,
      periodStart: new Date(now - 10 * 86_400_000).toISOString(),
      periodEnd: new Date(now + 20 * 86_400_000).toISOString(),
      ...input,
    })

    expect({ percentUsed: metrics.percentUsed, status: metrics.status, statusCopy: metrics.statusCopy }).toEqual(
      expected
    )
  })
})
