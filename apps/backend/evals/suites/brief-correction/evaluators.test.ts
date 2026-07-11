import { describe, it, expect } from "bun:test"
import type { EvalContext, CaseResult, EvaluatorResult } from "../../framework/types"
import {
  writeDecisionEvaluator,
  singleRevisionEvaluator,
  accuracyEvaluator,
  chitchatNoWriteRateEvaluator,
} from "./evaluators"
import type { BriefCorrectionInput, BriefCorrectionOutput, BriefCorrectionExpected } from "./types"

// The deterministic and run-level evaluators are pure functions of the readback,
// so they are gradeable without the live agent. The LLM-judged briefContent
// evaluator needs a real ctx.ai and is exercised by the `/eval` run.

const ctx = {} as EvalContext

function output(over: Partial<BriefCorrectionOutput>): BriefCorrectionOutput {
  return {
    input: { category: "chitchat", message: "hi" } as BriefCorrectionInput,
    wrote: false,
    briefContent: null,
    briefVersion: 0,
    revisionCount: 0,
    revisionsBefore: 0,
    ...over,
  }
}

function caseResult(
  out: BriefCorrectionOutput,
  expected: BriefCorrectionExpected,
  evaluations: EvaluatorResult[] = []
): CaseResult<BriefCorrectionOutput, BriefCorrectionExpected> {
  return {
    caseId: "c",
    caseName: "c",
    input: out.input,
    output: out,
    expectedOutput: expected,
    evaluations,
    durationMs: 0,
    error: out.error ? new Error(out.error) : undefined,
  }
}

describe("writeDecisionEvaluator", () => {
  it("passes when a write was expected and happened", () => {
    const r = writeDecisionEvaluator.evaluate(output({ wrote: true }), { shouldWrite: true }, ctx) as EvaluatorResult
    expect(r.passed).toBe(true)
  })

  it("fails when a write was expected but did not happen", () => {
    const r = writeDecisionEvaluator.evaluate(output({ wrote: false }), { shouldWrite: true }, ctx) as EvaluatorResult
    expect(r.passed).toBe(false)
  })

  it("fails when the brief was written on a chitchat turn", () => {
    const r = writeDecisionEvaluator.evaluate(output({ wrote: true }), { shouldWrite: false }, ctx) as EvaluatorResult
    expect(r.passed).toBe(false)
  })

  it("fails on task error", () => {
    const r = writeDecisionEvaluator.evaluate(
      output({ wrote: false, error: "boom" }),
      { shouldWrite: false },
      ctx
    ) as EvaluatorResult
    expect(r.passed).toBe(false)
  })
})

describe("singleRevisionEvaluator", () => {
  it("ignores non-write cases", () => {
    const r = singleRevisionEvaluator.evaluate(output({ wrote: false }), { shouldWrite: false }, ctx) as EvaluatorResult
    expect(r.passed).toBe(true)
  })

  it("passes when exactly one revision was added", () => {
    const r = singleRevisionEvaluator.evaluate(
      output({ wrote: true, revisionsBefore: 1, revisionCount: 2 }),
      { shouldWrite: true },
      ctx
    ) as EvaluatorResult
    expect(r.passed).toBe(true)
  })

  it("fails when the brief was rewritten more than once", () => {
    const r = singleRevisionEvaluator.evaluate(
      output({ wrote: true, revisionsBefore: 0, revisionCount: 2 }),
      { shouldWrite: true },
      ctx
    ) as EvaluatorResult
    expect(r.passed).toBe(false)
  })
})

describe("chitchatNoWriteRateEvaluator (roadmap 4.4 gate)", () => {
  it("passes when every chitchat turn left the brief untouched", () => {
    const cases = [
      caseResult(output({ wrote: false }), { shouldWrite: false }),
      caseResult(output({ wrote: false }), { shouldWrite: false }),
      caseResult(output({ wrote: true }), { shouldWrite: true }), // a write-expected case is ignored by the gate
    ]
    const r = chitchatNoWriteRateEvaluator.evaluate(cases) as EvaluatorResult
    expect(r.score).toBe(1)
    expect(r.passed).toBe(true)
  })

  it("fails below the 0.9 floor when a chitchat turn wrote the brief", () => {
    const cases = [
      caseResult(output({ wrote: false }), { shouldWrite: false }),
      caseResult(output({ wrote: false }), { shouldWrite: false }),
      caseResult(output({ wrote: true }), { shouldWrite: false }),
    ]
    const r = chitchatNoWriteRateEvaluator.evaluate(cases) as EvaluatorResult
    expect(r.score).toBeCloseTo(2 / 3)
    expect(r.passed).toBe(false)
  })

  it("passes vacuously when there are no chitchat cases", () => {
    const cases = [caseResult(output({ wrote: true }), { shouldWrite: true })]
    const r = chitchatNoWriteRateEvaluator.evaluate(cases) as EvaluatorResult
    expect(r.passed).toBe(true)
  })
})

describe("accuracyEvaluator", () => {
  it("passes at or above the 0.8 floor", () => {
    const pass: EvaluatorResult = { name: "x", score: 1, passed: true }
    const fail: EvaluatorResult = { name: "x", score: 0, passed: false }
    const cases = [
      caseResult(output({ wrote: true }), { shouldWrite: true }, [pass]),
      caseResult(output({ wrote: true }), { shouldWrite: true }, [pass]),
      caseResult(output({ wrote: true }), { shouldWrite: true }, [pass]),
      caseResult(output({ wrote: true }), { shouldWrite: true }, [pass]),
      caseResult(output({ wrote: false }), { shouldWrite: true }, [fail]),
    ]
    const r = accuracyEvaluator.evaluate(cases) as EvaluatorResult
    expect(r.score).toBeCloseTo(0.8)
    expect(r.passed).toBe(true)
  })
})
