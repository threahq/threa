import { describe, it, expect } from "bun:test"
import type { EvalContext, CaseResult, Evaluator, EvaluatorResult } from "../../framework/types"
import {
  diffSections,
  writeDecisionEvaluator,
  singleWriteEvaluator,
  scopedChangeEvaluator,
  reasonPresentEvaluator,
  accuracyEvaluator,
} from "./evaluators"
import type { DocEditOutput, DocEditExpected } from "./types"

const ctx = {} as EvalContext

const WRITE: DocEditExpected = {
  shouldWrite: true,
  touchedSectionMustMatch: /\[x\].*AWS access key/i,
  maxTouchedSections: 1,
  replaceableLine: /AWS access key/i,
}

const TASKS_BEFORE = "- [ ] Revoke the old AWS access key\n- [ ] Rotate the Stripe secret"

const tickedTask = {
  blockId: "block_tasks",
  before: TASKS_BEFORE,
  after: "- [x] Revoke the old AWS access key\n- [ ] Rotate the Stripe secret",
}

function output(over: Partial<DocEditOutput>): DocEditOutput {
  return {
    input: { message: "hi" },
    wrote: false,
    writeCount: 0,
    personaUpdateCount: 0,
    createdDocCount: 0,
    titleChanged: false,
    touchedSections: [],
    removedBlockIds: [],
    reasons: [],
    ...over,
  }
}

const written = (over: Partial<DocEditOutput> = {}) =>
  output({
    wrote: true,
    writeCount: 1,
    personaUpdateCount: 1,
    touchedSections: [tickedTask],
    reasons: ["AWS key live"],
    ...over,
  })

function caseResult(
  out: DocEditOutput,
  expected: DocEditExpected,
  evaluations: EvaluatorResult[] = []
): CaseResult<DocEditOutput, DocEditExpected> {
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

async function passed(
  evaluator: Evaluator<DocEditOutput, DocEditExpected>,
  out: DocEditOutput,
  expected: DocEditExpected
): Promise<boolean> {
  return (await evaluator.evaluate(out, expected, ctx)).passed
}

describe("diffSections", () => {
  it("should report changed and added sections and removed ids when the doc moved", () => {
    const baseline = new Map([
      ["block_title", "# Rotation tracker"],
      ["block_tasks", "- [ ] Revoke"],
      ["block_gone", "stale"],
    ])
    const after = new Map([
      ["block_title", "# Rotation tracker"],
      ["block_tasks", "- [x] Revoke"],
      ["block_new", "| GitHub token |"],
    ])
    expect(diffSections(baseline, after)).toEqual({
      touchedSections: [
        { blockId: "block_tasks", before: "- [ ] Revoke", after: "- [x] Revoke" },
        { blockId: "block_new", before: null, after: "| GitHub token |" },
      ],
      removedBlockIds: ["block_gone"],
    })
  })

  it("should report nothing when the doc is untouched", () => {
    const sections = new Map([["block_title", "# Rotation tracker"]])
    expect(diffSections(sections, new Map(sections))).toEqual({ touchedSections: [], removedBlockIds: [] })
  })
})

describe("writeDecisionEvaluator", () => {
  it("should pass only when the write matches the expectation and the task did not error", async () => {
    expect({
      expectedAndWrote: await passed(writeDecisionEvaluator, written(), WRITE),
      expectedNoWrite: await passed(writeDecisionEvaluator, output({}), WRITE),
      chitchatWrote: await passed(writeDecisionEvaluator, written(), { shouldWrite: false }),
      chitchatClean: await passed(writeDecisionEvaluator, output({}), { shouldWrite: false }),
      sessionFailed: await passed(writeDecisionEvaluator, output({ error: "agent session failed: boom" }), {
        shouldWrite: false,
      }),
    }).toEqual({
      expectedAndWrote: true,
      expectedNoWrite: false,
      chitchatWrote: false,
      chitchatClean: true,
      sessionFailed: false,
    })
  })
})

describe("singleWriteEvaluator", () => {
  it("should require exactly one write on write cases and ignore the rest", async () => {
    expect({
      one: await passed(singleWriteEvaluator, written(), WRITE),
      none: await passed(singleWriteEvaluator, written({ writeCount: 0, personaUpdateCount: 0 }), WRITE),
      loop: await passed(singleWriteEvaluator, written({ writeCount: 3, personaUpdateCount: 3 }), WRITE),
      chitchat: await passed(singleWriteEvaluator, written({ writeCount: 2 }), { shouldWrite: false }),
    }).toEqual({ one: true, none: false, loop: false, chitchat: true })
  })

  it("should name every write kind when a created doc and a title change join the update", async () => {
    const r = await singleWriteEvaluator.evaluate(
      written({ writeCount: 3, createdDocCount: 1, titleChanged: true }),
      WRITE,
      ctx
    )
    expect(r).toEqual({
      name: "single-write",
      score: 0,
      passed: false,
      details: "Turn applied 3 writes (expected exactly 1): 1 doc updates, 1 created docs, title changed",
    })
  })
})

describe("scopedChangeEvaluator", () => {
  it("should pass when only the replaceable line of a section changed", async () => {
    expect(await passed(scopedChangeEvaluator, written(), WRITE)).toBe(true)
  })

  it("should pass when a single matching section was added", async () => {
    const out = written({
      touchedSections: [{ blockId: "block_new", before: null, after: "| GitHub token | DevEx |" }],
    })
    expect(
      await passed(scopedChangeEvaluator, out, { shouldWrite: true, touchedSectionMustMatch: /GitHub token/i })
    ).toBe(true)
  })

  it("should fail when more sections moved than allowed", async () => {
    const r = await scopedChangeEvaluator.evaluate(
      written({ touchedSections: [tickedTask, { blockId: "block_new", before: null, after: "stray paragraph" }] }),
      WRITE,
      ctx
    )
    expect(r).toMatchObject({ passed: false, details: "2 sections changed or added (max 1)" })
  })

  it("should fail when a block was removed", async () => {
    const r = await scopedChangeEvaluator.evaluate(written({ removedBlockIds: ["block_table"] }), WRITE, ctx)
    expect(r).toMatchObject({ passed: false, details: "removed blocks block_table" })
  })

  it("should fail naming the dropped line when a non-replaceable line disappears", async () => {
    const r = await scopedChangeEvaluator.evaluate(
      written({ touchedSections: [{ ...tickedTask, after: "- [x] Revoke the old AWS access key" }] }),
      WRITE,
      ctx
    )
    expect(r).toMatchObject({ passed: false, details: 'dropped line "- [ ] Rotate the Stripe secret" in block_tasks' })
  })

  it("should fail when no touched section matches the pattern", async () => {
    const r = await scopedChangeEvaluator.evaluate(
      written({ touchedSections: [{ ...tickedTask, after: TASKS_BEFORE }] }),
      WRITE,
      ctx
    )
    expect(r).toMatchObject({
      passed: false,
      details: `no changed or added section matches ${WRITE.touchedSectionMustMatch}`,
    })
  })

  it("should skip when the case expects no write", async () => {
    expect(await passed(scopedChangeEvaluator, written({ removedBlockIds: ["x"] }), { shouldWrite: false })).toBe(true)
  })
})

describe("reasonPresentEvaluator", () => {
  it("should require a non-blank reason on every persona edit when the case expects a write", async () => {
    expect({
      present: await passed(reasonPresentEvaluator, written(), WRITE),
      blank: await passed(reasonPresentEvaluator, written({ reasons: ["ok", "  "] }), WRITE),
      chitchat: await passed(reasonPresentEvaluator, written({ reasons: [""] }), { shouldWrite: false }),
    }).toEqual({ present: true, blank: false, chitchat: true })
  })
})

describe("accuracyEvaluator", () => {
  const pass: EvaluatorResult = { name: "x", score: 1, passed: true }
  const fail: EvaluatorResult = { name: "x", score: 0, passed: false }

  it("should pass when the pass rate sits at the 0.8 floor", () => {
    const cases = [
      ...Array.from({ length: 4 }, () => caseResult(written(), WRITE, [pass])),
      caseResult(output({}), WRITE, [fail]),
    ]
    expect(accuracyEvaluator.evaluate(cases)).toMatchObject({ score: 0.8, passed: true })
  })

  it("should fail and count errored cases as failures when below the floor", () => {
    const cases = [
      caseResult(written(), WRITE, [pass]),
      caseResult(written(), WRITE, [pass]),
      caseResult(output({ error: "boom" }), WRITE, [pass]),
      caseResult(output({}), WRITE, [fail]),
    ]
    expect(accuracyEvaluator.evaluate(cases)).toMatchObject({ score: 0.5, passed: false })
  })
})
