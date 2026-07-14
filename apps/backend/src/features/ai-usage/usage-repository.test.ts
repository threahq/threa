import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { AIUsageRepository } from "./usage-repository"

interface Captured {
  text: string | null
  values: unknown[] | null
}

function createQuerier(captured: Captured, rows: unknown[] = []): Querier {
  return {
    query: mock(async (q) => {
      const config = q as QueryConfig
      captured.text = config.text
      captured.values = config.values ?? []
      return { rows, rowCount: rows.length } as QueryResult
    }),
  }
}

describe("AIUsageRepository.getUsageByDay", () => {
  afterEach(() => mock.restore())

  const START = new Date("2026-07-01T00:00:00.000Z")
  const END = new Date("2026-08-01T00:00:00.000Z")

  it("buckets by UTC day + function_id, scopes to the workspace/period, and maps numeric strings", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [
      { date: "2026-07-01", function_id: "agent-loop", total_cost_usd: "1.50", total_tokens: "200", record_count: "4" },
    ])

    const result = await AIUsageRepository.getUsageByDay(db, "ws_1", START, END)

    expect(captured.text).toContain("FROM ai_usage_records")
    expect(captured.text).toContain("to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')")
    expect(captured.text).toContain("GROUP BY date, function_id")
    expect(captured.text).toContain("workspace_id =")
    expect(captured.values).toEqual(["ws_1", START, END])
    expect(result).toEqual([
      { date: "2026-07-01", functionId: "agent-loop", totalCostUsd: 1.5, totalTokens: 200, recordCount: 4 },
    ])
  })
})
