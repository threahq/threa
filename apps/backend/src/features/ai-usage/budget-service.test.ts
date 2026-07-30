import { describe, expect, it, mock } from "bun:test"
import type { Pool, QueryConfig, QueryResult } from "pg"
import { AIBudgetService } from "./budget-service"
import { resolveBillingTimezone, resolveBudgetMonthRange } from "./billing-window"
import { monthRangeInTimezone } from "../../lib/temporal"

interface Captured {
  usagePeriod: { start: Date; end: Date } | null
}

const BUDGET_ROW = {
  id: "aibudget_1",
  workspace_id: "ws_1",
  monthly_budget_usd: "50",
  alert_threshold_50: true,
  alert_threshold_80: true,
  alert_threshold_100: true,
  degradation_enabled: true,
  hard_limit_enabled: false,
  hard_limit_percent: 100,
  created_at: new Date(),
  updated_at: new Date(),
}

/**
 * Routes by table so the service's real query order stays an implementation
 * detail — the test only cares which period the usage scan is given.
 */
function createPool(
  captured: Captured,
  storedTimezone: unknown,
  spentUsd = "10",
  budgetOverrides: Partial<typeof BUDGET_ROW> = {}
): Pool {
  const client = {
    query: mock(async (q: unknown) => {
      const config = q as QueryConfig
      const text = config.text ?? ""
      const values = config.values ?? []

      if (text.includes("workspace_setting_overrides")) {
        return {
          rows: storedTimezone === undefined ? [] : [{ key: "billingTimezone", value: storedTimezone }],
          rowCount: storedTimezone === undefined ? 0 : 1,
        } as QueryResult
      }
      if (text.includes("ai_budgets")) {
        return { rows: [{ ...BUDGET_ROW, ...budgetOverrides }], rowCount: 1 } as QueryResult
      }
      if (text.includes("ai_usage_records")) {
        captured.usagePeriod = { start: values[1] as Date, end: values[2] as Date }
        return {
          rows: [
            {
              total_cost_usd: spentUsd,
              total_tokens: "100",
              prompt_tokens: "50",
              completion_tokens: "50",
              record_count: "1",
            },
          ],
          rowCount: 1,
        } as QueryResult
      }
      throw new Error(`unexpected query: ${text}`)
    }),
    release: mock(() => {}),
  }
  return { connect: mock(async () => client) } as unknown as Pool
}

describe("AIBudgetService.checkBudget enforcement window", () => {
  it("counts spend over the workspace's billing-timezone month", async () => {
    const captured: Captured = { usagePeriod: null }
    const service = new AIBudgetService({ pool: createPool(captured, "Asia/Tokyo") })

    await service.checkBudget("ws_1")

    // Tokyo's month opens 9h before UTC's, so this is a window the old
    // server-local range could never have produced.
    expect(captured.usagePeriod).toEqual(monthRangeInTimezone("Asia/Tokyo"))
  })

  it("falls back to UTC when the workspace has stored no zone", async () => {
    const captured: Captured = { usagePeriod: null }
    const service = new AIBudgetService({ pool: createPool(captured, undefined) })

    await service.checkBudget("ws_1")

    expect(captured.usagePeriod).toEqual(monthRangeInTimezone("UTC"))
  })

  it("falls back to UTC rather than throwing on a corrupt stored zone", async () => {
    const captured: Captured = { usagePeriod: null }
    const service = new AIBudgetService({ pool: createPool(captured, "Mars/Olympus") })

    // A hand-edited row must not throw on every AI call in the workspace.
    await service.checkBudget("ws_1")

    expect(captured.usagePeriod).toEqual(monthRangeInTimezone("UTC"))
  })

  it("uses an exclusive month end so the next month's spend is not counted", async () => {
    const captured: Captured = { usagePeriod: null }
    const service = new AIBudgetService({ pool: createPool(captured, "UTC") })

    await service.checkBudget("ws_1")

    // The old range ended at 23:59:59.999 of the last day against a `< end`
    // predicate, silently dropping the final millisecond.
    const { end } = captured.usagePeriod!
    expect(end.getUTCDate()).toBe(1)
    expect(end.getUTCHours()).toBe(0)
    expect(end.getUTCMinutes()).toBe(0)
    expect(end.getUTCMilliseconds()).toBe(0)
  })

  it("degrades the model off spend read from the workspace-zone window", async () => {
    const captured: Captured = { usagePeriod: null }
    const service = new AIBudgetService({ pool: createPool(captured, "Asia/Tokyo", "60") })

    const status = await service.checkBudget("ws_1", "openrouter:anthropic/claude-sonnet-5")

    expect(status).toMatchObject({
      allowed: true,
      reason: "soft_limit",
      currentUsageUsd: 60,
      budgetUsd: 50,
      recommendedModel: "openrouter:openai/gpt-5.6-luna",
    })
    expect(captured.usagePeriod).toEqual(monthRangeInTimezone("Asia/Tokyo"))
  })

  it("blocks the call when spend in the workspace-zone window trips an enabled hard limit", async () => {
    const captured: Captured = { usagePeriod: null }
    const service = new AIBudgetService({
      pool: createPool(captured, "Asia/Tokyo", "60", { hard_limit_enabled: true, hard_limit_percent: 100 }),
    })

    const status = await service.checkBudget("ws_1", "openrouter:anthropic/claude-sonnet-5")

    expect(status).toMatchObject({
      allowed: false,
      reason: "hard_limit",
      currentUsageUsd: 60,
      budgetUsd: 50,
    })
    expect(captured.usagePeriod).toEqual(monthRangeInTimezone("Asia/Tokyo"))
  })

  it("allows the call when the same spend sits under the hard limit's threshold", async () => {
    const captured: Captured = { usagePeriod: null }
    const service = new AIBudgetService({
      // 60 of 50 is 120% — under a 200% limit, so the limit must not fire.
      pool: createPool(captured, "Asia/Tokyo", "60", { hard_limit_enabled: true, hard_limit_percent: 200 }),
    })

    const status = await service.checkBudget("ws_1")

    expect(status).toMatchObject({ allowed: true, reason: "soft_limit" })
  })
})

describe("resolveBillingTimezone", () => {
  function querier(storedTimezone: unknown) {
    return {
      query: mock(async () => ({
        rows: storedTimezone === undefined ? [] : [{ key: "billingTimezone", value: storedTimezone }],
        rowCount: storedTimezone === undefined ? 0 : 1,
      })),
    } as never
  }

  it("reads the workspace's stored zone", async () => {
    expect(await resolveBillingTimezone(querier("Europe/Stockholm"), "ws_1")).toBe("Europe/Stockholm")
  })

  it("falls back to UTC for unset, non-string, and invalid zones", async () => {
    expect(await resolveBillingTimezone(querier(undefined), "ws_1")).toBe("UTC")
    expect(await resolveBillingTimezone(querier(42), "ws_1")).toBe("UTC")
    expect(await resolveBillingTimezone(querier("Mars/Olympus"), "ws_1")).toBe("UTC")
  })

  it("cuts the enforcement month on the stored zone", async () => {
    expect(await resolveBudgetMonthRange(querier("Asia/Tokyo"), "ws_1")).toEqual(monthRangeInTimezone("Asia/Tokyo"))
  })
})
