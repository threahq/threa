import { describe, it, expect } from "bun:test"
import { formatReport, EVAL_REPORT_MARKER, type EvalReport, type FormatMeta } from "./format-report"

const meta: FormatMeta = {
  command: "/eval -s boundary-extraction -r 6",
  sha: "abcdef1234567890",
  runUrl: "https://github.com/o/r/actions/runs/1",
  exitCode: 0,
  hasResults: true,
}

function report(overrides: Partial<EvalReport["suites"][0]["permutations"][0]> = {}): EvalReport {
  return {
    suites: [
      {
        suiteName: "boundary-extraction",
        permutations: [
          {
            model: "openrouter:openai/gpt-5.4-mini",
            temperature: 0.2,
            runs: 6,
            executedModels: { "openrouter:openai/gpt-5.4-mini": 228 },
            usage: { inputTokens: 1000, outputTokens: 500, totalCost: 0.0421 },
            totalDurationMs: 42000,
            runEvaluations: [{ name: "accuracy", score: 0.95, passed: true, details: null }],
            cases: [
              { caseId: "green-1", caseName: "g", passes: 6, runs: 6, passRate: 1, lastFailure: null },
              {
                caseId: "flaky-1",
                caseName: "f",
                passes: 4,
                runs: 6,
                passRate: 4 / 6,
                lastFailure: [{ name: "conversation-decision", details: "Expected existing but got new" }],
              },
            ],
            ...overrides,
          },
        ],
      },
    ],
  }
}

describe("formatReport", () => {
  it("leads with the marker so runs can be identified/superseded", () => {
    expect(formatReport(report(), meta).startsWith(EVAL_REPORT_MARKER)).toBe(true)
  })

  it("shows a green verdict, the command, the short SHA, and the summary row", () => {
    const md = formatReport(report(), meta)
    expect(md).toContain("✅ **All cases cleared their pass-rate threshold.**")
    expect(md).toContain("`/eval -s boundary-extraction -r 6`")
    expect(md).toContain("`abcdef1`")
    expect(md).toContain("| boundary-extraction | `openai/gpt-5.4-mini` |")
    expect(md).toContain("$0.0421")
  })

  it("renders a failing verdict counting red and flaky cases", () => {
    const md = formatReport(report(), { ...meta, exitCode: 1 })
    expect(md).toContain("❌ **1 case(s) below threshold** (0 red, 1 flaky).")
  })

  it("lists the flaky case with its pass rate and last failure in the details block", () => {
    const md = formatReport(report(), meta)
    expect(md).toContain("🟡 `flaky-1`")
    expect(md).toContain("4/6")
    expect(md).toContain("conversation-decision: Expected existing but got new")
  })

  it("escapes pipe characters in failure text so the table survives", () => {
    const md = formatReport(
      report({
        cases: [
          {
            caseId: "red-1",
            caseName: "r",
            passes: 0,
            runs: 6,
            passRate: 0,
            lastFailure: [{ name: "x", details: "got a | b | c" }],
          },
        ],
      }),
      meta
    )
    expect(md).toContain("got a \\| b \\| c")
    expect(md).toContain("🔴 `red-1`")
  })

  it("emits a crash notice when no results were produced", () => {
    const md = formatReport(null, { ...meta, exitCode: 1, hasResults: false })
    expect(md).toContain("💥")
    expect(md).toContain("crashed before producing results")
    expect(md).toContain(meta.runUrl)
  })
})
