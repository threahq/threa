/**
 * LLM-as-judge evaluator for quality assessment.
 *
 * Uses an LLM to evaluate output quality against specified criteria.
 */

import { EVAL_JUDGE_MODEL } from "../judge-config"
import { z } from "zod"
import type { Evaluator, EvalContext, EvaluatorResult } from "../types"

/**
 * Schema for LLM judge response.
 */
const judgeResponseSchema = z.object({
  score: z.number().min(0).max(1).describe("Score from 0.0 (poor) to 1.0 (excellent)"),
  reasoning: z.string().describe("Brief explanation of the score"),
  passed: z.boolean().describe("Whether the output meets the criteria"),
})

/**
 * Options for the LLM judge evaluator.
 */
export interface LLMJudgeOptions {
  /** Name for this evaluator */
  name?: string
  /** Criteria to evaluate against */
  criteria: string
  /** Model to use for judging (default: {@link EVAL_JUDGE_MODEL}) */
  model?: string
  /** Pass threshold (default: 0.7) */
  passThreshold?: number
  /** Additional context to provide to the judge */
  context?: string
}

/**
 * Create an LLM-as-judge evaluator.
 *
 * @example
 * llmJudgeEvaluator({
 *   criteria: "The output preserves all factual information from the input",
 *   model: EVAL_JUDGE_MODEL,
 * })
 */
export function llmJudgeEvaluator<TOutput, TExpected>(options: LLMJudgeOptions): Evaluator<TOutput, TExpected> {
  const {
    name = "llm-judge",
    criteria,
    model = EVAL_JUDGE_MODEL,
    passThreshold = 0.7,
    context: additionalContext,
  } = options

  const systemPrompt = `You are an AI evaluator assessing the quality of generated outputs.

Your task is to evaluate an output against specific criteria and provide a score.

## Criteria
${criteria}

${additionalContext ? `## Additional Context\n${additionalContext}` : ""}

## Scoring Guidelines
- 1.0: Excellent - Fully meets all criteria
- 0.8-0.9: Good - Meets most criteria with minor issues
- 0.6-0.7: Acceptable - Meets basic criteria but has notable issues
- 0.4-0.5: Poor - Partially meets criteria with significant issues
- 0.0-0.3: Failing - Does not meet criteria

Evaluate objectively and provide a brief reasoning for your score.`

  return {
    name,
    evaluate: async (output: TOutput, expected: TExpected, ctx: EvalContext): Promise<EvaluatorResult> => {
      const userPrompt = `## Expected Output
${JSON.stringify(expected, null, 2)}

## Actual Output
${JSON.stringify(output, null, 2)}

Evaluate the actual output against the expected output and criteria.`

      try {
        const { value } = await ctx.ai.generateObject({
          model: ctx.judgeModel ?? model,
          schema: judgeResponseSchema,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.1,
          telemetry: {
            functionId: `eval-${name}`,
          },
        })

        return {
          name,
          score: value.score,
          passed: value.score >= passThreshold,
          details: value.reasoning,
        }
      } catch (error) {
        return {
          name,
          score: 0,
          passed: false,
          details: `LLM judge error: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  }
}
