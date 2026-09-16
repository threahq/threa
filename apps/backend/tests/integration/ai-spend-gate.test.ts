import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { AISpendGate, AIBudgetRepository, AIUsageRepository } from "../../src/features/ai-usage"
import { aiBudgetId, aiUsageId } from "../../src/lib/id"

describe("AISpendGate", () => {
  let pool: Pool
  let gate: AISpendGate
  const run = Date.now()
  let seq = 0

  beforeAll(async () => {
    pool = await setupTestDatabase()
    gate = new AISpendGate({ pool })
  })

  afterAll(async () => {
    await pool.query("DELETE FROM ai_usage_records WHERE workspace_id LIKE $1", [`ws_spend_${run}_%`])
    await pool.query("DELETE FROM ai_budgets WHERE workspace_id LIKE $1", [`ws_spend_${run}_%`])
    await pool.query("DELETE FROM ai_user_quotas WHERE workspace_id LIKE $1", [`ws_spend_${run}_%`])
    await pool.end()
  })

  function workspace() {
    return `ws_spend_${run}_${seq++}`
  }

  async function spend(workspaceId: string, costUsd: number, functionId: string, userId?: string) {
    await AIUsageRepository.insert(pool, {
      id: aiUsageId(),
      workspaceId,
      userId,
      functionId,
      model: "openai/gpt-5.6-luna",
      provider: "openrouter",
      promptTokens: 1,
      cachedPromptTokens: 0,
      completionTokens: 1,
      totalTokens: 2,
      costUsd,
      origin: userId ? "user" : "system",
    })
  }

  test("should admit a workspace with no budget row and no spend", async () => {
    expect(await gate.admit({ workspaceId: workspace(), functionId: "agent-loop" })).toEqual({ allowed: true })
  })

  test("should stop agents before embeddings as spend approaches the default limit", async () => {
    const ws = workspace()
    await spend(ws, 40, "memo-embedding")

    expect({
      agents: await gate.admit({ workspaceId: ws, functionId: "agent-loop" }),
      embeddings: await gate.admit({ workspaceId: ws, functionId: "message-embedding" }),
    }).toEqual({
      agents: { allowed: false, reason: "workspace_limit" },
      embeddings: { allowed: true },
    })
  })

  test("should hold a workspace to the operator ceiling when its own budget is higher", async () => {
    const ws = workspace()
    await AIBudgetRepository.upsertPartial(pool, { id: aiBudgetId(), workspaceId: ws, monthlyBudgetUsd: 1000 })
    await pool.query("UPDATE ai_budgets SET operator_ceiling_usd = 10 WHERE workspace_id = $1", [ws])
    await spend(ws, 10, "memo-embedding")

    expect(await gate.admit({ workspaceId: ws, functionId: "message-embedding" })).toEqual({
      allowed: false,
      reason: "workspace_limit",
    })
  })

  test("should deny everything when the operator switches AI off", async () => {
    const ws = workspace()
    await AIBudgetRepository.upsertPartial(pool, { id: aiBudgetId(), workspaceId: ws })
    await pool.query("UPDATE ai_budgets SET operator_ai_disabled = true, ai_disabled = true WHERE workspace_id = $1", [
      ws,
    ])

    expect(await gate.admit({ workspaceId: ws, functionId: "message-embedding" })).toEqual({
      allowed: false,
      reason: "operator_disabled",
    })
  })

  test("should charge a user's agent allowance with only their own agent spend", async () => {
    const ws = workspace()
    await AIBudgetRepository.upsertPartial(pool, { id: aiBudgetId(), workspaceId: ws })
    await pool.query("UPDATE ai_budgets SET default_user_agent_allowance_usd = 2 WHERE workspace_id = $1", [ws])
    await spend(ws, 5, "memo-embedding", "usr_a")
    await spend(ws, 5, "agent-loop", "usr_b")
    await spend(ws, 1.5, "agent-loop", "usr_a")

    expect({
      underAllowance: await gate.admit({ workspaceId: ws, userId: "usr_a", functionId: "agent-loop" }),
      overAllowance: await gate.admit({ workspaceId: ws, userId: "usr_b", functionId: "agent-loop" }),
      nonAgentOverAllowance: await gate.admit({ workspaceId: ws, userId: "usr_b", functionId: "image-caption" }),
    }).toEqual({
      underAllowance: { allowed: true },
      overAllowance: { allowed: false, reason: "user_agent_allowance" },
      nonAgentOverAllowance: { allowed: true },
    })
  })

  test("should prefer a user's own agent allowance and apply their total limit and off switch", async () => {
    const ws = workspace()
    await AIBudgetRepository.upsertPartial(pool, { id: aiBudgetId(), workspaceId: ws })
    await pool.query("UPDATE ai_budgets SET default_user_agent_allowance_usd = 1 WHERE workspace_id = $1", [ws])
    await pool.query(
      `INSERT INTO ai_user_quotas (id, workspace_id, user_id, monthly_quota_usd, agent_allowance_usd, ai_disabled)
       VALUES ($1, $2, 'usr_a', 10, 5, false), ($3, $2, 'usr_b', 3, NULL, false), ($4, $2, 'usr_c', NULL, NULL, true)`,
      [`aiquota_${run}_a${seq}`, ws, `aiquota_${run}_b${seq}`, `aiquota_${run}_c${seq}`]
    )
    await spend(ws, 2, "agent-loop", "usr_a")
    await spend(ws, 3, "memo-embedding", "usr_b")

    expect({
      ownAllowance: await gate.admit({ workspaceId: ws, userId: "usr_a", functionId: "agent-loop" }),
      totalLimit: await gate.admit({ workspaceId: ws, userId: "usr_b", functionId: "message-embedding" }),
      disabled: await gate.admit({ workspaceId: ws, userId: "usr_c", functionId: "message-embedding" }),
    }).toEqual({
      ownAllowance: { allowed: true },
      totalLimit: { allowed: false, reason: "user_limit" },
      disabled: { allowed: false, reason: "user_disabled" },
    })
  })
})
