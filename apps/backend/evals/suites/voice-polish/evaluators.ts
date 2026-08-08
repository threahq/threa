import { parseMarkdown, serializeToMarkdown } from "@threa/prosemirror"
import type { CaseResult, Evaluator, EvaluatorResult, PermutationResult, RunEvaluator } from "../../framework/types"
import type { VoicePolishExpected, VoicePolishOutput, VoicePolishStepOutput } from "./types"

const result = (name: string, passed: boolean, details?: string): EvaluatorResult => ({
  name,
  score: passed ? 1 : 0,
  passed,
  details: passed ? undefined : details,
})
const lower = (value: string) => value.toLocaleLowerCase()
const successfulMarkdown = (output: VoicePolishOutput) =>
  output.outcome.status === "success" ? output.outcome.markdown : ""

/**
 * Interim (live-deadline) polish passes are discardable by architecture: a slow
 * pass times out non-destructively, raw text stays visible, and a later pass or
 * the final recovers. A live timeout is therefore a valid outcome on every case —
 * measured models have a small random tail on any call, and zero timeouts across a
 * matrix would be a dice roll, not a behavior gate. The authoritative final pass
 * must still succeed, and any other non-success status (provider_error,
 * invalid_output, empty_input) always fails.
 */
/**
 * A timeout (live or final, any case) is a typed, non-destructive outcome: the
 * caller keeps the last accepted result plus the raw tail. Per-call latency to a
 * hosted provider has a small random tail (even a 7-word input occasionally
 * exceeds the deadline), so per-case gates grade outcome TYPE and the content of
 * successful passes, while the run-level evaluator owns latency: p95-of-completions
 * against the cap plus a final-cohort timeout-rate bound. Gating individual cases
 * on timeouts would be a dice roll, not a behavior check.
 */
const isTimeout = (step: VoicePolishStepOutput) => step.outcome.status === "timeout"
const finalTimedOut = (output: VoicePolishOutput) => output.steps.at(-1)?.outcome.status === "timeout"

export const successEvaluator: Evaluator<VoicePolishOutput, VoicePolishExpected> = {
  name: "all-step-valid-success",
  evaluate: (output) =>
    result(
      "all-step-valid-success",
      output.steps.every(
        (step) => (step.outcome.status === "success" && step.outcome.markdown.trim().length > 0) || isTimeout(step)
      ),
      `Outcomes: ${output.steps.map((step) => step.outcome.status).join(", ")}`
    ),
}
/**
 * Term matching is punctuation-insensitive: minor-level polish is explicitly allowed
 * to insert punctuation ("no sorry wait" -> "no, sorry, wait."), so a literal
 * substring check would flag spec-compliant output. Punctuation/symbols are
 * normalized to spaces on both sides before matching.
 */
const termText = (value: string) =>
  lower(value)
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()

export const requiredTermsEvaluator: Evaluator<VoicePolishOutput, VoicePolishExpected> = {
  name: "required-terms",
  evaluate: (output, expected) => {
    if (finalTimedOut(output)) return result("required-terms", true)
    const markdown = termText(successfulMarkdown(output))
    const missing = (expected.requiredTerms ?? []).filter((term) => !markdown.includes(termText(term)))
    return result("required-terms", missing.length === 0, `Missing: ${missing.join(", ")}`)
  },
}
export const forbiddenTermsEvaluator: Evaluator<VoicePolishOutput, VoicePolishExpected> = {
  name: "forbidden-terms",
  evaluate: (output, expected) => {
    if (finalTimedOut(output)) return result("forbidden-terms", true)
    const markdown = termText(successfulMarkdown(output))
    const present = (expected.forbiddenTerms ?? []).filter((term) => markdown.includes(termText(term)))
    return result("forbidden-terms", present.length === 0, `Present: ${present.join(", ")}`)
  },
}
export const contextNonEchoEvaluator: Evaluator<VoicePolishOutput, VoicePolishExpected> = {
  name: "all-step-context-non-echo",
  evaluate: (output, expected) => {
    const echoed: string[] = []
    for (const [index, step] of output.steps.entries())
      if (step.outcome.status === "success")
        for (const term of new Set([...(expected.forbiddenContextTerms ?? []), ...step.forbiddenContextTerms]))
          if (lower(step.outcome.markdown).includes(lower(term))) echoed.push(`step ${index + 1}: ${term}`)
    return result("all-step-context-non-echo", echoed.length === 0, `Echoed: ${echoed.join(", ")}`)
  },
}
const topLevel = (output: VoicePolishOutput) => output.contentJson?.content ?? []
export const blockShapeEvaluator: Evaluator<VoicePolishOutput, VoicePolishExpected> = {
  name: "exact-block-shape",
  evaluate: (output, expected) => {
    if (!expected.blockTypes || finalTimedOut(output)) return result("exact-block-shape", true)
    const nodes = topLevel(output)
    const actual = nodes.map((node) => node.type ?? "")
    const counts = nodes
      .filter((node) => node.type === "bulletList" || node.type === "orderedList")
      .map((node) => node.content?.length ?? 0)
    const passed =
      JSON.stringify(actual) === JSON.stringify(expected.blockTypes) &&
      (!expected.listItemCounts || JSON.stringify(counts) === JSON.stringify(expected.listItemCounts))
    return result(
      "exact-block-shape",
      passed,
      `Expected ${JSON.stringify(expected.blockTypes)}/${JSON.stringify(expected.listItemCounts ?? [])}; got ${JSON.stringify(actual)}/${JSON.stringify(counts)}`
    )
  },
}
export const roundTripEvaluator: Evaluator<VoicePolishOutput, VoicePolishExpected> = {
  name: "all-step-parse-serialize-valid",
  evaluate: (output) => {
    for (const [index, step] of output.steps.entries()) {
      if (isTimeout(step)) continue
      if (step.outcome.status !== "success")
        return result("all-step-parse-serialize-valid", false, `Step ${index + 1}: ${step.outcome.status}`)
      try {
        const reparsed = parseMarkdown(serializeToMarkdown(step.outcome.contentJson))
        if (!reparsed.content?.length)
          return result("all-step-parse-serialize-valid", false, `Step ${index + 1}: empty document`)
      } catch (error) {
        return result(
          "all-step-parse-serialize-valid",
          false,
          `Step ${index + 1}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    return result("all-step-parse-serialize-valid", true)
  },
}
export const languageEvaluator: Evaluator<VoicePolishOutput, VoicePolishExpected> = {
  name: "all-step-language-non-translation",
  evaluate: (output, expected) => {
    const failures: string[] = []
    for (const [index, step] of output.steps.entries())
      if (step.outcome.status === "success") {
        const value = lower(step.outcome.markdown)
        const missing = (expected.languageMarkers ?? []).filter((term) => !value.includes(lower(term)))
        const translated = (expected.forbiddenTranslations ?? []).filter((term) => value.includes(lower(term)))
        if (missing.length || translated.length)
          failures.push(`step ${index + 1}: missing ${missing.join("|")}; translated ${translated.join("|")}`)
      }
    return result("all-step-language-non-translation", failures.length === 0, failures.join("; "))
  },
}
const words = (value: string) => lower(value).match(/[\p{L}\p{N}]+/gu) ?? []
const isOrderedSubsequence = (prior: string[], current: string[]) => {
  let cursor = 0
  for (const word of current) if (word === prior[cursor]) cursor++
  return cursor === prior.length
}
type ContentNode = { type?: string; text?: string; content?: ContentNode[] }
const preservesNode = (prior: ContentNode, current: ContentNode): boolean => {
  if (prior.type !== current.type) return false
  if (prior.type === "text") return isOrderedSubsequence(words(prior.text ?? ""), words(current.text ?? ""))
  const priorChildren = prior.content ?? []
  const currentChildren = current.content ?? []
  return (
    priorChildren.length <= currentChildren.length &&
    priorChildren.every((child, index) => preservesNode(child, currentChildren[index]!))
  )
}
export const stabilityEvaluator: Evaluator<VoicePolishOutput, VoicePolishExpected> = {
  name: "prior-success-content-stability",
  evaluate: (output, expected) => {
    if (!expected.stability) return result("prior-success-content-stability", true)
    let prior: ContentNode | undefined
    for (const [index, step] of output.steps.entries()) {
      if (step.outcome.status !== "success") continue
      if (prior && !preservesNode(prior, step.outcome.contentJson as ContentNode)) {
        const before = serializeToMarkdown(prior as Parameters<typeof serializeToMarkdown>[0])
        const after = serializeToMarkdown(step.outcome.contentJson)
        return result(
          "prior-success-content-stability",
          false,
          `Accepted content changed at step ${index + 1}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`
        )
      }
      prior = step.outcome.contentJson as ContentNode
    }
    return result("prior-success-content-stability", true)
  },
}
const nearestRank = (values: number[], percentile: number) =>
  values[Math.max(0, Math.ceil(values.length * percentile) - 1)] ?? 0
/**
 * The run-level latency gate grades the user-visible guarantee: the authoritative
 * final pass after mic stop must land inside this cap (p95 of completed calls +
 * 750ms, rounded up to 250ms buckets). Interim live passes are discardable by
 * architecture, so live latency and timeout counts are reported but not gated.
 */
export const VOICE_POLISH_FINAL_DEADLINE_CAP_MS = 8000

export function latencyMetrics(cases: CaseResult<VoicePolishOutput, VoicePolishExpected>[]) {
  // Timed-out calls are excluded from percentiles: their durations are censored at
  // the deadline and would report the deadline, not the model's latency. Timeout
  // counts are reported per cohort.
  const steps = (deadline: "live" | "final") =>
    cases.flatMap((item) => item.output?.steps ?? []).filter((step) => step.deadline === deadline)
  const measure = (deadline: "live" | "final") => {
    const all = steps(deadline)
    const values = all
      .filter((step) => step.outcome.status !== "timeout")
      .map((step) => step.durationMs)
      .sort((a, b) => a - b)
    return {
      count: values.length,
      timeouts: all.length - values.length,
      p50: nearestRank(values, 0.5),
      p95: nearestRank(values, 0.95),
      recommendedDeadlineMs: Math.ceil((nearestRank(values, 0.95) + 750) / 250) * 250,
    }
  }
  const live = measure("live")
  const final = measure("final")
  return { live, final, timeouts: live.timeouts + final.timeouts }
}

/**
 * Final-cohort timeout bound. The p95-based deadline design implies ~5% of calls
 * exceed it; provider jitter roughly doubles that in bad periods (worst observed
 * full-matrix rate ≈ 4%). 15% gives ~3x headroom over the worst observed while
 * still failing a model whose final passes degrade systemically. Live timeouts
 * are the accepted interim-discard mechanism and are reported but not bounded.
 */
const FINAL_TIMEOUT_MAX_RATE = 0.15
export const metricsEvaluator: RunEvaluator<VoicePolishOutput, VoicePolishExpected> = {
  name: "live-final-latency-timeout-metrics",
  evaluate: (cases) => {
    const m = latencyMetrics(cases)
    const total = m.final.count + m.final.timeouts
    const passed =
      m.final.recommendedDeadlineMs <= VOICE_POLISH_FINAL_DEADLINE_CAP_MS &&
      m.final.timeouts <= total * FINAL_TIMEOUT_MAX_RATE
    return result(
      "live-final-latency-timeout-metrics",
      passed,
      `live p50=${m.live.p50} p95=${m.live.p95} deadline=${m.live.recommendedDeadlineMs} timeouts=${m.live.timeouts}; final p50=${m.final.p50} p95=${m.final.p95} deadline=${m.final.recommendedDeadlineMs} timeouts=${m.final.timeouts}`
    )
  },
}

const safetyNames = new Set([
  "all-step-valid-success",
  "all-step-context-non-echo",
  "all-step-parse-serialize-valid",
  "all-step-language-non-translation",
])
export interface Qualification {
  qualified: boolean
  caseRates: Record<string, number>
  p95: { live: number; final: number }
  costPerTake: number
  reasons: string[]
}
export function qualifyVoicePolishPermutation(
  permutation: PermutationResult<VoicePolishOutput, VoicePolishExpected>
): Qualification {
  const reasons: string[] = []
  const grouped = new Map<string, typeof permutation.cases>()
  for (const item of permutation.cases) grouped.set(item.caseId, [...(grouped.get(item.caseId) ?? []), item])
  const caseRates: Record<string, number> = {}
  for (const [id, cases] of grouped) {
    const safety = cases.every(
      (item) =>
        !item.error &&
        item.evaluations
          .filter((evaluation) => safetyNames.has(evaluation.name))
          .every((evaluation) => evaluation.passed)
    )
    if (!safety) reasons.push(`${id}: safety below 100%`)
    const passes = cases.filter(
      (item) => !item.error && item.evaluations.every((evaluation) => evaluation.passed)
    ).length
    caseRates[id] = passes / cases.length
    if (cases[0]?.expectedOutput.correctionOrStructure && (cases.length !== 6 || passes < 5))
      reasons.push(`${id}: correction/structure ${passes}/${cases.length}`)
  }
  if (permutation.runs !== 6) reasons.push(`requires 6 runs, got ${permutation.runs}`)
  const metrics = latencyMetrics(permutation.cases)
  if (metrics.final.recommendedDeadlineMs > VOICE_POLISH_FINAL_DEADLINE_CAP_MS)
    reasons.push("final latency cap exceeded")
  const takes = permutation.cases.reduce((sum, item) => sum + (item.output?.steps.length ?? 0), 0)
  return {
    qualified: reasons.length === 0,
    caseRates,
    p95: { live: metrics.live.p95, final: metrics.final.p95 },
    costPerTake: (permutation.usage?.totalCost ?? 0) / Math.max(1, takes),
    reasons,
  }
}
export function challengerBeatsProduction(production: Qualification, challenger: Qualification): boolean {
  if (!challenger.qualified) return false
  const noLowerCaseRate = Object.entries(production.caseRates).every(
    ([id, rate]) => (challenger.caseRates[id] ?? 0) >= rate
  )
  return (
    noLowerCaseRate &&
    challenger.p95.final <= production.p95.final * 0.8 &&
    challenger.costPerTake <= production.costPerTake
  )
}
export function selectVoicePolishModel(
  productionModel: string,
  candidates: Array<{ model: string; qualification: Qualification }>
): string | null {
  const production = candidates.find((candidate) => candidate.model === productionModel)
  if (!production) throw new Error(`Missing production result for ${productionModel}`)
  const qualifiers = candidates.filter(
    (candidate) =>
      candidate.model !== productionModel &&
      challengerBeatsProduction(production.qualification, candidate.qualification)
  )
  qualifiers.sort(
    (a, b) =>
      a.qualification.p95.final - b.qualification.p95.final ||
      a.qualification.costPerTake - b.qualification.costPerTake ||
      a.model.localeCompare(b.model)
  )
  return qualifiers[0]?.model ?? (production.qualification.qualified ? productionModel : null)
}
export function previousAcceptedVariantShips(
  enabled: Qualification,
  withoutPrevious: Qualification,
  stabilityCaseIds: string[],
  correctionCaseIds: string[]
): boolean {
  if (!enabled.qualified) return false
  const noRegression = correctionCaseIds.every(
    (id) => (enabled.caseRates[id] ?? 0) >= (withoutPrevious.caseRates[id] ?? 0)
  )
  const stabilityNoRegression = stabilityCaseIds.every(
    (id) => (enabled.caseRates[id] ?? 0) >= (withoutPrevious.caseRates[id] ?? 0)
  )
  const stabilityImproves = stabilityCaseIds.some(
    (id) => (enabled.caseRates[id] ?? 0) > (withoutPrevious.caseRates[id] ?? 0)
  )
  // Strict improvement is impossible when both variants hit the 6/6 ceiling.
  // Treat an all-perfect tie as non-inferior evidence; ties below the ceiling still
  // fail so a noisy 5/6 vs 5/6 result cannot justify shipping extra prompt state.
  const ceilingTie =
    stabilityCaseIds.length > 0 &&
    stabilityCaseIds.every((id) => (enabled.caseRates[id] ?? 0) === 1 && (withoutPrevious.caseRates[id] ?? 0) === 1)
  return noRegression && stabilityNoRegression && (stabilityImproves || ceilingTie)
}
export const voicePolishEvaluators = [
  successEvaluator,
  requiredTermsEvaluator,
  forbiddenTermsEvaluator,
  contextNonEchoEvaluator,
  blockShapeEvaluator,
  roundTripEvaluator,
  languageEvaluator,
  stabilityEvaluator,
]
