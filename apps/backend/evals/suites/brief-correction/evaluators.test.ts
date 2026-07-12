import { describe, it, expect } from "bun:test"
import type { EvalContext, CaseResult, EvaluatorResult } from "../../framework/types"
import {
  writeDecisionEvaluator,
  singleRevisionEvaluator,
  briefContentEvaluator,
  accuracyEvaluator,
  chitchatNoWriteRateEvaluator,
} from "./evaluators"
import type { BriefCorrectionInput, BriefCorrectionOutput, BriefCorrectionExpected } from "./types"

// The deterministic and run-level evaluators are pure functions of the readback,
// so they are gradeable without the live agent. The LLM-judged briefContent
// evaluator needs a real ctx.ai and is exercised by the `/eval` run.

const ctx = {} as EvalContext

type JudgeVerdict = { assertsRequired: boolean | null; stillAssertsForbidden: boolean | null }

/**
 * An EvalContext whose `ai.generateObject` returns a fixed judge verdict (or
 * throws), so briefContentEvaluator's requiredOk/forbiddenOk logic is testable
 * without a live model. Throwing when a verdict isn't expected proves the early
 * returns don't reach the model.
 */
function judgeCtx(verdict: JudgeVerdict | Error): EvalContext {
  return {
    ai: {
      generateObject: async () => {
        if (verdict instanceof Error) throw verdict
        return { value: { ...verdict, reasoning: "stub" } }
      },
    },
  } as unknown as EvalContext
}

const NEVER_CALLED = judgeCtx(new Error("judge should not be called"))

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

describe("briefContentEvaluator", () => {
  const withBrief = (over: Partial<BriefCorrectionOutput> = {}) =>
    output({ wrote: true, briefContent: "# Brief\n\n- a fact", revisionCount: 1, ...over })

  it("passes without calling the judge when there are no content requirements", async () => {
    const r = (await briefContentEvaluator.evaluate(
      withBrief(),
      { shouldWrite: true },
      NEVER_CALLED
    )) as EvaluatorResult
    expect(r.passed).toBe(true)
  })

  it("passes when the required fact is asserted", async () => {
    const r = (await briefContentEvaluator.evaluate(
      withBrief(),
      { shouldWrite: true, briefMustState: "a fact" },
      judgeCtx({ assertsRequired: true, stillAssertsForbidden: null })
    )) as EvaluatorResult
    expect(r.passed).toBe(true)
  })

  it("fails when the required fact is not asserted", async () => {
    const r = (await briefContentEvaluator.evaluate(
      withBrief(),
      { shouldWrite: true, briefMustState: "a fact" },
      judgeCtx({ assertsRequired: false, stillAssertsForbidden: null })
    )) as EvaluatorResult
    expect(r.passed).toBe(false)
  })

  it("passes a reversal when the old fact is dropped", async () => {
    const r = (await briefContentEvaluator.evaluate(
      withBrief(),
      { shouldWrite: true, briefMustState: "Postgres", briefMustNotState: "MySQL" },
      judgeCtx({ assertsRequired: true, stillAssertsForbidden: false })
    )) as EvaluatorResult
    expect(r.passed).toBe(true)
  })

  it("fails a reversal when the old fact is still asserted (appended, not replaced)", async () => {
    const r = (await briefContentEvaluator.evaluate(
      withBrief(),
      { shouldWrite: true, briefMustState: "Postgres", briefMustNotState: "MySQL" },
      judgeCtx({ assertsRequired: true, stillAssertsForbidden: true })
    )) as EvaluatorResult
    expect(r.passed).toBe(false)
  })

  it("fails closed when the forbidden-fact verdict is indeterminate (null)", async () => {
    const r = (await briefContentEvaluator.evaluate(
      withBrief(),
      { shouldWrite: true, briefMustState: "Postgres", briefMustNotState: "MySQL" },
      judgeCtx({ assertsRequired: true, stillAssertsForbidden: null })
    )) as EvaluatorResult
    expect(r.passed).toBe(false)
  })

  it("fails on a judge generation error", async () => {
    const r = (await briefContentEvaluator.evaluate(
      withBrief(),
      { shouldWrite: true, briefMustState: "a fact" },
      judgeCtx(new Error("boom"))
    )) as EvaluatorResult
    expect(r.passed).toBe(false)
  })

  it("fails when a fact was required but the brief is empty", async () => {
    const r = (await briefContentEvaluator.evaluate(
      output({ wrote: false, briefContent: null }),
      { shouldWrite: true, briefMustState: "a fact" },
      NEVER_CALLED
    )) as EvaluatorResult
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
