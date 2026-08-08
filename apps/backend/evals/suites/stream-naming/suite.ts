/**
 * Stream Naming Evaluation Suite
 *
 * Tests the stream naming service's ability to generate descriptive,
 * concise titles (2-5 words) for conversations.
 *
 * ## Usage
 *
 *   # Run all stream naming tests
 *   bun run eval -- -s stream-naming
 *
 *   # Run specific cases
 *   bun run eval -- -s stream-naming -c technical-api-discussion-001
 *
 *   # Compare models
 *   bun run eval -- -s stream-naming -m openrouter:openai/gpt-5.4-nano,openrouter:anthropic/claude-haiku-4.5
 *
 * ## Key Evaluators
 *
 * - word-count: Is the name 2-5 words?
 * - name-contains: Does it contain expected topic words?
 * - name-not-contains: Does it avoid unwanted phrases?
 * - avoids-generic: Does it avoid generic names like "Quick Question"?
 * - action: Does minimal context defer while forced checkpoints rename?
 */

import type { EvalSuite, EvalContext } from "../../framework/types"
import { streamNamingCases } from "./cases"
import type { StreamNamingInput, StreamNamingOutput, StreamNamingExpected } from "./types"
import {
  actionEvaluator,
  wordCountEvaluator,
  nameContainsEvaluator,
  nameNotContainsEvaluator,
  avoidsGenericEvaluator,
  accuracyEvaluator,
  wordCountComplianceEvaluator,
} from "./evaluators"
import {
  DYNAMIC_NAMING_MODEL_ID,
  DYNAMIC_NAMING_TEMPERATURE,
  DynamicNamingEvaluator,
} from "../../../src/features/dynamic-naming"

/** Calls the production structured evaluator directly (INV-45). */
async function runStreamNamingTask(input: StreamNamingInput, ctx: EvalContext): Promise<StreamNamingOutput> {
  const checkpoint = input.checkpoint ?? 3
  const forced = input.forced ?? checkpoint >= 3
  const evaluator = new DynamicNamingEvaluator(ctx.ai, ctx.configResolver)

  try {
    const decision = await evaluator.decide(
      {
        workspaceId: ctx.workspaceId,
        targetKind: "stream",
        targetId: "stream_eval",
        checkpoint,
        forced,
        messageCount: checkpoint,
        currentTitle: input.currentTitle ?? null,
        context: input.conversationText,
        existingTitles: input.existingNames ?? [],
      },
      new AbortController().signal
    )
    return {
      input,
      action: decision.action,
      name: decision.action === "rename" ? decision.title : (input.currentTitle ?? null),
    }
  } catch (error) {
    return {
      input,
      action: "defer",
      name: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Stream Naming Evaluation Suite
 */
export const streamNamingSuite: EvalSuite<StreamNamingInput, StreamNamingOutput, StreamNamingExpected> = {
  name: "stream-naming",
  description: "Tests stream naming quality (2-5 word descriptive titles)",

  cases: streamNamingCases,

  task: runStreamNamingTask,

  evaluators: [
    actionEvaluator,
    wordCountEvaluator,
    nameContainsEvaluator,
    nameNotContainsEvaluator,
    avoidsGenericEvaluator,
  ],

  runEvaluators: [accuracyEvaluator, wordCountComplianceEvaluator],

  defaultPermutations: [
    {
      model: DYNAMIC_NAMING_MODEL_ID,
      temperature: DYNAMIC_NAMING_TEMPERATURE,
    },
  ],
}

export default streamNamingSuite
