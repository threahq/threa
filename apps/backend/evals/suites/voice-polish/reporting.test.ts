import { describe, expect, test } from "bun:test"
import { parseMarkdown } from "@threa/prosemirror"
import { voicePolishConfig } from "../../../src/features/voice-transcription/config"
import { decideVoicePolishComparison } from "./reporting"

const safety = [
  "all-step-valid-success",
  "all-step-context-non-echo",
  "all-step-parse-serialize-valid",
  "all-step-language-non-translation",
].map((name) => ({ name, passed: true, score: 1 }))
const permutation = (model: string, durationMs: number, promptVariant?: string, stabilityFailures = 0) => ({
  permutation: { model, promptVariant },
  runs: 6,
  executedModels: { [model]: 12 },
  totalDurationMs: 1,
  usage: { inputTokens: 1, outputTokens: 1, totalCost: 6 },
  runEvaluations: [],
  cases: ["stability", "correction"].flatMap((caseId) =>
    Array.from({ length: 6 }, (_, index) => ({
      caseId,
      caseName: caseId,
      expectedOutput: {
        stability: caseId === "stability" ? "prior-content" : undefined,
        correctionOrStructure: caseId === "correction",
      },
      evaluations: [
        ...safety,
        {
          name: "case-result",
          passed: caseId !== "stability" || index >= stabilityFailures,
          score: caseId !== "stability" || index >= stabilityFailures ? 1 : 0,
        },
      ],
      output: {
        steps: [
          {
            outcome: { status: "success", markdown: "ok", contentJson: parseMarkdown("ok") },
            durationMs,
            deadline: "final",
            forbiddenContextTerms: [],
          },
        ],
      },
      durationMs,
    }))
  ),
})

describe("voice polish comparison decision", () => {
  test("selects model and prompt across permutations and enforces the decision", () => {
    const challenger = "openrouter:openai/gpt-5.4-mini"
    const disqualified = permutation("openrouter:google/gemini-3.1-flash-lite", 700)
    disqualified.runs = 5
    const results = [
      { suiteName: "voice-polish: production", permutations: [permutation(voicePolishConfig.model, 1000)] },
      {
        suiteName: "voice-polish: baseline",
        permutations: [permutation(voicePolishConfig.model, 1000, "without-previous", 1)],
      },
      { suiteName: "voice-polish: challenger", permutations: [permutation(challenger, 800), disqualified] },
    ] as never
    expect(decideVoicePolishComparison(results)).toMatchObject({
      selectedModel: challenger,
      previousAcceptedShips: true,
      exitAllowed: true,
    })
    const failed = decideVoicePolishComparison([
      {
        suiteName: "voice-polish: baseline",
        permutations: [permutation(voicePolishConfig.model, 1000, "without-previous")],
      },
    ] as never)
    expect(failed).toMatchObject({ selectedModel: null, exitAllowed: false })
  })
})
