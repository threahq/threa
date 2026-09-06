import { describe, expect, test } from "bun:test"
import { rescoreReport } from "./rescore"
import type { AI } from "@threahq/agent-runtime"
import type { EvalSuite, EvaluatorResult } from "./types"

const stubAi = {} as AI

interface Out {
  text: string
}

interface Expected {
  must: string
}

function suiteWith(evaluate: (o: Out, e: Expected) => EvaluatorResult): EvalSuite<unknown, Out, Expected> {
  return {
    name: "demo",
    description: "rescore fixture",
    cases: [],
    task: async () => {
      throw new Error("rescore must never run the task")
    },
    evaluators: [{ name: "contains", evaluate }],
    runEvaluators: [
      {
        name: "accuracy",
        evaluate: (cases: Array<{ evaluations: EvaluatorResult[] }>) => {
          const passed = cases.filter((c) => c.evaluations.every((e) => e.passed)).length
          return { name: "accuracy", score: passed / cases.length, passed: passed === cases.length }
        },
      },
    ],
    defaultPermutations: [{ model: "openrouter:openai/gpt-5.6-luna", temperature: 0.7 }],
  } as unknown as EvalSuite<unknown, Out, Expected>
}

async function writeReport(cases: unknown[]): Promise<string> {
  const path = `/tmp/rescore-${crypto.randomUUID()}.json`
  await Bun.write(
    path,
    JSON.stringify({
      suites: [
        {
          suiteName: "demo: gpt-5.6-luna",
          permutations: [
            {
              model: "openrouter:openai/gpt-5.6-luna",
              temperature: 0.7,
              runs: 2,
              usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalCost: 1.23 },
              totalDurationMs: 4242,
              cases,
            },
          ],
        },
      ],
    })
  )
  return path
}

const containsMust = (o: Out, e: Expected): EvaluatorResult => ({
  name: "contains",
  score: o.text.includes(e.must) ? 1 : 0,
  passed: o.text.includes(e.must),
})

describe("rescore", () => {
  test("replays every stored run of a case through the current evaluators", async () => {
    const path = await writeReport([
      {
        caseId: "c1",
        caseName: "Case one",
        durationsMs: [100, 200],
        expectedOutput: { must: "yes" },
        outputs: [{ text: "yes it does" }, { text: "no it does not" }],
      },
    ])

    const [result] = await rescoreReport(path, [suiteWith(containsMust) as never], { ai: stubAi, onSuite: () => {} })
    const perm = result!.permutations[0]!

    expect(perm.cases.map((c) => ({ id: c.caseId, passed: c.evaluations[0]!.passed, ms: c.durationMs }))).toEqual([
      { id: "c1", passed: true, ms: 100 },
      { id: "c1", passed: false, ms: 200 },
    ])
    expect(perm.runEvaluations[0]).toMatchObject({ name: "accuracy", score: 0.5 })
  })

  test("a changed evaluator changes the verdict without re-running the task", async () => {
    const path = await writeReport([
      {
        caseId: "c1",
        caseName: "Case one",
        expectedOutput: { must: "yes" },
        outputs: [{ text: "YES it does" }],
      },
    ])

    const strict = await rescoreReport(path, [suiteWith(containsMust) as never], { ai: stubAi, onSuite: () => {} })
    expect(strict[0]!.permutations[0]!.cases[0]!.evaluations[0]!.passed).toBe(false)

    const caseInsensitive = (o: Out, e: Expected): EvaluatorResult => {
      const hit = o.text.toLowerCase().includes(e.must.toLowerCase())
      return { name: "contains", score: hit ? 1 : 0, passed: hit }
    }
    const relaxed = await rescoreReport(path, [suiteWith(caseInsensitive) as never], { ai: stubAi, onSuite: () => {} })
    expect(relaxed[0]!.permutations[0]!.cases[0]!.evaluations[0]!.passed).toBe(true)
  })

  test("reports only what rescoring itself cost, never the original run's generation cost", async () => {
    const path = await writeReport([
      { caseId: "c1", caseName: "Case one", expectedOutput: { must: "yes" }, outputs: [{ text: "yes" }] },
    ])

    const [result] = await rescoreReport(path, [suiteWith(containsMust) as never], { ai: stubAi, onSuite: () => {} })
    // The stored report claims $1.23 of generation. Carrying that forward would
    // double-count it the next time someone totals eval spend.
    expect(result!.permutations[0]!.usage!.totalCost).toBe(0)
  })

  test("refuses a report with no stored generations rather than scoring nothing", async () => {
    const path = await writeReport([
      { caseId: "c1", caseName: "Case one", expectedOutput: { must: "yes" }, outputs: [] },
    ])

    await expect(
      rescoreReport(path, [suiteWith(containsMust) as never], { ai: stubAi, onSuite: () => {} })
    ).rejects.toThrow(/no stored output/)
  })

  test("refuses a report naming a suite that is not registered", async () => {
    const path = await writeReport([
      { caseId: "c1", caseName: "Case one", expectedOutput: { must: "yes" }, outputs: [{ text: "yes" }] },
    ])

    await expect(rescoreReport(path, [], { ai: stubAi, onSuite: () => {} })).rejects.toThrow(/not registered/)
  })

  test("an evaluator that reaches for the database fails loudly instead of scoring blind", async () => {
    const path = await writeReport([
      { caseId: "c1", caseName: "Case one", expectedOutput: { must: "yes" }, outputs: [{ text: "yes" }] },
    ])

    const dbEvaluator = (_o: Out, _e: Expected, ctx?: unknown): EvaluatorResult => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (ctx as any).pool.query
      return { name: "contains", score: 1, passed: true }
    }
    const [result] = await rescoreReport(path, [suiteWith(dbEvaluator as never) as never], {
      ai: stubAi,
      onSuite: () => {},
    })
    expect(result!.permutations[0]!.cases[0]!.evaluations[0]!.details).toMatch(/tried to query the database/)
  })
  test("refuses to report scores when a judge call was rejected for credit", async () => {
    const path = await writeReport([
      { caseId: "c1", caseName: "Case one", expectedOutput: { must: "yes" }, outputs: [{ text: "yes" }] },
    ])

    // A judge call that dies on credit is caught by the evaluator's own
    // try/catch and becomes a plausible-looking quality failure. The whole
    // report would then be wrong in a way nothing on its face reveals.
    const rejectingAi = {
      generateObject: async () => {
        throw new Error("This request requires more credits, or fewer max_tokens.")
      },
    } as unknown as AI

    const judged = (_o: Out, _e: Expected, ctx?: unknown): Promise<EvaluatorResult> =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ctx as any).ai.generateObject({})

    await expect(
      rescoreReport(path, [suiteWith(judged as never) as never], { ai: rejectingAi, onSuite: () => {} })
    ).rejects.toThrow(/rejected for insufficient OpenRouter credit/)
  })

  test("refuses a run whose generation is missing rather than scoring a turn that never happened", async () => {
    const path = await writeReport([
      { caseId: "c1", caseName: "Case one", expectedOutput: { must: "yes" }, outputs: [{ text: "yes" }, null] },
    ])

    await expect(
      rescoreReport(path, [suiteWith(containsMust) as never], { ai: stubAi, onSuite: () => {} })
    ).rejects.toThrow(/no generation/)
  })
})
