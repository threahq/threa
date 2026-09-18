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
 *   # Compare the two residency paths (decision model vs inference)
 *   bun run eval -- -s boundary-extraction -m openrouter:typesafe/jev-1.13,openrouter:openai/gpt-5.6-luna
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
  topicNotContainsEvaluator,
  confidenceEvaluator,
  completenessUpdateEvaluator,
  reassignmentEvaluator,
  accuracyEvaluator,
  decisionAccuracyEvaluator,
  averageConfidenceEvaluator,
} from "./evaluators"
import {
  BOUNDARY_DECISIONS_MODEL_ID,
  BOUNDARY_EXTRACTION_MODEL_ID,
  BOUNDARY_EXTRACTION_TEMPERATURE,
  DecisionsBoundaryExtractor,
  LLMBoundaryExtractor,
  type ExtractionContext,
} from "../../../src/features/conversations"
import type { AnyComponentConfig, ComponentConfig, ConfigResolver } from "../../../src/lib/ai/config-resolver"
import type { Message } from "../../../src/features/messaging"
import { ulid } from "ulid"

/**
 * Default ages when a case doesn't specify them: a live exchange. The two
 * defaults match so a conversation is never rendered staler than its own
 * newest recent message.
 */
const DEFAULT_RECENT_MESSAGE_MINUTES_AGO = 2
const DEFAULT_CONVERSATION_LAST_ACTIVITY_MINUTES_AGO = 2

/**
 * Convert eval message to production Message type. `now` anchors the relative
 * ages (`minutesAgo`) that session-gap cases use to model time passing.
 */
function toMessage(
  evalMsg: EvalMessage,
  streamId: string,
  sequence: number,
  now: Date,
  defaultMinutesAgo = 0
): Message {
  const minutesAgo = evalMsg.minutesAgo ?? defaultMinutesAgo
  return {
    id: evalMsg.id ?? `msg_${ulid()}`,
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
    conversationIntent: null,
    revision: 1,
    clientMessageId: null,
    sentVia: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(now.getTime() - minutesAgo * 60_000),
    ciphertext: null,
    envelope: null,
    e2eVersion: null,
  }
}

/**
 * Build ExtractionContext from eval input.
 */
function buildExtractionContext(input: BoundaryExtractionInput, workspaceId: string): ExtractionContext {
  const streamId = `stream_${ulid()}`
  const now = new Date()

  return {
    newMessage: toMessage(input.newMessage, streamId, 1, now),
    recentMessages: (input.recentMessages || []).map((m, i) =>
      toMessage(m, streamId, i + 2, now, DEFAULT_RECENT_MESSAGE_MINUTES_AGO)
    ),
    activeConversations: (input.activeConversations || []).map((c) => {
      const { lastActivityMinutesAgo, contextMessageIds, ...fields } = c
      return {
        ...fields,
        summary: c.summary ?? null,
        status: c.status ?? "active",
        lastActivityAt: new Date(
          now.getTime() - (lastActivityMinutesAgo ?? DEFAULT_CONVERSATION_LAST_ACTIVITY_MINUTES_AGO) * 60_000
        ),
        contextMessageIds: contextMessageIds ?? [],
      }
    }),
    replyTargets: input.replyTargets,
    streamType: input.streamType || "scratchpad",
    workspaceId,
  }
}

/**
 * The decision model cannot write prose, so the decision path names new
 * conversations with the inference model — in production and here. `-m` names
 * the DECISION model, and the runner's permutation override would push it onto
 * the naming call too, which the provider rejects outright. Pinning naming to
 * the production model keeps `-m` comparing what it claims to compare, and
 * bills the decision path for the naming call it really makes.
 */
const NAMING_CONFIG_RESOLVER: ConfigResolver = {
  async resolve<T extends AnyComponentConfig = ComponentConfig>(): Promise<T> {
    return { modelId: BOUNDARY_EXTRACTION_MODEL_ID, temperature: BOUNDARY_EXTRACTION_TEMPERATURE } as T
  },
}

/**
 * Runs boundary extraction through the production extractors. Which one is the
 * model under test: the decision model routes to `DecisionsBoundaryExtractor`
 * (what an unpinned workspace gets), anything else to `LLMBoundaryExtractor`
 * (what a residency-pinned one gets), so `-m` compares the two real paths.
 */
async function runBoundaryExtractionTask(
  input: BoundaryExtractionInput,
  ctx: EvalContext
): Promise<BoundaryExtractionOutput> {
  const extractor =
    ctx.permutation.model === BOUNDARY_DECISIONS_MODEL_ID
      ? new DecisionsBoundaryExtractor(ctx.ai, NAMING_CONFIG_RESOLVER)
      : new LLMBoundaryExtractor(ctx.ai, ctx.configResolver)
  const extractionContext = buildExtractionContext(input, ctx.workspaceId)

  try {
    const result = await extractor.extract(extractionContext)
    // validateResult guarantees exactly one primary; fail loudly (INV-11) if
    // that contract breaks (zero OR multiple) rather than silently using the
    // first primary and masking a multi-primary regression.
    const primaries = result.assignments.filter((a) => a.isPrimary)
    if (primaries.length !== 1) {
      throw new Error(`Extractor returned ${primaries.length} primary assignments, expected exactly 1`)
    }
    const primary = primaries[0]

    return {
      input,
      conversationId: primary.conversationId,
      newConversationTopic: result.newConversationTopic,
      completenessUpdates: result.completenessUpdates,
      reassignments: result.reassignments?.map((r) => ({
        messageId: r.messageId,
        toConversationId: r.toConversationId,
      })),
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

  evaluators: [
    conversationDecisionEvaluator,
    topicContainsEvaluator,
    topicNotContainsEvaluator,
    confidenceEvaluator,
    completenessUpdateEvaluator,
    reassignmentEvaluator,
  ],

  runEvaluators: [accuracyEvaluator, decisionAccuracyEvaluator, averageConfidenceEvaluator],

  defaultPermutations: [
    {
      model: BOUNDARY_EXTRACTION_MODEL_ID,
      temperature: BOUNDARY_EXTRACTION_TEMPERATURE,
    },
  ],
}

export default boundaryExtractionSuite
