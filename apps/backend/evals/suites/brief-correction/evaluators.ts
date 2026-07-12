/**
 * Brief Correction Evaluators
 *
 * Deterministic checks on the write decision and the revision delta, plus an
 * LLM-judged semantic check that a reversal actually replaced the old fact
 * rather than sitting alongside it.
 */

import { z } from "zod"
import type { Evaluator, EvaluatorResult, RunEvaluator, CaseResult } from "../../framework/types"
import type { BriefCorrectionOutput, BriefCorrectionExpected } from "./types"
import { BRIEF_JUDGE_MODEL, CHITCHAT_NO_WRITE_GATE, BRIEF_ACCURACY_GATE } from "./config"

type BriefCase = CaseResult<BriefCorrectionOutput, BriefCorrectionExpected>

/** The core arm: did the turn write the brief exactly when it should have? */
export const writeDecisionEvaluator: Evaluator<BriefCorrectionOutput, BriefCorrectionExpected> = {
  name: "write-decision",
  evaluate: (output, expected): EvaluatorResult => {
    if (output.error) {
      return { name: "write-decision", score: 0, passed: false, details: `Error: ${output.error}` }
    }
    const passed = output.wrote === expected.shouldWrite
    const failure = expected.shouldWrite
      ? "Expected a brief write; none happened"
      : "Brief was written on a turn that should have left it untouched"
    return {
      name: "write-decision",
      score: passed ? 1 : 0,
      passed,
      details: passed ? undefined : failure,
    }
  },
}

/**
 * A brief update is a single full replacement — one new revision, one version
 * bump. More than one added revision means the turn wrote the brief repeatedly
 * (a loop, or append-then-fix), which the tool's full-replacement contract
 * (roadmap 4.2) is meant to avoid. Only meaningful on write-expected cases.
 */
export const singleRevisionEvaluator: Evaluator<BriefCorrectionOutput, BriefCorrectionExpected> = {
  name: "single-revision",
  evaluate: (output, expected): EvaluatorResult => {
    if (!expected.shouldWrite) {
      return { name: "single-revision", score: 1, passed: true, details: "Not a write-expected case" }
    }
    if (output.error) {
      return { name: "single-revision", score: 0, passed: false, details: `Error: ${output.error}` }
    }
    const added = output.revisionCount - output.revisionsBefore
    const passed = added === 1
    return {
      name: "single-revision",
      score: passed ? 1 : 0,
      passed,
      details: passed ? undefined : `Turn added ${added} brief revisions (expected exactly 1)`,
    }
  },
}

const briefJudgeSchema = z.object({
  assertsRequired: z
    .boolean()
    .nullable()
    .describe(
      "true if the brief states the required fact as currently true; false if it does not; null when none was required"
    ),
  stillAssertsForbidden: z
    .boolean()
    .nullable()
    .describe(
      "true if the brief still states the contradicted/old fact as currently true; false if it does not; null when none was forbidden"
    ),
  reasoning: z.string().describe("One brief sentence"),
})

/**
 * Semantic check (LLM-judged) that the resulting brief folded the decision in
 * and, on a reversal, dropped the old value. Keyword matching can't tell "we
 * chose Postgres" from a brief that lists both MySQL and Postgres, which is
 * exactly the append-instead-of-replace failure — so a judge reads the final
 * brief and answers whether each fact is asserted as current.
 */
export const briefContentEvaluator: Evaluator<BriefCorrectionOutput, BriefCorrectionExpected> = {
  name: "brief-content",
  evaluate: async (output, expected, ctx): Promise<EvaluatorResult> => {
    if (!expected.briefMustState && !expected.briefMustNotState) {
      return { name: "brief-content", score: 1, passed: true, details: "No content requirements" }
    }
    if (output.error) {
      return { name: "brief-content", score: 0, passed: false, details: `Error: ${output.error}` }
    }
    if (!output.briefContent) {
      // Nothing was written: a required fact is missing; a forbidden one is trivially absent.
      const passed = !expected.briefMustState
      return {
        name: "brief-content",
        score: passed ? 1 : 0,
        passed,
        details: passed ? undefined : "Brief is empty but a fact was required",
      }
    }

    let value: z.infer<typeof briefJudgeSchema>
    try {
      ;({ value } = await ctx.ai.generateObject({
        model: BRIEF_JUDGE_MODEL,
        schema: briefJudgeSchema,
        messages: [
          {
            role: "system",
            content:
              "You read a stream's brief (a durable working document) and, for each candidate fact given, answer purely factually whether the brief states that fact as currently true. A fact is asserted only when the brief presents it as what currently holds — a struck-through or explicitly-past note ('was MySQL, now Postgres') does not assert the past value as current. Only report what the brief says, not whether it is good.",
          },
          {
            role: "user",
            content: `## Brief\n${output.briefContent}\n\n## Required fact\n${expected.briefMustState ?? "(none — return null for assertsRequired)"}\n\n## Forbidden (old/contradicted) fact\n${expected.briefMustNotState ?? "(none — return null for stillAssertsForbidden)"}\n\nDoes the brief assert the required fact as current? Does it still assert the forbidden fact as current?`,
          },
        ],
        temperature: 0,
        telemetry: { functionId: "eval-brief-content" },
      }))
    } catch (error) {
      // A judge failure fails this case's evaluator, not the whole run.
      return {
        name: "brief-content",
        score: 0,
        passed: false,
        details: `Judge error: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    const requiredOk = !expected.briefMustState || value.assertsRequired === true
    // Fail closed: an indeterminate (null) judgment on the forbidden fact must
    // not pass the append-vs-replace gate — only an explicit `false` clears it.
    const forbiddenOk = !expected.briefMustNotState || value.stillAssertsForbidden === false
    const passed = requiredOk && forbiddenOk
    return {
      name: "brief-content",
      score: passed ? 1 : 0,
      passed,
      details: passed
        ? undefined
        : `${!requiredOk ? "required fact not asserted" : ""}${!requiredOk && !forbiddenOk ? "; " : ""}${!forbiddenOk ? "old fact still present (appended, not replaced)" : ""} — ${value.reasoning}`,
    }
  },
}

export const accuracyEvaluator: RunEvaluator<BriefCorrectionOutput, BriefCorrectionExpected> = {
  name: "accuracy",
  evaluate: (cases: BriefCase[]): EvaluatorResult => {
    const passed = cases.filter((c) => !c.error && c.evaluations.every((e) => e.passed))
    const score = cases.length > 0 ? passed.length / cases.length : 0
    return {
      name: "accuracy",
      score,
      passed: score >= BRIEF_ACCURACY_GATE,
      details: `${passed.length}/${cases.length} cases passed`,
    }
  },
}

/**
 * The roadmap 4.4 gate: the fraction of chitchat turns (shouldWrite === false)
 * that correctly left the brief untouched. Tighter than accuracy because an
 * over-eager write is the trust-eroding failure this suite exists to catch.
 */
export const chitchatNoWriteRateEvaluator: RunEvaluator<BriefCorrectionOutput, BriefCorrectionExpected> = {
  name: "chitchat-no-write-rate",
  evaluate: (cases: BriefCase[]): EvaluatorResult => {
    const chitchat = cases.filter((c) => c.expectedOutput.shouldWrite === false && c.output)
    if (chitchat.length === 0) {
      return { name: "chitchat-no-write-rate", score: 1, passed: true, details: "No chitchat cases in run" }
    }
    const clean = chitchat.filter((c) => !c.output.error && !c.output.wrote)
    const rate = clean.length / chitchat.length
    return {
      name: "chitchat-no-write-rate",
      score: rate,
      passed: rate >= CHITCHAT_NO_WRITE_GATE,
      details: `${clean.length}/${chitchat.length} chitchat conversations left the brief untouched`,
    }
  },
}
