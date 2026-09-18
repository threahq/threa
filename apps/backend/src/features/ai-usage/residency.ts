import type { Pool } from "pg"
import { AIBudgetRepository, DEFAULT_AI_BUDGET_CONFIG } from "./budget-repository"

/**
 * Whether a workspace has pinned its AI to models that can be run in its own
 * region. The pin governs which models a feature may reach for, not where a
 * given request is routed: a pinned workspace keeps the regionally-runnable
 * registry (`docs/model-reference.md`), an unpinned one may also use models
 * that exist in one region only.
 */
export interface AIResidencyPolicy {
  isPinned(workspaceId: string): Promise<boolean>
}

export class WorkspaceAIResidencyPolicy implements AIResidencyPolicy {
  private readonly pool: Pool

  constructor({ pool }: { pool: Pool }) {
    this.pool = pool
  }

  async isPinned(workspaceId: string): Promise<boolean> {
    const budget = await AIBudgetRepository.findByWorkspace(this.pool, workspaceId)
    return budget?.aiResidencyPinned ?? DEFAULT_AI_BUDGET_CONFIG.aiResidencyPinned
  }
}
