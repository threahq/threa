import { describe, expect, test } from "bun:test"
import { hasCaseRateFailures } from "./run"

const suiteResult = (suiteName: string, passes: boolean[]) => ({
  suiteName,
  permutations: [
    {
      cases: passes.map((passed) => ({
        caseId: "case",
        caseName: "Case",
        evaluations: [{ name: "case-result", passed, score: passed ? 1 : 0 }],
      })),
    },
  ],
})

describe("eval exit case-rate ownership", () => {
  test("voice-polish comparison candidates defer to the structured decision", () => {
    const production = suiteResult("voice-polish: production", [true, true, true, true, true, true])
    const disqualifiedChallenger = suiteResult("voice-polish: challenger", [true, true, false, false, false, false])
    const results = [production, disqualifiedChallenger]

    expect(hasCaseRateFailures(results, 0.83)).toBe(true)
    expect(hasCaseRateFailures(results, 0.83, true)).toBe(false)
  })

  test("non-voice suites retain their per-case exit threshold", () => {
    const voicePolish = suiteResult("voice-polish: challenger", [false, false, false, false, false, false])
    const otherSuite = suiteResult("memo-classifier", [true, true, true, true, false, false])

    expect(hasCaseRateFailures([voicePolish, otherSuite], 0.83, true)).toBe(true)
  })
})
