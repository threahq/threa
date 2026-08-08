import { parseMarkdown, serializeToMarkdown } from "@threa/prosemirror"
import type { CaseResult, Evaluator, EvaluatorResult, PermutationResult, RunEvaluator } from "../../framework/types"
import type { VoicePolishExpected, VoicePolishOutput, VoicePolishStepOutput } from "./types"
import {
  VOICE_POLISH_WIDEN_MAX_WINDOWS,
  VOICE_POLISH_WINDOW_MAX_CHARS,
  voicePolishConfig,
} from "../../../src/features/voice-transcription/config"

const result = (name: string, passed: boolean, details?: string): EvaluatorResult => ({
  name,
  score: passed ? 1 : 0,
  passed,
  details: passed ? undefined : details,
})
const lower = (value: string) => value.toLocaleLowerCase()
const successfulMarkdown = (output: VoicePolishOutput) => output.markdown ?? ""
const gradableStepDocument = (step: VoicePolishStepOutput) =>
  step.outcome.status === "success" ? step.outcome : step.composedDocument

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
  evaluate: (output, expected) =>
    result(
      "all-step-valid-success",
      output.steps.every((step, index) => {
        if (isTimeout(step)) return true
        if (step.outcome.status === "success") return step.outcome.markdown.trim().length > 0
        const isFinalStep = index === output.steps.length - 1
        if (step.outcome.status === "preserve_raw") return expected.expectedScope === "preserve_raw"
        if (step.outcome.status === "replacement_rejected")
          return isFinalStep && expected.expectedFinalResult === "rejected"
        return false
      }),
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
export const scopeEvaluator: Evaluator<VoicePolishOutput, VoicePolishExpected> = {
  name: "boundary-scope",
  evaluate: (output, expected) => {
    if (!expected.expectedScope || finalTimedOut(output)) return result("boundary-scope", true)
    const scoped = [...output.steps].reverse().find((step) => step.scope)
    const stable = !expected.predecessorStable || scoped?.predecessorStable === true
    return result(
      "boundary-scope",
      scoped?.scope === expected.expectedScope && stable,
      `Expected ${expected.expectedScope}; got ${scoped?.scope ?? "none"}; predecessorStable=${stable}`
    )
  },
}
export const contextNonEchoEvaluator: Evaluator<VoicePolishOutput, VoicePolishExpected> = {
  name: "all-step-context-non-echo",
  evaluate: (output, expected) => {
    const echoed: string[] = []
    for (const [index, step] of output.steps.entries()) {
      const document = gradableStepDocument(step)
      if (document?.status === "success")
        for (const term of new Set([...(expected.forbiddenContextTerms ?? []), ...step.forbiddenContextTerms]))
          if (lower(document.markdown).includes(lower(term))) echoed.push(`step ${index + 1}: ${term}`)
    }
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
      const document = gradableStepDocument(step)
      if (document?.status !== "success")
        return result("all-step-parse-serialize-valid", false, `Step ${index + 1}: ${step.outcome.status}`)
      try {
        const reparsed = parseMarkdown(serializeToMarkdown(document.contentJson))
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
    for (const [index, step] of output.steps.entries()) {
      const document = gradableStepDocument(step)
      if (document?.status !== "success") continue
      const value = lower(document.markdown)
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
    const timeouts = all.length - values.length
    return {
      count: values.length,
      timeouts,
      timeoutRate: all.length ? timeouts / all.length : 0,
      p50: nearestRank(values, 0.5),
      p95: nearestRank(values, 0.95),
      recommendedDeadlineMs: Math.ceil((nearestRank(values, 0.95) + 750) / 250) * 250,
    }
  }
  const live = measure("live")
  const final = measure("final")
  const stageNames = ["scope", "normal_live", "normal_final", "widen"] as const
  const attempts = cases.flatMap((item) => item.output?.steps.flatMap((step) => step.attempts ?? []) ?? [])
  const stages = Object.fromEntries(
    stageNames.map((stage) => {
      const all = attempts.filter((attempt) => attempt.stage === stage)
      const completed = all.filter((attempt) => attempt.outcome !== "timeout")
      const values = completed.map((attempt) => attempt.durationMs).sort((a, b) => a - b)
      const tokenMetric = (key: "promptTokens" | "completionTokens" | "reasoningTokens") => {
        const tokens = completed
          .flatMap((attempt) => (attempt[key] === undefined ? [] : [attempt[key]]))
          .sort((a, b) => a - b)
        return { p50: nearestRank(tokens, 0.5), p95: nearestRank(tokens, 0.95) }
      }
      const timeouts = all.length - completed.length
      return [
        stage,
        {
          count: completed.length,
          timeouts,
          timeoutRate: all.length ? timeouts / all.length : 0,
          p50: nearestRank(values, 0.5),
          p95: nearestRank(values, 0.95),
          promptTokens: tokenMetric("promptTokens"),
          completionTokens: tokenMetric("completionTokens"),
          reasoningTokens: tokenMetric("reasoningTokens"),
        },
      ]
    })
  )
  return { live, final, stages, timeouts: live.timeouts + final.timeouts }
}

/**
 * Final-cohort timeout bound. The p95-based deadline design implies ~5% of calls
 * exceed it; provider jitter roughly doubles that in bad periods (worst observed
 * full-matrix rate ≈ 4%). 15% gives ~3x headroom over the worst observed while
 * still failing a model whose final passes degrade systemically. Live timeouts
 * are the accepted interim-discard mechanism and are reported but not bounded.
 */
const FINAL_TIMEOUT_MAX_RATE = 0.15
export const lifecycleEvaluator: Evaluator<VoicePolishOutput, VoicePolishExpected> = {
  name: "declared-lifecycle-outcome",
  evaluate: (output, expected) => {
    const final = output.steps.at(-1)
    if (!final) return result("declared-lifecycle-outcome", !expected.expectedFinalResult)
    const resultStatus = final.coordinatorResult?.status
    const statusMatches = !expected.expectedFinalResult || resultStatus === expected.expectedFinalResult
    const ackMatches =
      !expected.expectedAckStatus ||
      (final.coordinatorResult?.status === "rejected" &&
        final.coordinatorResult.ackStatus === expected.expectedAckStatus)
    const callsMatch =
      expected.expectedFinalModelCalls === undefined || final.finalModelCallCount === expected.expectedFinalModelCalls
    return result(
      "declared-lifecycle-outcome",
      statusMatches && ackMatches && callsMatch,
      `result=${resultStatus}; ack=${final.coordinatorResult?.status === "rejected" ? final.coordinatorResult.ackStatus : "none"}; calls=${final.finalModelCallCount}`
    )
  },
}

export const attemptBoundsEvaluator: Evaluator<VoicePolishOutput, VoicePolishExpected> = {
  name: "attempt-input-reasoning-bounds",
  evaluate: (output) => {
    const attempts = output.steps.flatMap((step) => step.attempts ?? [])
    const invalid = attempts.filter(
      (attempt) =>
        attempt.sourceWindowCount > VOICE_POLISH_WIDEN_MAX_WINDOWS ||
        attempt.rawScalarLength >
          (attempt.stage === "widen"
            ? VOICE_POLISH_WINDOW_MAX_CHARS * VOICE_POLISH_WIDEN_MAX_WINDOWS
            : VOICE_POLISH_WINDOW_MAX_CHARS) ||
        attempt.reasoningEffort !== voicePolishConfig.reasoningEffort
    )
    return result("attempt-input-reasoning-bounds", invalid.length === 0, `Invalid attempts: ${invalid.length}`)
  },
}

export const metricsEvaluator: RunEvaluator<VoicePolishOutput, VoicePolishExpected> = {
  name: "live-final-latency-timeout-metrics",
  evaluate: (cases) => {
    const m = latencyMetrics(cases)
    const passed =
      m.final.recommendedDeadlineMs <= VOICE_POLISH_FINAL_DEADLINE_CAP_MS &&
      m.final.timeoutRate <= FINAL_TIMEOUT_MAX_RATE
    const details = JSON.stringify({ live: m.live, final: m.final, stages: m.stages })
    // Metrics are report data even when the gate passes; do not use result(),
    // which intentionally suppresses details for ordinary passing evaluators.
    return { name: "live-final-latency-timeout-metrics", score: passed ? 1 : 0, passed, details }
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
    if (
      (cases[0]?.expectedOutput.expectedScope === "tail" ||
        cases[0]?.expectedOutput.expectedScope === "preserve_raw") &&
      passes !== cases.length
    )
      reasons.push(`${id}: bounded scope ${passes}/${cases.length}`)
  }
  if (permutation.runs !== 6) reasons.push(`requires 6 runs, got ${permutation.runs}`)
  const metrics = latencyMetrics(permutation.cases)
  if (metrics.final.recommendedDeadlineMs > VOICE_POLISH_FINAL_DEADLINE_CAP_MS)
    reasons.push("final latency cap exceeded")
  if (metrics.final.timeoutRate > FINAL_TIMEOUT_MAX_RATE) reasons.push("final timeout rate exceeded")
  const takes = permutation.cases.length
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
  scopeEvaluator,
  blockShapeEvaluator,
  roundTripEvaluator,
  languageEvaluator,
  stabilityEvaluator,
  lifecycleEvaluator,
  attemptBoundsEvaluator,
]
