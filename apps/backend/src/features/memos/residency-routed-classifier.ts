import { AISpendDeniedError, type DecisionsAvailability } from "@threahq/agent-runtime"
import type { AIResidencyPolicy } from "../ai-usage"
import { logger } from "../../lib/logger"
import type {
  ClassifiableConversation,
  ClassifierContext,
  ConversationClassification,
  ConversationClassifier,
} from "./classifier"
import type { Memo } from "./repository"

/**
 * Picks the classification path by the workspace's AI residency pin, the same
 * way `ResidencyRoutedBoundaryExtractor` picks the extraction path: pinned
 * keeps the models Threa can run in the workspace's own region, unpinned — the
 * default — takes the decision model, which runs in one region only.
 *
 * Fallback only ever runs toward the stricter path. A decision-model failure on
 * an unpinned workspace degrades to inference, which costs more and promises
 * nothing the workspace did not already accept; a pinned workspace never
 * reaches the decision model at all. A spend denial is not a path failure and
 * is rethrown: inference would only spend more.
 */
export class ResidencyRoutedMemoClassifier implements ConversationClassifier {
  private readonly residency: AIResidencyPolicy
  private readonly decisions: ConversationClassifier
  private readonly inference: ConversationClassifier
  private readonly availability: DecisionsAvailability

  constructor(deps: {
    residency: AIResidencyPolicy
    decisions: ConversationClassifier
    inference: ConversationClassifier
    availability: DecisionsAvailability
  }) {
    this.residency = deps.residency
    this.decisions = deps.decisions
    this.inference = deps.inference
    this.availability = deps.availability
  }

  async classifyConversation(
    conversation: ClassifiableConversation,
    formattedMessages: string,
    existingMemos: Memo[],
    context: ClassifierContext
  ): Promise<ConversationClassification> {
    if ((await this.residency.isPinned(context.workspaceId)) || !this.availability.isAvailable) {
      return this.inference.classifyConversation(conversation, formattedMessages, existingMemos, context)
    }

    try {
      return await this.decisions.classifyConversation(conversation, formattedMessages, existingMemos, context)
    } catch (error) {
      if (error instanceof AISpendDeniedError) throw error
      this.availability.recordFailure(error)
      logger.warn(
        { error, workspaceId: context.workspaceId, conversationId: conversation.id },
        "Decision-model memo classification failed, falling back to the inference path"
      )
      return this.inference.classifyConversation(conversation, formattedMessages, existingMemos, context)
    }
  }
}
