/**
 * Memorizer Evaluators
 */

import { z } from "zod"
import type { Evaluator, EvaluatorResult, RunEvaluator, CaseResult } from "../../framework/types"
import type { MemorizerOutput, MemorizerExpected } from "./types"

function memoText(m: { title: string; abstract: string }): string {
  return `${m.title} ${m.abstract}`.toLowerCase()
}

export const memoCountEvaluator: Evaluator<MemorizerOutput, MemorizerExpected> = {
  name: "memo-count",
  evaluate: (output, expected): EvaluatorResult => {
    if (output.error) {
      return { name: "memo-count", score: 0, passed: false, details: `Error: ${output.error}` }
    }
    const count = output.memos.length
    const max = expected.maxMemos ?? Infinity
    const min = expected.minMemos ?? 0
    const passed = count <= max && count >= min
    return {
      name: "memo-count",
      score: passed ? 1 : 0,
      passed,
      details: passed
        ? undefined
        : `Got ${count} memos (expected ${min}–${max === Infinity ? "∞" : max}): ${output.memos.map((m) => m.title).join(" | ")}`,
    }
  },
}

export const coverageEvaluator: Evaluator<MemorizerOutput, MemorizerExpected> = {
  name: "coverage",
  evaluate: (output, expected): EvaluatorResult => {
    if (!expected.mustCoverAny || expected.mustCoverAny.length === 0) {
      return { name: "coverage", score: 1, passed: true, details: "No coverage requirements" }
    }
    if (output.error) {
      return { name: "coverage", score: 0, passed: false, details: `Error: ${output.error}` }
    }
    const texts = output.memos.map(memoText)
    const unmet = expected.mustCoverAny.filter(
      (group) => !texts.some((t) => group.some((word) => t.includes(word.toLowerCase())))
    )
    const passed = unmet.length === 0
    return {
      name: "coverage",
      score: 1 - unmet.length / expected.mustCoverAny.length,
      passed,
      details: passed ? undefined : `No memo covers: ${unmet.map((g) => g.join("/")).join("; ")}`,
    }
  },
}

export const exclusionEvaluator: Evaluator<MemorizerOutput, MemorizerExpected> = {
  name: "exclusion",
  evaluate: (output, expected): EvaluatorResult => {
    if (!expected.mustNotContain || expected.mustNotContain.length === 0) {
      return { name: "exclusion", score: 1, passed: true, details: "No exclusion requirements" }
    }
    if (output.error) {
      return { name: "exclusion", score: 0, passed: false, details: `Error: ${output.error}` }
    }
    const offenders: string[] = []
    for (const memo of output.memos) {
      const text = memoText(memo)
      for (const word of expected.mustNotContain) {
        if (text.includes(word.toLowerCase())) offenders.push(`"${memo.title}" contains "${word}"`)
      }
    }
    const passed = offenders.length === 0
    return {
      name: "exclusion",
      score: passed ? 1 : 0,
      passed,
      details: passed ? undefined : offenders.join("; "),
    }
  },
}

const conclusionJudgeSchema = z.object({
  assertsConclusionA: z
    .boolean()
    .nullable()
    .describe(
      "true if at least one memo states conclusion A as the outcome; false if none does; null when A was not given"
    ),
  assertsConclusionB: z
    .boolean()
    .nullable()
    .describe(
      "true if at least one memo states conclusion B as the outcome; false if none does; null when B was not given"
    ),
  reasoning: z.string().describe("One brief sentence"),
})

/**
 * Semantic direction check (LLM-judged). A decision memo can mention both sides
 * of a choice, so keyword checks cannot tell "chose X over Y" from the inverted
 * "chose Y over X" — the observed prod failure. The judge reads the memos and
 * answers whether any memo asserts the required / forbidden conclusion.
 */
export const conclusionEvaluator: Evaluator<MemorizerOutput, MemorizerExpected> = {
  name: "conclusion-direction",
  evaluate: async (output, expected, ctx): Promise<EvaluatorResult> => {
    if (!expected.conclusionMustState && !expected.conclusionMustNotState) {
      return { name: "conclusion-direction", score: 1, passed: true, details: "No conclusion requirements" }
    }
    if (output.error) {
      return { name: "conclusion-direction", score: 0, passed: false, details: `Error: ${output.error}` }
    }
    if (output.memos.length === 0) {
      // No memos: a required conclusion is missing; a forbidden one is trivially absent.
      const passed = !expected.conclusionMustState
      return {
        name: "conclusion-direction",
        score: passed ? 1 : 0,
        passed,
        details: passed ? undefined : "No memos emitted, but a conclusion was required",
      }
    }

    const memosRendered = output.memos
      .map((m, i) => `${i + 1}. ${m.title}\n   ${m.abstract}\n   Key points: ${m.keyPoints.join("; ") || "—"}`)
      .join("\n")
    const { value } = await ctx.ai.generateObject({
      model: "openrouter:openai/gpt-5.4-nano",
      schema: conclusionJudgeSchema,
      messages: [
        {
          role: "system",
          content:
            "You read a set of memos and, for each candidate conclusion given, answer purely factually whether any memo states that conclusion as the outcome/decision. A memo asserts a conclusion only when it presents it as what was decided or what holds — mentioning a position as considered-and-rejected does not assert it. Do not judge whether asserting it is good or expected; only whether it is asserted.",
        },
        {
          role: "user",
          content: `## Memos\n${memosRendered}\n\n## Conclusion A\n${expected.conclusionMustState ?? "(not given — return null for assertsConclusionA)"}\n\n## Conclusion B\n${expected.conclusionMustNotState ?? "(not given — return null for assertsConclusionB)"}\n\nDoes any memo assert conclusion A? Does any memo assert conclusion B?`,
        },
      ],
      temperature: 0,
      telemetry: { functionId: "eval-conclusion-direction" },
    })

    const requiredOk = !expected.conclusionMustState || value.assertsConclusionA === true
    const forbiddenOk = !expected.conclusionMustNotState || value.assertsConclusionB !== true
    const passed = requiredOk && forbiddenOk
    return {
      name: "conclusion-direction",
      score: passed ? 1 : 0,
      passed,
      details: passed
        ? undefined
        : `${!requiredOk ? "required conclusion not asserted" : ""}${!requiredOk && !forbiddenOk ? "; " : ""}${!forbiddenOk ? "forbidden conclusion asserted" : ""} — ${value.reasoning}`,
    }
  },
}

/** A reversal must retire the memo it contradicts via supersedesMemoIds. */
export const supersessionEvaluator: Evaluator<MemorizerOutput, MemorizerExpected> = {
  name: "supersession",
  evaluate: (output, expected): EvaluatorResult => {
    if (!expected.expectSupersedesExisting) {
      return { name: "supersession", score: 1, passed: true, details: "No supersession requirements" }
    }
    if (output.error) {
      return { name: "supersession", score: 0, passed: false, details: `Error: ${output.error}` }
    }
    const passed = output.memos.some((m) => m.supersedesMemoIds.length > 0)
    return {
      name: "supersession",
      score: passed ? 1 : 0,
      passed,
      details: passed ? undefined : "No memo explicitly superseded an existing memo (reversal left both standing)",
    }
  },
}

export const accuracyEvaluator: RunEvaluator<MemorizerOutput, MemorizerExpected> = {
  name: "accuracy",
  evaluate: (cases: CaseResult<MemorizerOutput, MemorizerExpected>[]): EvaluatorResult => {
    const passed = cases.filter((c) => !c.error && c.evaluations.every((e) => e.passed))
    const score = cases.length > 0 ? passed.length / cases.length : 0
    return { name: "accuracy", score, passed: score >= 0.8, details: `${passed.length}/${cases.length} cases passed` }
  },
}

/** Run-level: memos emitted on cases expecting none — the re-capture/noise metric. */
export const overCaptureRateEvaluator: RunEvaluator<MemorizerOutput, MemorizerExpected> = {
  name: "over-capture-rate",
  evaluate: (cases: CaseResult<MemorizerOutput, MemorizerExpected>[]): EvaluatorResult => {
    const expectEmpty = cases.filter((c) => c.expectedOutput.maxMemos === 0 && c.output)
    if (expectEmpty.length === 0) {
      return { name: "over-capture-rate", score: 1, passed: true, details: "No expect-empty cases in run" }
    }
    const leaked = expectEmpty.filter((c) => c.output.memos.length > 0)
    const rate = leaked.length / expectEmpty.length
    return {
      name: "over-capture-rate",
      score: 1 - rate,
      passed: rate === 0,
      details: `${leaked.length}/${expectEmpty.length} expect-empty conversations produced memos`,
    }
  },
}
