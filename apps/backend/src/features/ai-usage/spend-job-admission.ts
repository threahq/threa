import { SpendingDeniedError } from "@threahq/agent-runtime"
import { JobQueues } from "../../lib/queue"
import type { AISpendingService } from "./spend-service"
import type { Querier } from "../../db"
import { SpendRepository, SpendWorkspaceNotFoundError } from "./spend-repository"

export const AI_SPENDING_PAUSE_PREFIX = "ai-spending:"

export class AISpendingJobAdmission {
  private readonly unsupportedQueues = new Set<string>([
    JobQueues.CONTEXT_BAG_PRECOMPUTE,
    JobQueues.DYNAMIC_NAMING_EVALUATE,
    JobQueues.EMBEDDING_GENERATE,
    JobQueues.ATTACHMENT_EMBED,
    JobQueues.CONVERSATION_EMBEDDING_GENERATE,
    JobQueues.BOUNDARY_EXTRACT,
    JobQueues.MEMO_BATCH_PROCESS,
    JobQueues.IMAGE_CAPTION,
    JobQueues.PDF_PREPARE,
    JobQueues.PDF_PROCESS_PAGE,
    JobQueues.PDF_ASSEMBLE,
    JobQueues.TEXT_PROCESS,
    JobQueues.WORD_PROCESS,
    JobQueues.EXCEL_PROCESS,
    JobQueues.AGENT_EPISODE_SUMMARIZE,
    JobQueues.AGENT_REFLECTIVE_CAPTURE,
  ])

  constructor(private readonly spending: Pick<AISpendingService, "assertUnprotected">) {}

  async getPauseReason(queueName: string, workspaceId: string, db: Querier): Promise<string | null> {
    if (!this.unsupportedQueues.has(queueName)) return null
    try {
      await SpendRepository.lockWorkspace(db, workspaceId)
      await this.spending.assertUnprotected(workspaceId, db)
      return null
    } catch (error) {
      if (error instanceof SpendWorkspaceNotFoundError) return `${AI_SPENDING_PAUSE_PREFIX}NOT_PROVISIONED`
      if (!(error instanceof SpendingDeniedError)) throw error
      return `${AI_SPENDING_PAUSE_PREFIX}${error.code}`
    }
  }
}
