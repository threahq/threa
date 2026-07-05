/**
 * Memo Classifier Evaluators
 */

import type { Evaluator, EvaluatorResult, RunEvaluator, CaseResult } from "../../framework/types"
import type { MemoClassifierOutput, MemoClassifierExpected } from "./types"

/** Core gate: did the classifier make the right knowledge-worthiness call? */
export const worthinessEvaluator: Evaluator<MemoClassifierOutput, MemoClassifierExpected> = {
  name: "worthiness",
  evaluate: (output, expected): EvaluatorResult => {
    if (output.error) {
      return { name: "worthiness", score: 0, passed: false, details: `Error: ${output.error}` }
    }
    const passed = output.isKnowledgeWorthy === expected.expectKnowledgeWorthy
    return {
      name: "worthiness",
      score: passed ? 1 : 0,
      passed,
      details: passed
        ? undefined
        : `Expected isKnowledgeWorthy=${expected.expectKnowledgeWorthy}, got ${output.isKnowledgeWorthy} (confidence ${output.confidence.toFixed(2)})`,
    }
  },
}

/** Revision gate, asserted only when the case defines it. */
export const revisionEvaluator: Evaluator<MemoClassifierOutput, MemoClassifierExpected> = {
  name: "revision",
  evaluate: (output, expected): EvaluatorResult => {
    if (expected.expectReviseExisting === undefined) {
      return { name: "revision", score: 1, passed: true, details: "No revision requirement" }
    }
    if (output.error) {
      return { name: "revision", score: 0, passed: false, details: `Error: ${output.error}` }
    }
    const passed = output.shouldReviseExisting === expected.expectReviseExisting
    return {
      name: "revision",
      score: passed ? 1 : 0,
      passed,
      details: passed
        ? undefined
        : `Expected shouldReviseExisting=${expected.expectReviseExisting}, got ${output.shouldReviseExisting}`,
    }
  },
}

export const accuracyEvaluator: RunEvaluator<MemoClassifierOutput, MemoClassifierExpected> = {
  name: "accuracy",
  evaluate: (cases: CaseResult<MemoClassifierOutput, MemoClassifierExpected>[]): EvaluatorResult => {
    const passed = cases.filter((c) => !c.error && c.evaluations.every((e) => e.passed))
    const score = cases.length > 0 ? passed.length / cases.length : 0
    return { name: "accuracy", score, passed: score >= 0.8, details: `${passed.length}/${cases.length} cases passed` }
  },
}

/**
 * The production failure mode this suite exists for: chatter classified as
 * knowledge. Measures how much of the not-worthy set leaks through.
 */
export const garbageLeakRateEvaluator: RunEvaluator<MemoClassifierOutput, MemoClassifierExpected> = {
  name: "garbage-leak-rate",
  evaluate: (cases: CaseResult<MemoClassifierOutput, MemoClassifierExpected>[]): EvaluatorResult => {
    const notWorthy = cases.filter((c) => c.expectedOutput?.expectKnowledgeWorthy === false && c.output)
    if (notWorthy.length === 0) {
      return { name: "garbage-leak-rate", score: 1, passed: true, details: "No not-worthy cases in run" }
    }
    const leaked = notWorthy.filter((c) => c.output!.isKnowledgeWorthy)
    const rate = leaked.length / notWorthy.length
    return {
      name: "garbage-leak-rate",
      score: 1 - rate,
      passed: rate === 0,
      details: `${leaked.length}/${notWorthy.length} chatter conversations classified as knowledge`,
    }
  },
}
