/**
 * Replay evaluators over the generations a previous run already paid for.
 *
 * Two of the three restarts in the August 2026 Luna-vs-sonnet-5 comparison
 * changed only how output was SCORED — first the evaluators, then the judge
 * model — and each one re-ran 200+ live agent turns to re-grade text that was
 * already sitting in the report. The third restart exhausted the OpenRouter
 * key's weekly limit mid-run and invalidated the baseline arm.
 *
 * Generation is the expensive half and it is deterministic input to the cheap
 * half. So: `--rescore <report.json>` reads back the stored outputs, runs the
 * current evaluators (and, with `--judge`, a different judge) over them, and
 * costs nothing but judge calls.
 *
 * What this CANNOT do is re-run a case whose prompt, model, temperature or
 * task code changed — that is a new generation and must be run live. Rescore
 * only ever re-answers "how would today's evaluators grade yesterday's
 * answers".
 */

import type { EvalSuite, EvalContext, CaseResult, SuiteResult, PermutationResult } from "./types"
import type { AI } from "@threahq/agent-runtime"
import { createUsageAccumulator } from "./types"
import { createEvalAI, createUsageTrackingAI, printSummary } from "./runner"
import type { Pool } from "pg"

/** The subset of a report this needs. Written by `toJsonReport`. */
interface StoredReport {
  suites: Array<{
    suiteName: string
    permutations: Array<{
      model: string
      temperature: number | null
      runs: number
      usage: { inputTokens: number; outputTokens: number; reasoningTokens: number; totalCost: number } | null
      totalDurationMs: number
      cases: Array<{
        caseId: string
        caseName: string
        durationsMs?: number[]
        expectedOutput: unknown
        outputs: unknown[]
      }>
    }>
  }>
}

/**
 * A pool that fails loudly if an evaluator reaches for it. No evaluator in this
 * repo touches the database — the DB dependency lives in the task, which
 * rescore does not run — but a future one that does must not silently score
 * against an absent database (INV-11).
 */
function forbiddenPool(): Pool {
  const refuse = () => {
    throw new Error(
      "An evaluator tried to query the database during --rescore. Rescore replays stored generations only; " +
        "an evaluator that needs live state has to run in a normal eval run."
    )
  }
  return new Proxy({} as Pool, { get: refuse, apply: refuse })
}

/**
 * Re-run a suite's evaluators over the generations stored in a `--json` report.
 * Returns one result per suite entry in the report.
 */
export async function rescoreReport(
  reportPath: string,
  allSuites: EvalSuite<unknown, unknown, unknown>[],
  options: { judgeModel?: string; ai?: AI; onSuite?: (result: SuiteResult<unknown, unknown>) => void } = {}
): Promise<SuiteResult<unknown, unknown>[]> {
  const report = (await Bun.file(reportPath).json()) as StoredReport
  const ai = options.ai ?? createEvalAI()
  const reportSink = options.onSuite ?? printSummary
  const results: SuiteResult<unknown, unknown>[] = []

  for (const storedSuite of report.suites) {
    // Config-file runs label a suite "name: title"; the suite is the first segment.
    const baseName = storedSuite.suiteName.split(":")[0]!.trim()
    const suite = allSuites.find((s) => s.name === baseName)
    if (!suite) {
      throw new Error(`Report names suite "${baseName}", which is not registered in run.ts`)
    }

    const permutations: PermutationResult<unknown, unknown>[] = []
    for (const storedPerm of storedSuite.permutations) {
      const usage = createUsageAccumulator()
      // Rescoring is not free — every judge call is billed. Handing the raw AI
      // through would report $0 and an empty executed-model list for a run that
      // just spent money. The credit counter matters more: an evaluator's
      // try/catch turns a rejected judge call into a failed evaluation, so
      // without this a throttled rescore produces a full set of plausible,
      // invalid scores.
      const credit = { rejections: 0 }
      const trackedAi = createUsageTrackingAI(ai, usage, credit)
      const ctx: EvalContext = {
        pool: forbiddenPool(),
        ai: trackedAi,
        workspaceId: "rescore",
        userId: "rescore",
        permutation: { model: storedPerm.model, temperature: storedPerm.temperature ?? undefined },
        usage,
        credentials: {},
        judgeModel: options.judgeModel,
        configResolver: { resolve: async () => ({ modelId: storedPerm.model }) as never },
      }

      const cases: CaseResult<unknown, unknown>[] = []
      for (const storedCase of storedPerm.cases) {
        const stored = storedCase.outputs ?? []
        if (stored.length === 0) {
          throw new Error(
            `Case ${storedCase.caseId} has no stored output. Reports written before raw-output persistence ` +
              `cannot be rescored — re-run the suite live.`
          )
        }
        for (const [index, output] of stored.entries()) {
          // A case that errored during the original run has no generation.
          // Scoring that as if it were one produces a real-looking failure for
          // a turn that never happened — the same confusion a credit rejection
          // causes. Refuse it instead.
          if (output === null || output === undefined) {
            throw new Error(
              `Case ${storedCase.caseId} run ${index + 1} has no generation (the original run errored on it). ` +
                `Re-run that case live rather than rescoring a turn that never produced output.`
            )
          }
          const evaluations = await Promise.all(
            suite.evaluators.map(async (evaluator) => {
              try {
                return await evaluator.evaluate(output, storedCase.expectedOutput, ctx)
              } catch (error) {
                return {
                  name: evaluator.name,
                  score: 0,
                  passed: false,
                  details: `Evaluator error: ${error instanceof Error ? error.message : String(error)}`,
                }
              }
            })
          )
          cases.push({
            caseId: storedCase.caseId,
            caseName: storedCase.caseName,
            input: null,
            output,
            expectedOutput: storedCase.expectedOutput,
            evaluations,
            durationMs: storedCase.durationsMs?.[index] ?? 0,
          })
        }
      }

      const runEvaluations = suite.runEvaluators
        ? await Promise.all(suite.runEvaluators.map((e) => e.evaluate(cases)))
        : []

      if (credit.rejections > 0) {
        throw new Error(
          `${credit.rejections} judge call(s) were rejected for insufficient OpenRouter credit. Every evaluator ` +
            `catches its own errors, so these would have been reported as quality failures — top up and re-run.`
        )
      }

      const total = usage.getTotal()
      permutations.push({
        permutation: ctx.permutation,
        cases,
        runEvaluations,
        runs: storedPerm.runs,
        executedModels: usage.getModels(),
        // Judge cost only. The generation cost belongs to the original run and
        // is deliberately not merged in — that would double-count it.
        totalDurationMs: storedPerm.totalDurationMs,
        usage: {
          inputTokens: total.inputTokens,
          outputTokens: total.outputTokens,
          reasoningTokens: total.reasoningTokens,
          totalCost: total.totalCost,
        },
      })
    }

    const result: SuiteResult<unknown, unknown> = { suiteName: storedSuite.suiteName, permutations }
    reportSink(result)
    results.push(result)
  }

  return results
}
