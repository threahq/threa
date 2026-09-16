import type { Pool } from "pg"
import type { SpendAdmissionRequest, SpendDecision, SpendGate } from "@threahq/agent-runtime"
import { withClient } from "../../db"
import { logger } from "../../lib/logger"
import { AIBudgetRepository, type SpendPosition } from "./budget-repository"
import { AI_FUNCTIONS, type AISpendStage } from "./categories"
import { resolveBudgetMonthRange } from "./billing-window"

const AGENT_FUNCTION_IDS = Object.entries(AI_FUNCTIONS)
  .filter(([, fn]) => fn.stage === "agents")
  .map(([functionId]) => functionId)

/** Fraction of the workspace limit at which each stage stops. */
const STAGE_CUTOFFS: Record<AISpendStage, number> = {
  agents: 0.7,
  enrichment: 0.85,
  core: 0.95,
  embeddings: 1,
}

function decideSpend(position: SpendPosition, stage: AISpendStage): SpendDecision {
  if (position.operatorAiDisabled) return { allowed: false, reason: "operator_disabled" }
  if (position.workspaceAiDisabled) return { allowed: false, reason: "workspace_disabled" }

  const workspaceLimitUsd = Math.min(position.monthlyBudgetUsd, position.operatorCeilingUsd)
  if (position.workspaceSpendUsd >= workspaceLimitUsd * STAGE_CUTOFFS[stage]) {
    return { allowed: false, reason: "workspace_limit" }
  }

  const { user } = position
  if (!user) return { allowed: true }
  if (user.aiDisabled) return { allowed: false, reason: "user_disabled" }
  if (user.monthlyQuotaUsd !== null && user.spendUsd >= user.monthlyQuotaUsd) {
    return { allowed: false, reason: "user_limit" }
  }
  if (stage === "agents" && user.agentAllowanceUsd !== null && user.agentSpendUsd >= user.agentAllowanceUsd) {
    return { allowed: false, reason: "user_agent_allowance" }
  }
  return { allowed: true }
}

function stageOf(functionId: string): AISpendStage {
  const fn = AI_FUNCTIONS[functionId]
  if (fn) return fn.stage
  logger.warn({ functionId }, "AI function missing from the spend catalog, gating it as an agent call")
  return "agents"
}

export class AISpendGate implements SpendGate {
  private readonly pool: Pool

  constructor({ pool }: { pool: Pool }) {
    this.pool = pool
  }

  async admit(request: SpendAdmissionRequest): Promise<SpendDecision> {
    const position = await withClient(this.pool, async (client) => {
      const { start, end } = await resolveBudgetMonthRange(client, request.workspaceId)
      return AIBudgetRepository.findSpendPosition(client, {
        workspaceId: request.workspaceId,
        userId: request.userId,
        periodStart: start,
        periodEnd: end,
        agentFunctionIds: AGENT_FUNCTION_IDS,
      })
    })
    return decideSpend(position, stageOf(request.functionId))
  }
}
