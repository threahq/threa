import { describe, expect, it } from "vitest"
import { render, screen } from "@/test"
import type { AIUsageByDay } from "@threa/types"
import { buildDailySpendData, DailySpendChart } from "./daily-spend-chart"

const byDay: AIUsageByDay[] = [
  { date: "2026-07-03", category: "memory", totalCostUsd: 0.2, totalTokens: 2000, recordCount: 8 },
  { date: "2026-07-03", category: "agents", totalCostUsd: 0.1, totalTokens: 3000, recordCount: 2 },
]

describe("buildDailySpendData", () => {
  it("zero-fills every UTC day of the period from the date string", () => {
    const data = buildDailySpendData(byDay, "2026-07-01T00:00:00.000Z", "2026-07-05T12:00:00.000Z")

    expect(data.map((d) => d.date)).toEqual(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05"])

    const empty = data.find((d) => d.date === "2026-07-01")!
    expect(empty.memory).toBe(0)
    expect(empty.agents).toBe(0)

    const busy = data.find((d) => d.date === "2026-07-03")!
    expect(busy.memory).toBe(0.2)
    expect(busy.agents).toBe(0.1)
    expect(busy.conversation).toBe(0)
  })

  it("excludes the day starting exactly at the exclusive period end", () => {
    const data = buildDailySpendData([], "2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z")
    expect(data[0]!.date).toBe("2026-07-01")
    expect(data[data.length - 1]!.date).toBe("2026-07-31")
    expect(data).toHaveLength(31)
  })
})

describe("DailySpendChart", () => {
  it("renders without crashing when there is usage", () => {
    render(
      <DailySpendChart
        byDay={byDay}
        periodStart="2026-07-01T00:00:00.000Z"
        periodEnd="2026-07-31T23:59:59.000Z"
        isLoading={false}
      />
    )
    expect(screen.getByText("Daily spend")).toBeInTheDocument()
  })

  it("renders the empty state when there are no records", () => {
    render(
      <DailySpendChart
        byDay={[]}
        periodStart="2026-07-01T00:00:00.000Z"
        periodEnd="2026-07-31T23:59:59.000Z"
        isLoading={false}
      />
    )
    expect(screen.getByText(/No AI usage recorded yet this cycle/i)).toBeInTheDocument()
  })
})
