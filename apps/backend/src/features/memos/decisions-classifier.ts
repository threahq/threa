import type { AI, ChoiceAnswer, DecisionQuestion } from "@threahq/agent-runtime"
import { choiceAnswer, noulAnswer } from "@threahq/agent-runtime"
import { logger } from "../../lib/logger"
import type { Memo } from "./repository"
import type { ClassifiableConversation, ClassifierContext, ConversationClassification } from "./classifier"
import { formatDate } from "../../lib/temporal"
import {
  ACTION_ITEMS_INSTRUCTIONS,
  MEMO_DECISION_ACTION_ITEMS_FLOOR,
  MEMO_DECISION_REVISE_FLOOR,
  MEMO_DECISIONS_MODEL_ID,
  REVISE_INSTRUCTIONS,
  WORTHINESS_CRITERIA,
  WORTHINESS_INSTRUCTIONS,
  WORTHY_CHOICES,
} from "./config"

const KEY = { worth: "worth", actionItems: "action_items", revise: "revise" }

const WORTHY = new Set<string>(WORTHY_CHOICES)

/**
 * Belief that the conversation is worth capturing at all, which is what
 * `MEMO_GEM_CONFIDENCE_FLOOR` was authored to gate on.
 *
 * The answer's own `confidence` is confidence in ONE option out of nine, so a
 * belief split evenly between `decision` and `learning` reports ~0.45 while
 * being near-certain the conversation is worthy — and the caller's fingerprint
 * means a conversation dropped there is never re-asked. Summing the worthy
 * options recovers the binary question the floor is about. An answer that
 * carries no distribution at all falls back to the pick's own confidence.
 */
function worthinessConfidence(worth: ChoiceAnswer): number {
  if (Object.keys(worth.probabilities).length === 0) return worth.confidence
  return WORTHY_CHOICES.reduce((sum, choice) => sum + (worth.probabilities[choice] ?? 0), 0)
}

/**
 * The knowledge-worthiness gate as typed decisions instead of a prompt.
 *
 * Worthiness is a pick-one over what the conversation produced, so the answer
 * names the reason rather than asserting a boolean. The to-do and revision
 * questions ride the same state for almost nothing, since a decisions call
 * answers every question in parallel against one shared input.
 *
 * `revisionReason` is always null here: the decision model cannot write prose,
 * and nothing downstream reads it. The inference path still fills it.
 *
 * Reached only by workspaces that have not pinned their AI residency;
 * `ResidencyRoutedMemoClassifier` owns that choice.
 */
export class DecisionsMemoClassifier {
  constructor(
    private ai: AI,
    private modelId: string = MEMO_DECISIONS_MODEL_ID
  ) {}

  async classifyConversation(
    conversation: ClassifiableConversation,
    formattedMessages: string,
    existingMemos: Memo[],
    context: ClassifierContext
  ): Promise<ConversationClassification> {
    const messageCount = formattedMessages.split("<message").length - 1

    const result = await this.ai.generateDecisions({
      model: this.modelId,
      state: this.buildState(conversation, formattedMessages, existingMemos, context, messageCount),
      questions: this.buildQuestions(existingMemos),
      telemetry: {
        functionId: "memo-classify-conversation",
        metadata: {
          conversationId: conversation.id,
          messageCount,
          existingMemoCount: existingMemos.length,
        },
      },
      context: { workspaceId: context.workspaceId, origin: "system" },
    })

    const worth = choiceAnswer(result, KEY.worth)
    if (!(worth.choice in WORTHINESS_CRITERIA)) {
      logger.warn(
        { choice: worth.choice, conversationId: conversation.id, workspaceId: context.workspaceId },
        "Decision model returned an unoffered worthiness choice; treating the conversation as not worth capturing"
      )
    }

    return {
      isKnowledgeWorthy: WORTHY.has(worth.choice),
      shouldReviseExisting: existingMemos.length > 0 && noulAnswer(result, KEY.revise) >= MEMO_DECISION_REVISE_FLOOR,
      revisionReason: null,
      confidence: worthinessConfidence(worth),
      containsActionItems: noulAnswer(result, KEY.actionItems) >= MEMO_DECISION_ACTION_ITEMS_FLOOR,
    }
  }

  private buildState(
    conversation: ClassifiableConversation,
    formattedMessages: string,
    existingMemos: Memo[],
    context: ClassifierContext,
    messageCount: number
  ) {
    const tz = context.authorTimezone ?? "UTC"
    return {
      topic: conversation.topicSummary,
      // Last 8 characters, matching the inference prompt: enough to tell two
      // participants apart in a short list.
      participants: conversation.participantIds.map((id) => id.slice(-8)),
      messageCount,
      messages: formattedMessages,
      existingMemos: existingMemos.map((memo) => ({
        title: memo.title,
        abstract: memo.abstract,
        created: formatDate(memo.createdAt, tz, "YYYY-MM-DD"),
      })),
    }
  }

  private buildQuestions(existingMemos: Memo[]): Record<string, DecisionQuestion> {
    const questions: Record<string, DecisionQuestion> = {
      [KEY.worth]: { type: "choice", instructions: WORTHINESS_INSTRUCTIONS, criteria: WORTHINESS_CRITERIA },
      [KEY.actionItems]: { type: "noul", instructions: ACTION_ITEMS_INSTRUCTIONS },
    }

    // With no memos there is nothing to revise, and the question would have no
    // state to read — the inference path forces the same false.
    if (existingMemos.length > 0) {
      questions[KEY.revise] = { type: "noul", instructions: REVISE_INSTRUCTIONS }
    }

    return questions
  }
}
