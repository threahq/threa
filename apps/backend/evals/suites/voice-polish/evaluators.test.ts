import { describe, expect, test } from "bun:test"
import { parseMarkdown } from "@threa/prosemirror"
import type { PolishOutcome } from "../../../src/features/voice-transcription/polish"
import {
  blockShapeEvaluator,
  challengerBeatsProduction,
  contextNonEchoEvaluator,
  forbiddenTermsEvaluator,
  languageEvaluator,
  latencyMetrics,
  metricsEvaluator,
  previousAcceptedVariantShips,
  qualifyVoicePolishPermutation,
  requiredTermsEvaluator,
  roundTripEvaluator,
  selectVoicePolishModel,
  stabilityEvaluator,
  successEvaluator,
} from "./evaluators"
import type { VoicePolishOutput } from "./types"

const success = (markdown: string): PolishOutcome => ({
  status: "success",
  markdown,
  contentJson: parseMarkdown(markdown),
})
const output = (outcomes: PolishOutcome | PolishOutcome[]): VoicePolishOutput => {
  const values = Array.isArray(outcomes) ? outcomes : [outcomes]
  const steps = values.map((outcome, index) => ({
    outcome,
    durationMs: index ? 950 : 100,
    deadline: index ? ("final" as const) : ("live" as const),
    forbiddenContextTerms: [],
  }))
  const outcome = values.at(-1)!
  return {
    steps,
    outcome,
    ...(outcome.status === "success" ? { markdown: outcome.markdown, contentJson: outcome.contentJson } : {}),
    durationMs: 1,
  }
}
const ctx = {} as never

describe("voice polish deterministic evaluators", () => {
  test("every emitted step must pass safety", async () => {
    const value = output([{ status: "timeout" }, success("Clean final")])
    expect((await successEvaluator.evaluate(value, {}, ctx)).passed).toBe(true)
    expect((await roundTripEvaluator.evaluate(value, {}, ctx)).passed).toBe(true)
    value.steps[0] = {
      outcome: success("secret translated with Kubernetes"),
      durationMs: 1,
      deadline: "live",
      forbiddenContextTerms: ["secret"],
    }
    expect((await contextNonEchoEvaluator.evaluate(value, {}, ctx)).passed).toBe(false)
    expect(
      (
        await languageEvaluator.evaluate(
          value,
          { languageMarkers: ["Clean"], forbiddenTranslations: ["with Kubernetes"] },
          ctx
        )
      ).passed
    ).toBe(false)
  })

  test("term checks are punctuation-insensitive", async () => {
    const punctuated = output(success("Um, I think we should ship, no, sorry, wait."))
    expect(
      (await requiredTermsEvaluator.evaluate(punctuated, { requiredTerms: ["um", "no sorry", "wait"] }, ctx)).passed
    ).toBe(true)
    expect(
      (await forbiddenTermsEvaluator.evaluate(punctuated, { forbiddenTerms: ["ship no sorry"] }, ctx)).passed
    ).toBe(false)
  })

  test("final correction terms remain final-step checks", async () => {
    const value = output([success("Meet at nine"), success("Meet at eight")])
    expect((await requiredTermsEvaluator.evaluate(value, { requiredTerms: ["eight"] }, ctx)).passed).toBe(true)
    expect((await forbiddenTermsEvaluator.evaluate(value, { forbiddenTerms: ["nine"] }, ctx)).passed).toBe(true)
  })

  test("shape requires exact nodes and exact list item counts", async () => {
    const list = output(success("- one\n- two"))
    expect(
      (await blockShapeEvaluator.evaluate(list, { blockTypes: ["bulletList"], listItemCounts: [2] }, ctx)).passed
    ).toBe(true)
    expect(
      (await blockShapeEvaluator.evaluate(list, { blockTypes: ["bulletList"], listItemCounts: [3] }, ctx)).passed
    ).toBe(false)
    const extra = output(success("- one\n- two\n\nextra"))
    expect((await blockShapeEvaluator.evaluate(extra, { blockTypes: ["bulletList"] }, ctx)).passed).toBe(false)
  })

  test("stability retains wording and item order across a failed step", async () => {
    const stable = output([
      success("- Alpha owner\n- Beta owner"),
      { status: "timeout" },
      success("- Alpha owner\n- Beta owner\n- Gamma owner"),
    ])
    expect((await stabilityEvaluator.evaluate(stable, { stability: "prior-content" }, ctx)).passed).toBe(true)
    stable.steps[2]!.outcome = success("- Beta owner\n- Alpha renamed")
    expect((await stabilityEvaluator.evaluate(stable, { stability: "prior-content" }, ctx)).passed).toBe(false)
    stable.steps[2]!.outcome = success("- Alpha owner Beta\n- owner\n- Gamma owner")
    expect((await stabilityEvaluator.evaluate(stable, { stability: "prior-content" }, ctx)).passed).toBe(false)
    stable.steps[2]!.outcome = success("Alpha owner Beta owner\n\nGamma owner")
    expect((await stabilityEvaluator.evaluate(stable, { stability: "prior-content" }, ctx)).passed).toBe(false)
  })

  test("timeouts are valid typed outcomes; other failures never are", async () => {
    const interimTimeout = output([{ status: "timeout" }, success("Clean final")])
    expect((await successEvaluator.evaluate(interimTimeout, {}, ctx)).passed).toBe(true)
    expect((await roundTripEvaluator.evaluate(interimTimeout, {}, ctx)).passed).toBe(true)
    const finalTimeout = output([success("Clean live"), { status: "timeout" }])
    expect((await successEvaluator.evaluate(finalTimeout, {}, ctx)).passed).toBe(true)
    expect((await roundTripEvaluator.evaluate(finalTimeout, {}, ctx)).passed).toBe(true)
    const providerError = output([{ status: "provider_error" as const }, success("Clean final")])
    expect((await successEvaluator.evaluate(providerError, {}, ctx)).passed).toBe(false)
    expect((await roundTripEvaluator.evaluate(providerError, {}, ctx)).passed).toBe(false)
  })

  test("content gates skip timed-out final passes but still grade completions", async () => {
    const finalTimeout = output([success("Section 1 detail"), { status: "timeout" }])
    const expected = { requiredTerms: ["Section 1", "Thursday"], blockTypes: ["paragraph"] }
    expect((await requiredTermsEvaluator.evaluate(finalTimeout, expected, ctx)).passed).toBe(true)
    expect((await forbiddenTermsEvaluator.evaluate(finalTimeout, { forbiddenTerms: ["Wednesday"] }, ctx)).passed).toBe(
      true
    )
    expect((await blockShapeEvaluator.evaluate(finalTimeout, expected, ctx)).passed).toBe(true)
    const completed = output([success("Section 1 detail"), success("Section 1 detail, launching Thursday")])
    expect((await requiredTermsEvaluator.evaluate(completed, expected, ctx)).passed).toBe(true)
    const compressed = output([success("Section 1 detail"), success("Sections, Thursday")])
    expect((await requiredTermsEvaluator.evaluate(compressed, expected, ctx)).passed).toBe(false)
  })

  test("latency percentiles exclude timed-out calls and the run gate grades the final pass", async () => {
    const completed = Array.from({ length: 19 }, (_, index) => ({
      output: {
        ...output(success("ok")),
        steps: [
          { outcome: success("ok"), durationMs: index + 1, deadline: "live" as const, forbiddenContextTerms: [] },
          { outcome: success("ok"), durationMs: 6000, deadline: "final" as const, forbiddenContextTerms: [] },
        ],
      },
    }))
    const timedOut = [
      {
        output: {
          ...output(success("ok")),
          steps: [
            {
              outcome: { status: "timeout" as const },
              durationMs: 6500,
              deadline: "live" as const,
              forbiddenContextTerms: [],
            },
            { outcome: success("ok"), durationMs: 6000, deadline: "final" as const, forbiddenContextTerms: [] },
          ],
        },
      },
    ]
    const cases = [...completed, ...timedOut] as never
    expect(latencyMetrics(cases)).toMatchObject({
      live: { p95: 19, timeouts: 1, timeoutRate: 0.05 },
      final: { timeouts: 0, timeoutRate: 0 },
      timeouts: 1,
    })
    const passingMetrics = await metricsEvaluator.evaluate(cases)
    expect(passingMetrics.passed).toBe(true)
    expect(passingMetrics.details).toContain("timeouts=1 (5.0%)")
    const catastrophic = Array.from({ length: 6 }, () => ({
      output: {
        ...output(success("ok")),
        steps: [
          {
            outcome: { status: "timeout" as const },
            durationMs: 8000,
            deadline: "final" as const,
            forbiddenContextTerms: [],
          },
        ],
      },
    })) as never
    expect((await metricsEvaluator.evaluate(catastrophic)).passed).toBe(false)
    const slowFinal = Array.from({ length: 6 }, () => ({
      output: {
        ...output(success("ok")),
        steps: [
          { outcome: success("ok"), durationMs: 100, deadline: "live" as const, forbiddenContextTerms: [] },
          { outcome: success("ok"), durationMs: 7300, deadline: "final" as const, forbiddenContextTerms: [] },
        ],
      },
    })) as never
    expect((await metricsEvaluator.evaluate(slowFinal)).passed).toBe(false)
  })

  test("latency uses nearest rank and separate live/final cohorts", () => {
    const cases = Array.from({ length: 20 }, (_, index) => ({
      output: {
        ...output(success("ok")),
        steps: [
          { outcome: success("ok"), durationMs: index + 1, deadline: "live" as const, forbiddenContextTerms: [] },
          { outcome: success("ok"), durationMs: 100 + index, deadline: "final" as const, forbiddenContextTerms: [] },
        ],
      },
    })) as never
    expect(latencyMetrics(cases)).toMatchObject({ live: { p50: 10, p95: 19 }, final: { p50: 109, p95: 118 } })
  })

  test("qualification enforces six runs, safety, correction rate, caps, and challenger rules", () => {
    const evaluations = [
      { name: "all-step-valid-success", passed: true, score: 1 },
      { name: "all-step-context-non-echo", passed: true, score: 1 },
      { name: "all-step-parse-serialize-valid", passed: true, score: 1 },
      { name: "all-step-language-non-translation", passed: true, score: 1 },
    ]
    const cases = Array.from({ length: 6 }, () => ({
      caseId: "correction",
      expectedOutput: { correctionOrStructure: true },
      evaluations,
      output: output(success("ok")),
    }))
    const permutation = { runs: 6, cases, usage: { totalCost: 6 } } as never
    const qualified = qualifyVoicePolishPermutation(permutation)
    expect(qualified).toMatchObject({ qualified: true, caseRates: { correction: 1 } })
    const production = { ...qualified, p95: { live: 1000, final: 1000 }, costPerTake: 1 }
    const challenger = { ...qualified, p95: { live: 800, final: 800 }, costPerTake: 1 }
    expect(challengerBeatsProduction(production, challenger)).toBe(true)
    expect(
      selectVoicePolishModel("luna", [
        { model: "luna", qualification: production },
        { model: "mini", qualification: challenger },
      ])
    ).toBe("mini")
    expect(
      selectVoicePolishModel("luna", [{ model: "luna", qualification: { ...production, qualified: false } }])
    ).toBeNull()
    expect(
      previousAcceptedVariantShips(
        { ...qualified, caseRates: { stability: 1, correction: 1 } },
        { ...qualified, caseRates: { stability: 5 / 6, correction: 1 } },
        ["stability"],
        ["correction"]
      )
    ).toBe(true)
    expect(
      previousAcceptedVariantShips(
        { ...qualified, caseRates: { stability: 1, correction: 1 } },
        { ...qualified, caseRates: { stability: 1, correction: 1 } },
        ["stability"],
        ["correction"]
      )
    ).toBe(true)
    expect(
      previousAcceptedVariantShips(
        { ...qualified, caseRates: { stability: 5 / 6, correction: 1 } },
        { ...qualified, caseRates: { stability: 5 / 6, correction: 1 } },
        ["stability"],
        ["correction"]
      )
    ).toBe(false)
    cases[0]!.evaluations = [{ name: "all-step-valid-success", passed: false, score: 0 }]
    expect(qualifyVoicePolishPermutation(permutation).qualified).toBe(false)
  })
})
