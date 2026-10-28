/**
 * Doc Edit Evaluators
 *
 * Deterministic checks on the readback: whether the turn wrote, how many
 * writes it applied, which sections moved, and that each write carried a reason.
 */

import type { Evaluator, EvaluatorResult, RunEvaluator, CaseResult } from "../../framework/types"
import type { DocEditOutput, DocEditExpected, DocSectionChange } from "./types"
import { DOC_EDIT_ACCURACY_GATE } from "./config"

type DocEditCase = CaseResult<DocEditOutput, DocEditExpected>

export function diffSections(
  baseline: Map<string, string>,
  after: Map<string, string>
): { touchedSections: DocSectionChange[]; removedBlockIds: string[] } {
  const touchedSections: DocSectionChange[] = []
  for (const [blockId, markdown] of after) {
    const before = baseline.get(blockId) ?? null
    if (before !== markdown) touchedSections.push({ blockId, before, after: markdown })
  }
  return { touchedSections, removedBlockIds: [...baseline.keys()].filter((blockId) => !after.has(blockId)) }
}

function errored(name: string, error: string): EvaluatorResult {
  return { name, score: 0, passed: false, details: `Error: ${error}` }
}

function verdict(name: string, failure: string | null): EvaluatorResult {
  return { name, score: failure ? 0 : 1, passed: !failure, details: failure ?? undefined }
}

/** Evaluators that only judge a turn expected to write: skipped otherwise, failed on a task error. */
function writeCaseEvaluator(
  name: string,
  failure: (output: DocEditOutput, expected: DocEditExpected) => string | null
): Evaluator<DocEditOutput, DocEditExpected> {
  return {
    name,
    evaluate: (output, expected): EvaluatorResult => {
      if (!expected.shouldWrite) return { name, score: 1, passed: true, details: "Not a write-expected case" }
      if (output.error) return errored(name, output.error)
      return verdict(name, failure(output, expected))
    },
  }
}

export const writeDecisionEvaluator: Evaluator<DocEditOutput, DocEditExpected> = {
  name: "write-decision",
  evaluate: (output, expected): EvaluatorResult => {
    if (output.error) return errored("write-decision", output.error)
    if (output.wrote === expected.shouldWrite) return verdict("write-decision", null)
    return verdict(
      "write-decision",
      expected.shouldWrite
        ? "Expected a doc write; none happened"
        : "Doc was written on a turn that should leave it alone"
    )
  },
}

/** One applied write per request; a retry after `not_found` still lands exactly one. */
export const singleWriteEvaluator = writeCaseEvaluator("single-write", (output) => {
  if (output.writeCount === 1) return null
  const kinds = [
    `${output.personaUpdateCount} doc updates`,
    `${output.createdDocCount} created docs`,
    `title ${output.titleChanged ? "changed" : "unchanged"}`,
  ]
  return `Turn applied ${output.writeCount} writes (expected exactly 1): ${kinds.join(", ")}`
})

function droppedLines(section: DocSectionChange, replaceableLine: RegExp | undefined): string[] {
  if (section.before === null) return []
  const kept = new Set(section.after.split("\n").map((line) => line.trim()))
  return section.before
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !replaceableLine?.test(line) && !kept.has(line))
}

export const scopedChangeEvaluator = writeCaseEvaluator("scoped-change", (output, expected) => {
  const touched = output.touchedSections
  const failures: string[] = []
  if (expected.maxTouchedSections !== undefined && touched.length > expected.maxTouchedSections) {
    failures.push(`${touched.length} sections changed or added (max ${expected.maxTouchedSections})`)
  }
  if (output.removedBlockIds.length > 0) {
    failures.push(`removed blocks ${output.removedBlockIds.join(", ")}`)
  }
  for (const section of touched) {
    for (const line of droppedLines(section, expected.replaceableLine)) {
      failures.push(`dropped line "${line}" in ${section.blockId}`)
    }
  }
  const pattern = expected.touchedSectionMustMatch
  if (pattern && !touched.some((section) => pattern.test(section.after))) {
    failures.push(`no changed or added section matches ${pattern}`)
  }
  return failures.length > 0 ? failures.join("; ") : null
})

export const reasonPresentEvaluator = writeCaseEvaluator("reason-present", (output) => {
  if (output.reasons.length < output.personaUpdateCount) {
    return `${output.personaUpdateCount} persona updates but ${output.reasons.length} doc:edited events`
  }
  const blank = output.reasons.filter((reason) => reason.trim() === "").length
  return blank === 0 ? null : `${blank} of ${output.reasons.length} edits had no reason`
})

export const accuracyEvaluator: RunEvaluator<DocEditOutput, DocEditExpected> = {
  name: "accuracy",
  evaluate: (cases: DocEditCase[]): EvaluatorResult => {
    const passed = cases.filter((c) => !c.error && c.evaluations.every((e) => e.passed))
    const score = cases.length > 0 ? passed.length / cases.length : 0
    return {
      name: "accuracy",
      score,
      passed: score >= DOC_EDIT_ACCURACY_GATE,
      details: `${passed.length}/${cases.length} cases passed`,
    }
  },
}
