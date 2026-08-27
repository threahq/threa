/**
 * Custom Evaluators for Companion Agent
 *
 * Evaluates response quality, appropriateness, and behavior consistency.
 */

import type { Evaluator, EvalContext, EvaluatorResult, RunEvaluator, CaseResult } from "../../framework/types"
import { llmJudgeEvaluator } from "../../framework/evaluators/llm-judge"
import type { CompanionOutput, CompanionExpected } from "./types"

// The judge receives the case's expected-behavior descriptor as "Expected Output" and the
// runner's raw record as "Actual Output"; without this it docks points for the two JSON
// shapes not matching, which is noise, not a quality signal.
const JUDGE_SHAPE_CONTEXT = `The "Expected Output" block is a behavioral specification (shouldRespond, responseCharacteristics, reason), NOT a literal JSON shape the output must match. The "Actual Output" block is the eval runner's raw record; the assistant's reply is the "messages" array's content. Judge only whether the reply's content satisfies the criteria and the behavioral specification. Never penalize structural or field-name differences between the two JSON objects.`

// =============================================================================
// Case-Level Evaluators
// =============================================================================

/**
 * Evaluates whether the agent correctly decided to respond (or not).
 */
export const shouldRespondEvaluator: Evaluator<CompanionOutput, CompanionExpected> = {
  name: "should-respond",
  evaluate: (output: CompanionOutput, expected: CompanionExpected): EvaluatorResult => {
    // If expected not to respond, check that no messages were sent
    if (!expected.shouldRespond) {
      const didNotRespond = output.messages.length === 0 || output.messages.every((m) => m.content.trim() === "")
      return {
        name: "should-respond",
        score: didNotRespond ? 1 : 0,
        passed: didNotRespond,
        details: didNotRespond ? undefined : "Agent responded when it should not have",
      }
    }

    // If expected to respond, check that at least one message was sent
    const didRespond = output.messages.length > 0 && output.messages.some((m) => m.content.trim() !== "")
    return {
      name: "should-respond",
      score: didRespond ? 1 : 0,
      passed: didRespond,
      details: didRespond ? undefined : "Agent did not respond when it should have",
    }
  },
}

/**
 * Evaluates whether the response contains expected content.
 */
export const contentContainsEvaluator: Evaluator<CompanionOutput, CompanionExpected> = {
  name: "content-contains",
  evaluate: (output: CompanionOutput, expected: CompanionExpected): EvaluatorResult => {
    const shouldContain = expected.responseCharacteristics?.shouldContain
    if (!shouldContain || shouldContain.length === 0) {
      return { name: "content-contains", score: 1, passed: true, details: "No content requirements" }
    }

    // Combine all response content
    const fullContent = output.messages.map((m) => m.content.toLowerCase()).join(" ")

    const found = shouldContain.filter((phrase) => fullContent.includes(phrase.toLowerCase()))
    const missing = shouldContain.filter((phrase) => !fullContent.includes(phrase.toLowerCase()))

    const score = found.length / shouldContain.length
    const passed = score >= 0.7

    return {
      name: "content-contains",
      score,
      passed,
      details: missing.length > 0 ? `Missing: ${missing.map((s) => `"${s}"`).join(", ")}` : undefined,
    }
  },
}

/**
 * At least one of `shouldContainAny` appears. Separate from `content-contains`
 * because the two ask different questions: one is "these exact strings are
 * required", the other is "the answer engaged with the topic at all". Collapsing
 * them into a single ratio scored breadth of enumeration, which is a style, not
 * a quality — and a style Ariadne's prompt tells her not to have.
 */
export const contentContainsAnyEvaluator: Evaluator<CompanionOutput, CompanionExpected> = {
  name: "content-contains-any",
  evaluate: (output: CompanionOutput, expected: CompanionExpected): EvaluatorResult => {
    const anyOf = expected.responseCharacteristics?.shouldContainAny
    if (!anyOf || anyOf.length === 0) {
      return { name: "content-contains-any", score: 1, passed: true, details: "No alternatives required" }
    }

    const fullContent = output.messages.map((m) => m.content.toLowerCase()).join(" ")
    const hit = anyOf.some((phrase) => fullContent.includes(phrase.toLowerCase()))

    return {
      name: "content-contains-any",
      score: hit ? 1 : 0,
      passed: hit,
      details: hit ? undefined : `None of ${anyOf.map((s) => `"${s}"`).join(", ")} appeared`,
    }
  },
}

/**
 * Evaluates whether the response avoids unwanted content.
 */
export const contentNotContainsEvaluator: Evaluator<CompanionOutput, CompanionExpected> = {
  name: "content-not-contains",
  evaluate: (output: CompanionOutput, expected: CompanionExpected): EvaluatorResult => {
    const shouldNotContain = expected.responseCharacteristics?.shouldNotContain
    if (!shouldNotContain || shouldNotContain.length === 0) {
      return { name: "content-not-contains", score: 1, passed: true, details: "No exclusion requirements" }
    }

    const fullContent = output.messages.map((m) => m.content.toLowerCase()).join(" ")

    const found = shouldNotContain.filter((phrase) => fullContent.includes(phrase.toLowerCase()))

    const passed = found.length === 0
    const score = passed ? 1 : 1 - found.length / shouldNotContain.length

    return {
      name: "content-not-contains",
      score,
      passed,
      details: found.length > 0 ? `Unwanted phrases found: ${found.map((s) => `"${s}"`).join(", ")}` : undefined,
    }
  },
}

/**
 * Evaluates whether the response is appropriately brief.
 */
export const brevityEvaluator: Evaluator<CompanionOutput, CompanionExpected> = {
  name: "brevity",
  evaluate: (output: CompanionOutput, expected: CompanionExpected): EvaluatorResult => {
    if (!expected.responseCharacteristics?.brief) {
      return { name: "brevity", score: 1, passed: true, details: "No brevity requirement" }
    }

    const fullContent = output.messages.map((m) => m.content).join(" ")
    const wordCount = fullContent.split(/\s+/).filter((w) => w.length > 0).length

    // Brief = less than 100 words
    const isBrief = wordCount < 100
    const score = isBrief ? 1 : Math.max(0, 1 - (wordCount - 100) / 200)

    return {
      name: "brevity",
      score,
      passed: isBrief,
      details: isBrief ? undefined : `Response has ${wordCount} words (expected < 100)`,
    }
  },
}

/**
 * Evaluates whether the response asks a clarifying question when expected.
 */
export const asksQuestionEvaluator: Evaluator<CompanionOutput, CompanionExpected> = {
  name: "asks-question",
  evaluate: (output: CompanionOutput, expected: CompanionExpected): EvaluatorResult => {
    if (!expected.responseCharacteristics?.shouldAskQuestion) {
      return { name: "asks-question", score: 1, passed: true, details: "No question requirement" }
    }

    const fullContent = output.messages.map((m) => m.content).join(" ")

    // A question mark, and nothing else. The English interrogative list that
    // used to sit here made a semantic judgement out of English literals
    // (INV-54): it read "how" inside "show me how it works" as a question, and
    // scored a perfectly formed Swedish or Japanese question as none at all.
    const hasQuestion = fullContent.includes("?")

    return {
      name: "asks-question",
      score: hasQuestion ? 1 : 0,
      passed: hasQuestion,
      details: hasQuestion ? undefined : "Expected a clarifying question but none was asked",
    }
  },
}

/**
 * LLM-as-judge evaluator for overall response quality.
 * Uses the framework's llmJudgeEvaluator for consistency.
 */
/**
 * What the judge sees. The trace is recorded for the model comparison, not for
 * grading: a judge shown the trajectory starts scoring the route the agent took
 * instead of the reply the user got, and the tool evaluators already own that
 * question. Keeping it out also keeps judge scores comparable across runs made
 * before and after the trace was captured.
 */
function judgedOutput(output: CompanionOutput): CompanionOutput {
  const { trajectory: _trajectory, ...rest } = output
  return rest
}

export function createResponseQualityEvaluator(): Evaluator<CompanionOutput, CompanionExpected> {
  // Create base judge evaluator
  const baseJudge = llmJudgeEvaluator<CompanionOutput, CompanionExpected>({
    name: "response-quality",
    criteria: `The response is helpful, accurate, and appropriate:
- Addresses the user's need directly
- Contains accurate information
- Has an appropriate tone for the context
- Is concise without being unhelpfully brief
- Considers conversation context when available`,
    passThreshold: 0.7,
    context: JUDGE_SHAPE_CONTEXT,
  })

  return {
    name: "response-quality",
    evaluate: async (
      output: CompanionOutput,
      expected: CompanionExpected,
      ctx: EvalContext
    ): Promise<EvaluatorResult> => {
      // Skip if not expected to respond
      if (!expected.shouldRespond) {
        return { name: "response-quality", score: 1, passed: true, details: "Not expected to respond" }
      }

      const fullContent = output.messages.map((m) => m.content).join("\n---\n")
      if (!fullContent.trim()) {
        return { name: "response-quality", score: 0, passed: false, details: "No response content" }
      }

      // Use the base judge
      return baseJudge.evaluate(judgedOutput(output), expected, ctx)
    },
  }
}

/**
 * LLM-as-judge evaluator for tone appropriateness.
 * Uses the framework's llmJudgeEvaluator for consistency.
 */
export function createToneEvaluator(): Evaluator<CompanionOutput, CompanionExpected> {
  return {
    name: "tone",
    evaluate: async (
      output: CompanionOutput,
      expected: CompanionExpected,
      ctx: EvalContext
    ): Promise<EvaluatorResult> => {
      const expectedTone = expected.responseCharacteristics?.tone
      if (!expectedTone) {
        return { name: "tone", score: 1, passed: true, details: "No tone requirement" }
      }

      const fullContent = output.messages.map((m) => m.content).join("\n")
      if (!fullContent.trim()) {
        return { name: "tone", score: 1, passed: true, details: "No content to evaluate" }
      }

      // Create a judge specifically for this tone check
      const toneJudge = llmJudgeEvaluator<CompanionOutput, CompanionExpected>({
        name: "tone",
        criteria: `The response has a ${expectedTone} tone:
- friendly: Warm, personable, uses casual language, may use contractions
- professional: Formal, clear, objective, avoids casual expressions
- casual: Very relaxed, may use slang or very informal language

The response should clearly match the ${expectedTone} tone definition.`,
        passThreshold: 0.7,
        context: JUDGE_SHAPE_CONTEXT,
      })

      return toneJudge.evaluate(judgedOutput(output), expected, ctx)
    },
  }
}

/**
 * Evaluates whether web search was used when expected.
 */
export const webSearchUsageEvaluator: Evaluator<CompanionOutput, CompanionExpected> = {
  name: "web-search-usage",
  evaluate: (output: CompanionOutput, expected: CompanionExpected): EvaluatorResult => {
    const shouldUseWebSearch = expected.responseCharacteristics?.shouldUseWebSearch
    if (!shouldUseWebSearch) {
      return { name: "web-search-usage", score: 1, passed: true, details: "No web search requirement" }
    }

    // The requirement is that the answer came off the web instead of out of the
    // weights, and Ariadne has more than one way to get there: `web_search`
    // queries directly, `general_research` delegates to the researcher, and
    // `read_url` fetches a page. Matching only the `web_search` step name
    // scored the ROUTE rather than the grounding, and marked a
    // research-delegating turn — sources attached and all — as ungrounded.
    // The route difference is real and worth reporting, but it is a cost and
    // latency question, not a correctness one.
    const WEB_REACHING_STEPS = new Set(["web_search", "research", "visit_page"])
    const reachedWeb =
      (output.toolCalls?.some((tc) => tc.name === "web_search") ?? false) ||
      (output.trajectory?.some((step) => WEB_REACHING_STEPS.has(step.stepType)) ?? false)

    const route = [
      ...new Set((output.trajectory ?? []).map((s) => s.stepType).filter((t) => WEB_REACHING_STEPS.has(t))),
    ]

    return {
      name: "web-search-usage",
      score: reachedWeb ? 1 : 0,
      passed: reachedWeb,
      details: reachedWeb
        ? `via ${route.join(", ") || "web_search"}`
        : "Expected the web to be consulted, but no web-reaching tool ran",
    }
  },
}

/**
 * Evaluates whether web search queries include expected temporal grounding terms.
 */
export const webSearchQueryEvaluator: Evaluator<CompanionOutput, CompanionExpected> = {
  name: "web-search-query",
  evaluate: (output: CompanionOutput, expected: CompanionExpected): EvaluatorResult => {
    const expectedTerms = expected.responseCharacteristics?.webSearchQueryShouldContain
    if (!expectedTerms || expectedTerms.length === 0) {
      return { name: "web-search-query", score: 1, passed: true, details: "No web search query requirements" }
    }

    const searchQueries =
      output.toolCalls
        ?.filter((tc) => tc.name === "web_search")
        .map((tc) => tc.args.query)
        .filter((query): query is string => typeof query === "string") ?? []

    if (searchQueries.length === 0) {
      return { name: "web-search-query", score: 0, passed: false, details: "No web search query found" }
    }

    const combinedQueries = searchQueries.join(" ").toLowerCase()
    const found = expectedTerms.filter((term) => combinedQueries.includes(term.toLowerCase()))
    const missing = expectedTerms.filter((term) => !combinedQueries.includes(term.toLowerCase()))
    const score = found.length / expectedTerms.length

    return {
      name: "web-search-query",
      score,
      passed: missing.length === 0,
      details: missing.length > 0 ? `Search query missing: ${missing.map((s) => `"${s}"`).join(", ")}` : undefined,
    }
  },
}

// =============================================================================
// Run-Level Evaluators
// =============================================================================

/**
 * Overall accuracy across all cases.
 */
export const accuracyEvaluator: RunEvaluator<CompanionOutput, CompanionExpected> = {
  name: "accuracy",
  evaluate: (results: CaseResult<CompanionOutput, CompanionExpected>[]) => {
    const validResults = results.filter((r) => !r.error)
    if (validResults.length === 0) {
      return { name: "accuracy", score: 0, passed: false, details: "No valid results" }
    }

    const allPassed = validResults.filter((r) => r.evaluations.every((e) => e.passed)).length
    const accuracy = allPassed / validResults.length

    return {
      name: "accuracy",
      score: accuracy,
      passed: accuracy >= 0.7,
      details: `${allPassed}/${validResults.length} cases passed all evaluations (${(accuracy * 100).toFixed(1)}%)`,
    }
  },
}

/**
 * Response rate accuracy (correctly deciding when to respond).
 */
export const responseDecisionAccuracyEvaluator: RunEvaluator<CompanionOutput, CompanionExpected> = {
  name: "response-decision-accuracy",
  evaluate: (results: CaseResult<CompanionOutput, CompanionExpected>[]) => {
    const validResults = results.filter((r) => !r.error)
    if (validResults.length === 0) {
      return { name: "response-decision-accuracy", score: 0, passed: false, details: "No valid results" }
    }

    const correctDecisions = validResults.filter((r) => {
      const shouldRespondEval = r.evaluations.find((e) => e.name === "should-respond")
      return shouldRespondEval?.passed ?? false
    }).length

    const accuracy = correctDecisions / validResults.length

    return {
      name: "response-decision-accuracy",
      score: accuracy,
      passed: accuracy >= 0.9,
      details: `${correctDecisions}/${validResults.length} correct response decisions (${(accuracy * 100).toFixed(1)}%)`,
    }
  },
}

/**
 * Average quality score across responses.
 */
export const averageQualityEvaluator: RunEvaluator<CompanionOutput, CompanionExpected> = {
  name: "average-quality",
  evaluate: (results: CaseResult<CompanionOutput, CompanionExpected>[]) => {
    const qualityScores = results
      .filter((r) => !r.error)
      .map((r) => r.evaluations.find((e) => e.name === "response-quality"))
      .filter((e): e is NonNullable<typeof e> => e !== undefined)
      .map((e) => e.score)

    if (qualityScores.length === 0) {
      return { name: "average-quality", score: 0, passed: false, details: "No quality scores" }
    }

    const averageScore = qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length

    return {
      name: "average-quality",
      score: averageScore,
      passed: averageScore >= 0.7,
      details: `Average quality: ${(averageScore * 100).toFixed(1)}%`,
    }
  },
}
