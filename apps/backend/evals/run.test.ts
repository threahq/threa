import { describe, expect, test } from "bun:test"
import { hasCaseRateFailures } from "./run"

const suiteResult = (suiteName: string, model: string, passes: boolean[], promptVariant?: string) => ({
  suiteName,
  permutations: [
    {
      permutation: { model, promptVariant },
      cases: passes.map((passed) => ({
        caseId: "case",
        caseName: "Case",
        evaluations: [{ name: "case-result", passed, score: passed ? 1 : 0 }],
      })),
    },
  ],
})

const luna = "openrouter:openai/gpt-5.6-luna"
const mini = "openrouter:openai/gpt-5.4-mini"

describe("eval exit case-rate ownership", () => {
  test("voice-polish comparison ignores losing candidates but gates the selected model", () => {
    const production = suiteResult("voice-polish: production", luna, [true, true, true, true, true, true])
    const disqualifiedChallenger = suiteResult("voice-polish: challenger", mini, [
      true,
      true,
      false,
      false,
      false,
      false,
    ])
    const results = [production, disqualifiedChallenger]

    expect(hasCaseRateFailures(results, 0.83)).toBe(true)
    expect(hasCaseRateFailures(results, 0.83, luna)).toBe(false)

    const failingProduction = suiteResult("voice-polish: production", luna, [true, true, false, false, false, false])
    expect(hasCaseRateFailures([failingProduction, disqualifiedChallenger], 0.83, luna)).toBe(true)
  })

  test("without-previous baseline failures do not override the prompt decision", () => {
    const production = suiteResult("voice-polish: production", luna, [true, true, true, true, true, true])
    const baseline = suiteResult(
      "voice-polish: baseline",
      luna,
      [true, true, false, false, false, false],
      "without-previous"
    )

    expect(hasCaseRateFailures([production, baseline], 0.83, luna)).toBe(false)
  })

  test("non-voice suites retain their per-case exit threshold", () => {
    const voicePolish = suiteResult("voice-polish: challenger", mini, [false, false, false, false, false, false])
    const otherSuite = suiteResult("memo-classifier", "model", [true, true, true, true, false, false])

    expect(hasCaseRateFailures([voicePolish, otherSuite], 0.83, luna)).toBe(true)
  })
})
