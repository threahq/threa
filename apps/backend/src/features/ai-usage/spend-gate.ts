import type { Pool } from "pg"
import { AI_SPEND_STAGE_CUTOFFS, type AISpendStage } from "@threahq/types"
import type { SpendAdmissionRequest, SpendDecision, SpendGate } from "@threahq/agent-runtime"
import { withClient } from "../../db"
import { logger } from "../../lib/logger"
import { AIBudgetRepository, type SpendPosition } from "./budget-repository"
import { AI_FUNCTIONS } from "./categories"
import { resolveBudgetMonthRange } from "./billing-window"

const AGENT_FUNCTION_IDS = Object.entries(AI_FUNCTIONS)
  .filter(([, fn]) => fn.stage === "agents")
  .map(([functionId]) => functionId)

/** The workspace budget as enforced: the admin's own budget, never above the operator ceiling. */
export function workspaceSpendLimitUsd(limits: Pick<SpendPosition, "monthlyBudgetUsd" | "operatorCeilingUsd">): number {
  return Math.min(limits.monthlyBudgetUsd, limits.operatorCeilingUsd)
}

function decideSpend(position: SpendPosition, stage: AISpendStage): SpendDecision {
  if (position.operatorAiDisabled) return { allowed: false, reason: "operator_disabled" }
  if (position.workspaceAiDisabled) return { allowed: false, reason: "workspace_disabled" }

  const workspaceLimitUsd = workspaceSpendLimitUsd(position)
  if (position.workspaceSpendUsd >= workspaceLimitUsd * AI_SPEND_STAGE_CUTOFFS[stage]) {
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
