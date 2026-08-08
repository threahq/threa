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
  lifecycleEvaluator,
  metricsEvaluator,
  previousAcceptedVariantShips,
  qualifyVoicePolishPermutation,
  requiredTermsEvaluator,
  roundTripEvaluator,
  selectVoicePolishModel,
  scopeEvaluator,
  stabilityEvaluator,
  successEvaluator,
} from "./evaluators"
import type { VoicePolishOutput } from "./types"
import { toJsonReport } from "../../run"

const success = (markdown: string): Extract<PolishOutcome, { status: "success" }> => ({
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

  test("declared preserve-raw remains typed while content and round-trip grade the composed document", async () => {
    const composed = success("Accepted Monday.\n\nChange the first date to Tuesday")
    const value = output({ status: "preserve_raw" })
    value.markdown = composed.markdown
    value.contentJson = composed.contentJson
    value.composedDocument = composed
    value.steps[0]!.composedDocument = composed
    value.steps[0]!.scope = "preserve_raw"
    value.steps[0]!.predecessorStable = true
    expect((await successEvaluator.evaluate(value, { expectedScope: "preserve_raw" }, ctx)).passed).toBe(true)
    expect((await requiredTermsEvaluator.evaluate(value, { requiredTerms: ["Monday", "Tuesday"] }, ctx)).passed).toBe(
      true
    )
    expect((await roundTripEvaluator.evaluate(value, {}, ctx)).passed).toBe(true)
    expect(
      (await scopeEvaluator.evaluate(value, { expectedScope: "preserve_raw", predecessorStable: true }, ctx)).passed
    ).toBe(true)
    expect(value.outcome.status).toBe("preserve_raw")
    expect((await successEvaluator.evaluate(value, {}, ctx)).passed).toBe(false)
    const earlierSafePreserve = output([{ status: "preserve_raw" }, success("Final")])
    expect((await successEvaluator.evaluate(earlierSafePreserve, { expectedScope: "preserve_raw" }, ctx)).passed).toBe(
      true
    )
    value.steps.unshift({
      outcome: success("Earlier"),
      durationMs: 1,
      deadline: "live",
      scope: "widen_previous",
      predecessorStable: false,
      forbiddenContextTerms: [],
    })
    expect(
      (await scopeEvaluator.evaluate(value, { expectedScope: "preserve_raw", predecessorStable: true }, ctx)).passed
    ).toBe(true)
  })

  test("declared stop reuse and locked acknowledgement require exact lifecycle evidence", async () => {
    const reused = output(success("done"))
    reused.steps[0]!.coordinatorResult = { status: "reused" }
    reused.steps[0]!.finalModelCallCount = 0
    expect(
      (await lifecycleEvaluator.evaluate(reused, { expectedFinalResult: "reused", expectedFinalModelCalls: 0 }, ctx))
        .passed
    ).toBe(true)
    const rejected = output({ status: "replacement_rejected" })
    rejected.steps[0]!.coordinatorResult = { status: "rejected", operationId: "op", ackStatus: "locked" }
    rejected.steps[0]!.finalModelCallCount = 1
    expect(
      (
        await lifecycleEvaluator.evaluate(
          rejected,
          { expectedFinalResult: "rejected", expectedAckStatus: "locked" },
          ctx
        )
      ).passed
    ).toBe(true)
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
    expect(JSON.parse(passingMetrics.details!).live).toMatchObject({ timeouts: 1, timeoutRate: 0.05 })
    expect(JSON.parse(passingMetrics.details!).stages).toHaveProperty("scope")
    const catastrophicValues = Array.from({ length: 6 }, () => ({
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
    }))
    const catastrophic = catastrophicValues as never
    expect((await metricsEvaluator.evaluate(catastrophic)).passed).toBe(false)
    const timedOutPermutation = {
      runs: 6,
      cases: catastrophicValues.map((item) => ({
        ...item,
        caseId: "timeout",
        expectedOutput: {},
        evaluations: [],
      })),
      usage: { totalCost: 0 },
    } as never
    const timeoutQualification = qualifyVoicePolishPermutation(timedOutPermutation)
    expect(timeoutQualification.qualified).toBe(false)
    expect(selectVoicePolishModel("luna", [{ model: "luna", qualification: timeoutQualification }])).toBeNull()
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

    const metric = await metricsEvaluator.evaluate(completed as never)
    const report = toJsonReport([
      {
        suiteName: "voice-polish",
        permutations: [
          {
            permutation: { model: "luna" },
            runs: 1,
            executedModels: {},
            usage: {},
            totalDurationMs: 1,
            runEvaluations: [metric],
            cases: [],
          },
        ],
      },
    ])
    const details = JSON.parse(report.suites[0]!.permutations[0]!.runEvaluations[0]!.details as string)
    for (const stage of ["scope", "normal_live", "normal_final", "widen"])
      expect(details.stages[stage]).toEqual(
        expect.objectContaining({
          timeoutRate: expect.any(Number),
          promptTokens: expect.any(Object),
          completionTokens: expect.any(Object),
          reasoningTokens: expect.any(Object),
        })
      )
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
    cases[0]!.output.steps.push({
      outcome: success("ok"),
      durationMs: 1,
      deadline: "live",
      forbiddenContextTerms: [],
    })
    const qualified = qualifyVoicePolishPermutation(permutation)
    expect(qualified).toMatchObject({ qualified: true, caseRates: { correction: 1 }, costPerTake: 1 })
    const strictScopeCases = cases.map((item, index) => ({
      ...item,
      caseId: "clean-boundary",
      expectedOutput: { expectedScope: "tail" as const },
      evaluations:
        index === 0 ? [...item.evaluations, { name: "boundary-scope", passed: false, score: 0 }] : item.evaluations,
    }))
    expect(
      qualifyVoicePolishPermutation({ runs: 6, cases: strictScopeCases, usage: { totalCost: 6 } } as never).reasons
    ).toContain("clean-boundary: bounded scope 5/6")
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
