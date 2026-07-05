/**
 * Memorizer Evaluators
 */

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
