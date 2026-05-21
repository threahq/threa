/**
 * Boundary Extraction Evaluation Suite
 *
 * Tests the boundary extractor's ability to correctly classify messages
 * into existing conversations or identify new conversation topics.
 *
 * ## Usage
 *
 *   # Run all boundary extraction tests
 *   bun run eval -- -s boundary-extraction
 *
 *   # Run specific cases
 *   bun run eval -- -s boundary-extraction -c new-topic-fresh-stream-001
 *
 *   # Compare models
 *   bun run eval -- -s boundary-extraction -m openrouter:openai/gpt-5.4-nano,openrouter:anthropic/claude-haiku-4.5
 *
 * ## Key Evaluators
 *
 * - conversation-decision: Correct new vs existing decision?
 * - topic-contains: New topic contains expected keywords?
 * - confidence: Above minimum threshold?
 * - completeness-update: Correct resolution detection?
 */

import type { EvalSuite, EvalContext } from "../../framework/types"
import { boundaryExtractionCases } from "./cases"
import type {
  BoundaryExtractionInput,
  BoundaryExtractionOutput,
  BoundaryExtractionExpected,
  EvalMessage,
} from "./types"
import {
  conversationDecisionEvaluator,
  topicContainsEvaluator,
  confidenceEvaluator,
  completenessUpdateEvaluator,
  accuracyEvaluator,
  decisionAccuracyEvaluator,
  averageConfidenceEvaluator,
} from "./evaluators"
import {
  BOUNDARY_EXTRACTION_MODEL_ID,
  BOUNDARY_EXTRACTION_TEMPERATURE,
  LLMBoundaryExtractor,
  type ExtractionContext,
} from "../../../src/features/conversations"
import type { Message } from "../../../src/features/messaging"
import { ulid } from "ulid"

/**
 * Convert eval message to production Message type.
 */
function toMessage(evalMsg: EvalMessage, streamId: string, sequence: number = 1): Message {
  return {
    id: `msg_${ulid()}`,
    streamId,
    sequence: BigInt(sequence),
    authorId: evalMsg.authorId,
    authorType: evalMsg.authorType,
    contentJson: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: evalMsg.contentMarkdown }] }],
    },
    contentMarkdown: evalMsg.contentMarkdown,
    replyCount: 0,
    reactions: {},
    metadata: {},
    clientMessageId: null,
    sentVia: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(),
  }
}

/**
 * Build ExtractionContext from eval input.
 */
function buildExtractionContext(input: BoundaryExtractionInput, workspaceId: string): ExtractionContext {
  const streamId = `stream_${ulid()}`

  return {
    newMessage: toMessage(input.newMessage, streamId, 1),
    recentMessages: (input.recentMessages || []).map((m, i) => toMessage(m, streamId, i + 2)),
    activeConversations: (input.activeConversations || []).map((c) => ({ ...c, contextMessageIds: [] })),
    streamType: input.streamType || "scratchpad",
    workspaceId,
  }
}

/**
 * Task function that runs boundary extraction using the production LLMBoundaryExtractor.
 */
async function runBoundaryExtractionTask(
  input: BoundaryExtractionInput,
  ctx: EvalContext
): Promise<BoundaryExtractionOutput> {
  const extractor = new LLMBoundaryExtractor(ctx.ai, ctx.configResolver)
  const extractionContext = buildExtractionContext(input, ctx.workspaceId)

  try {
    const result = await extractor.extract(extractionContext)
    const primary = result.assignments.find((a) => a.isPrimary) ?? result.assignments[0]

    return {
      input,
      conversationId: primary?.conversationId ?? null,
      newConversationTopic: result.newConversationTopic,
      completenessUpdates: result.completenessUpdates,
      confidence: result.confidence,
    }
  } catch (error) {
    return {
      input,
      conversationId: null,
      confidence: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Boundary Extraction Evaluation Suite
 */
export const boundaryExtractionSuite: EvalSuite<
  BoundaryExtractionInput,
  BoundaryExtractionOutput,
  BoundaryExtractionExpected
> = {
  name: "boundary-extraction",
  description: "Tests conversation boundary classification accuracy",

  cases: boundaryExtractionCases,

  task: runBoundaryExtractionTask,

  evaluators: [conversationDecisionEvaluator, topicContainsEvaluator, confidenceEvaluator, completenessUpdateEvaluator],

  runEvaluators: [accuracyEvaluator, decisionAccuracyEvaluator, averageConfidenceEvaluator],

  defaultPermutations: [
    {
      model: BOUNDARY_EXTRACTION_MODEL_ID,
      temperature: BOUNDARY_EXTRACTION_TEMPERATURE,
    },
  ],
}

export default boundaryExtractionSuite
