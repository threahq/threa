import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { AICostService, AIBudgetRepository } from "../../src/features/ai-usage"
import { WorkspaceSettingsRepository } from "../../src/features/workspace-settings"
import { OutboxRepository } from "../../src/lib/outbox"
import { aiBudgetId } from "../../src/lib/id"
import { monthRangeInTimezone } from "../../src/lib/temporal"

describe("AICostService budget alerts", () => {
  let pool: Pool
  let costService: AICostService
  const run = Date.now()
  let seq = 0

  beforeAll(async () => {
    pool = await setupTestDatabase()
    costService = new AICostService({ pool })
  })

  afterAll(async () => {
    for (const table of ["ai_usage_records", "ai_budgets", "ai_alerts", "workspace_setting_overrides"]) {
      await pool.query(`DELETE FROM ${table} WHERE workspace_id LIKE $1`, [`ws_alerts_${run}_%`])
    }
    await pool.end()
  })

  function workspace() {
    return `ws_alerts_${run}_${seq++}`
  }

  async function spend(workspaceId: string, costUsd: number) {
    await costService.recordUsage({
      workspaceId,
      functionId: "memo-embedding",
      model: "openai/gpt-5.6-luna",
      provider: "openrouter",
      origin: "system",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: costUsd },
    })
  }

  async function outboxBaseline(): Promise<bigint> {
    const result = await pool.query<{ max_id: string }>("SELECT COALESCE(MAX(id), 0) AS max_id FROM outbox")
    return BigInt(result.rows[0]!.max_id)
  }

  // ai_alerts.period_start is a DATE: the billing month's start instant lands on its UTC calendar day.
  function periodStartDay(timezone: string): string {
    return monthRangeInTimezone(timezone).start.toISOString().slice(0, 10)
  }

  async function alertsSince(workspaceId: string, baseline: bigint) {
    const [rows, events] = await Promise.all([
      pool.query<{ alert_type: string; period_start: string }>(
        "SELECT alert_type, to_char(period_start, 'YYYY-MM-DD') AS period_start FROM ai_alerts WHERE workspace_id = $1 ORDER BY alert_type",
        [workspaceId]
      ),
      OutboxRepository.fetchAfterId(pool, baseline),
    ])
    return {
      rows: rows.rows.map((row) => ({ alertType: row.alert_type, periodStart: row.period_start })),
      events: events
        .filter((event) => event.eventType === "budget:alert" && event.payload.workspaceId === workspaceId)
        .map((event) => event.payload),
    }
  }

  test("should alert against the operator ceiling over the workspace billing month when the budget is higher", async () => {
    const ws = workspace()
    const billingTimezone = "Pacific/Kiritimati"
    await WorkspaceSettingsRepository.setOverride(pool, ws, "billingTimezone", billingTimezone)
    await AIBudgetRepository.upsertPartial(pool, { id: aiBudgetId(), workspaceId: ws, monthlyBudgetUsd: 1000 })
    await pool.query("UPDATE ai_budgets SET operator_ceiling_usd = 10 WHERE workspace_id = $1", [ws])
    const baseline = await outboxBaseline()

    await spend(ws, 8.5)

    const start = periodStartDay(billingTimezone)
    expect(await alertsSince(ws, baseline)).toEqual({
      rows: [
        { alertType: "budget_50", periodStart: start },
        { alertType: "budget_80", periodStart: start },
      ],
      events: [
        {
          workspaceId: ws,
          alertType: "budget_50",
          thresholdPercent: 50,
          currentUsageUsd: 8.5,
          budgetUsd: 10,
          percentUsed: 85,
        },
        {
          workspaceId: ws,
          alertType: "budget_80",
          thresholdPercent: 80,
          currentUsageUsd: 8.5,
          budgetUsd: 10,
          percentUsed: 85,
        },
      ],
    })
  })

  test("should alert once per threshold against the default limit when the workspace has no budget row", async () => {
    const ws = workspace()
    const baseline = await outboxBaseline()

    await spend(ws, 26)
    await spend(ws, 1)

    const start = periodStartDay("UTC")
    expect(await alertsSince(ws, baseline)).toEqual({
      rows: [{ alertType: "budget_50", periodStart: start }],
      events: [
        {
          workspaceId: ws,
          alertType: "budget_50",
          thresholdPercent: 50,
          currentUsageUsd: 26,
          budgetUsd: 50,
          percentUsed: 52,
        },
      ],
    })
  })
})
