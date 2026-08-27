/**
 * Main evaluation runner.
 *
 * Orchestrates the evaluation process:
 * 1. Set up isolated database
 * 2. Create fixtures (workspace, users)
 * 3. Run each permutation
 * 4. Execute evaluators
 * 5. Clean up
 */

import { NoObjectGeneratedError } from "ai"
import type {
  EvalSuite,
  EvalContext,
  EvalPermutation,
  CaseResult,
  PermutationResult,
  SuiteResult,
  RunnerOptions,
} from "./types"
import { createUsageAccumulator } from "./types"
import { setupEvalDatabase, setupEvalTemplate, type EvalDatabaseResult, type EvalTemplateResult } from "./database"
import {
  createAI,
  type AI,
  type GenerateObjectOptions,
  type GenerateTextOptions,
  type GenerateTextWithToolsOptions,
} from "@threa/agent-runtime"
import type { UsageAccumulator } from "./types"
import { createWorkspaceFixture, type WorkspaceFixture } from "../fixtures/workspace"
import { loadConfigFile } from "./config-loader"
import type { ComponentOverrides, EvalConfigFile, SuiteRunConfig } from "./config-types"
import { createStaticConfigResolver } from "../../src/lib/ai/static-config-resolver"
import { createEvalConfigResolverFromYaml } from "./eval-config-resolver"

/**
 * Console output colors for terminal.
 */
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
}

/**
 * Format duration in human-readable form.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

/**
 * Format a value for display, with optional truncation.
 */
function formatValue(value: unknown, maxLength = 300): string {
  if (value === undefined) return "undefined"
  if (value === null) return "null"

  let str: string
  if (typeof value === "string") {
    str = value
  } else {
    try {
      str = JSON.stringify(value, null, 2)
    } catch {
      str = String(value)
    }
  }

  if (str.length > maxLength) {
    return str.slice(0, maxLength) + "... (truncated)"
  }
  return str
}

/**
 * Indent each line of a string.
 */
function indent(str: string, spaces: number): string {
  const pad = " ".repeat(spaces)
  return str
    .split("\n")
    .map((line) => pad + line)
    .join("\n")
}

/**
 * Create AI wrapper with eval configuration.
 */
export function createEvalAI(): AI {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY environment variable is required for evals")
  }

  return createAI({
    openrouter: { apiKey },
  })
}

/**
 * Wrap an AI instance to track usage in an accumulator.
 * Intercepts generateText and generateObject to record usage.
 */
/**
 * A provider rejection for exhausted credit is indistinguishable, downstream,
 * from a model that chose not to answer: the agent catches it, the case records
 * "did not respond", and the report shows a quality failure. That silently
 * invalidated a whole comparison arm in August 2026 — 1428 rejections read as
 * 0.6s turns. Counted here at the only place that sees the raw provider error.
 */
function isCreditRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /requires more credits|insufficient credit|exceeded your credit|quota exceeded/i.test(message)
}

export function createUsageTrackingAI(ai: AI, accumulator: UsageAccumulator, credit?: { rejections: number }): AI {
  const watch = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call()
    } catch (error) {
      if (credit && isCreditRejection(error)) credit.rejections++
      throw error
    }
  }

  return {
    ...ai,
    async generateText(options: GenerateTextOptions) {
      accumulator.recordModel(options.model)
      const result = await watch(() => ai.generateText(options))
      accumulator.recordUsage(result.usage)
      return result
    },
    async generateObject<T extends import("zod").ZodType>(options: GenerateObjectOptions<T>) {
      accumulator.recordModel(options.model)
      const result = await watch(() => ai.generateObject(options))
      accumulator.recordUsage(result.usage)
      return result
    },
    // The agent loop's own call, and the ONLY one that runs the persona's
    // model. Left unwrapped, an Ariadne model comparison reported neither the
    // tokens nor the cost of the model under test — just its sub-agents and
    // judges — and the "override never executed" guard fired on every run
    // because the model genuinely never appeared. `modelString` is the
    // provider:model id (`options.model` here is a resolved LanguageModel).
    async generateTextWithTools(options: GenerateTextWithToolsOptions) {
      if (options.modelString) accumulator.recordModel(options.modelString)
      const result = await watch(() => ai.generateTextWithTools(options))
      if (result.usage) accumulator.recordUsage(result.usage)
      return result
    },
  }
}

/**
 * Run a single evaluation case.
 */
async function runCase<TInput, TOutput, TExpected>(
  suite: EvalSuite<TInput, TOutput, TExpected>,
  caseItem: (typeof suite.cases)[number],
  ctx: EvalContext,
  options: RunnerOptions
): Promise<CaseResult<TOutput, TExpected>> {
  const startTime = Date.now()

  try {
    // Run case setup if provided
    if (caseItem.setup) {
      await caseItem.setup(ctx)
    }

    // Execute the task
    const output = await suite.task(caseItem.input, ctx)

    // Run evaluators
    const evaluations = await Promise.all(
      suite.evaluators.map(async (evaluator) => {
        try {
          return await evaluator.evaluate(output, caseItem.expectedOutput, ctx)
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

    // Run case teardown if provided
    if (caseItem.teardown) {
      await caseItem.teardown(ctx)
    }

    const durationMs = Date.now() - startTime

    return {
      caseId: caseItem.id,
      caseName: caseItem.name,
      input: caseItem.input,
      output,
      expectedOutput: caseItem.expectedOutput,
      evaluations,
      durationMs,
    }
  } catch (error) {
    const durationMs = Date.now() - startTime

    // Run teardown even on error
    if (caseItem.teardown) {
      try {
        await caseItem.teardown(ctx)
      } catch {
        // Ignore teardown errors
      }
    }

    return {
      caseId: caseItem.id,
      caseName: caseItem.name,
      input: caseItem.input,
      output: undefined as TOutput,
      expectedOutput: caseItem.expectedOutput,
      evaluations: [],
      durationMs,
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

/**
 * Options for running a single permutation.
 */
interface PermutationRunOptions extends RunnerOptions {
  /** Component-specific overrides from config file */
  judgeModel?: string
  componentOverrides?: ComponentOverrides
}

/**
 * Run all cases for a single permutation.
 */
async function runPermutation<TInput, TOutput, TExpected>(
  suite: EvalSuite<TInput, TOutput, TExpected>,
  permutation: EvalPermutation,
  dbResult: EvalDatabaseResult,
  ai: AI,
  fixture: WorkspaceFixture,
  options: PermutationRunOptions
): Promise<PermutationResult<TOutput, TExpected>> {
  const startTime = Date.now()
  const cases: CaseResult<TOutput, TExpected>[] = []

  // Filter cases if specified
  const casesToRun = options.cases ? suite.cases.filter((c) => options.cases!.includes(c.id)) : suite.cases

  // Create usage accumulator for cost tracking
  const usageAccumulator = createUsageAccumulator()

  // Wrap AI to track usage
  const credit = { rejections: 0 }
  const trackingAI = createUsageTrackingAI(ai, usageAccumulator, credit)

  // Create config resolver with eval overrides applied
  // Base resolver has production defaults; eval resolver applies componentOverrides
  const baseResolver = createStaticConfigResolver()
  const yamlResolver = createEvalConfigResolverFromYaml(baseResolver, options.componentOverrides)
  // A -m/-t permutation override must reach components that read their model
  // from the co-located config via ConfigResolver (INV-44) — boundary
  // extraction, memo classifier/memorizer. Without this wrap the CLI flag
  // silently relabels the run while the production model still executes.
  const hasCliPermutation = Boolean(options.model)
  const configResolver: typeof yamlResolver = hasCliPermutation
    ? {
        resolve: async (path: string) => ({
          ...(await yamlResolver.resolve(path)),
          modelId: permutation.model,
          ...(permutation.temperature !== undefined ? { temperature: permutation.temperature } : {}),
        }),
      }
    : yamlResolver

  // Create context for this permutation
  const ctx: EvalContext = {
    pool: dbResult.pool,
    ai: trackingAI,
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    permutation,
    usage: usageAccumulator,
    credentials: {
      tavilyApiKey: process.env.TAVILY_API_KEY,
    },
    judgeModel: options.judgeModel,
    componentOverrides: options.componentOverrides,
    configResolver,
  }

  // Run suite setup if provided
  if (suite.setup) {
    await suite.setup(ctx)
  }

  // Run each case sequentially; with --runs N the whole set repeats so
  // per-case pass rates can be tallied (stochastic components flip borderline
  // cases run-to-run — single-run green is not evidence).
  const runs = Math.max(1, options.runs ?? 1)
  const totalCases = casesToRun.length
  for (let run = 1; run <= runs; run++) {
    if (runs > 1) {
      console.log(`  ${colors.cyan}— run ${run}/${runs} —${colors.reset}`)
    }
    for (let i = 0; i < casesToRun.length; i++) {
      const caseItem = casesToRun[i]
      const caseNum = i + 1

      // Always show progress
      process.stdout.write(`  ${colors.dim}[${caseNum}/${totalCases}]${colors.reset} ${caseItem.name}... `)

      const result = await runCase(suite, caseItem, ctx, options)
      cases.push(result)

      // Show result status
      const passed = !result.error && result.evaluations.every((e) => e.passed)
      const status = result.error
        ? `${colors.red}ERROR${colors.reset}`
        : passed
          ? `${colors.green}PASS${colors.reset}`
          : `${colors.red}FAIL${colors.reset}`
      console.log(`${status} ${colors.dim}(${formatDuration(result.durationMs)})${colors.reset}`)

      // Show inline details for failures
      if (result.error) {
        console.log(`    ${colors.red}${result.error.message}${colors.reset}`)
        if (NoObjectGeneratedError.isInstance(result.error) && result.error.text) {
          console.log(`    ${colors.dim}Raw response: ${formatValue(result.error.text, 200)}${colors.reset}`)
        }
      } else if (!passed) {
        for (const evaluation of result.evaluations.filter((e) => !e.passed)) {
          console.log(
            `    ${colors.yellow}${evaluation.name}: ${evaluation.details || `score=${evaluation.score}`}${colors.reset}`
          )
        }
      }
    }
  }

  // Run suite teardown if provided
  if (suite.teardown) {
    await suite.teardown(ctx)
  }

  // Run run-level evaluators
  const runEvaluations = suite.runEvaluators ? await Promise.all(suite.runEvaluators.map((e) => e.evaluate(cases))) : []

  // Get accumulated usage
  const totalUsage = usageAccumulator.getTotal()
  const executedModels = usageAccumulator.getModels()

  // A run that hit the provider's credit ceiling did not measure the models, it
  // measured the ceiling — and the cheaper model survives it, so the result
  // even looks plausible. Refuse to report it (INV-11).
  if (credit.rejections > 0) {
    throw new Error(
      `${credit.rejections} model call(s) were rejected for insufficient OpenRouter credit. This run did not ` +
        `measure the models and its numbers must not be compared — top up the key's limit and re-run.`
    )
  }

  // A -m override that never executed is a silently-invalid comparison (the
  // exact bug this guard exists for) — fail loudly (INV-11). Suites whose
  // sub-components legitimately call other models still pass as long as the
  // requested model executed at least once.
  if (
    (options.model || getPrimaryComponentOverride(suite.name, options.componentOverrides)?.model) &&
    !(permutation.model in executedModels)
  ) {
    throw new Error(
      `Model override ${permutation.model} never executed — AI calls used: ${Object.keys(executedModels).join(", ")}. ` +
        `The comparison would be invalid; check the ConfigResolver wiring.`
    )
  }

  return {
    permutation,
    cases,
    runEvaluations,
    runs,
    executedModels,
    totalDurationMs: Date.now() - startTime,
    usage: {
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      reasoningTokens: totalUsage.reasoningTokens,
      totalCost: totalUsage.totalCost,
    },
  }
}

/**
 * Run a permutation with its own isolated database (for parallel execution).
 */
async function runPermutationIsolated<TInput, TOutput, TExpected>(
  suite: EvalSuite<TInput, TOutput, TExpected>,
  permutation: EvalPermutation,
  template: EvalTemplateResult,
  ai: AI,
  options: PermutationRunOptions
): Promise<PermutationResult<TOutput, TExpected>> {
  // Clone database from template
  const modelLabel = permutation.model.split("/").pop() || permutation.model
  const dbResult = await template.clone(modelLabel)

  try {
    // Create fixture for this permutation
    const fixture = await createWorkspaceFixture(dbResult.pool)

    const permLabel = permutation.runTitle || permutation.model
    console.log(`\n${colors.yellow}Permutation: ${permLabel}${colors.reset}`)

    return await runPermutation(suite, permutation, dbResult, ai, fixture, options)
  } finally {
    await dbResult.cleanup()
  }
}

/**
 * Format cost in USD.
 */
function formatCost(cost: number): string {
  if (cost === 0) return "-"
  if (cost < 0.001) return `$${cost.toFixed(6)}`
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(3)}`
}

/**
 * Print comparison table for multiple permutations.
 */
function printComparisonTable<TOutput, TExpected>(results: PermutationResult<TOutput, TExpected>[]): void {
  if (results.length < 2) return

  console.log("\n" + "=".repeat(90))
  console.log(`${colors.cyan}Model Comparison${colors.reset}`)
  console.log("=".repeat(90))

  // Header
  console.log(
    `${"Model".padEnd(35)} ${"Pass".padStart(6)} ${"Fail".padStart(6)} ${"Rate".padStart(8)} ${"Time".padStart(10)} ${"Cost".padStart(12)}`
  )
  console.log("-".repeat(90))

  // Sort by pass rate descending
  const sorted = [...results].sort((a, b) => {
    const aRate = a.cases.filter((c) => !c.error && c.evaluations.every((e) => e.passed)).length / a.cases.length
    const bRate = b.cases.filter((c) => !c.error && c.evaluations.every((e) => e.passed)).length / b.cases.length
    return bRate - aRate
  })

  for (const permResult of sorted) {
    const passed = permResult.cases.filter((c) => !c.error && c.evaluations.every((e) => e.passed)).length
    const failed = permResult.cases.length - passed
    const rate = ((passed / permResult.cases.length) * 100).toFixed(1) + "%"
    const model = permResult.permutation.model.split("/").pop() || permResult.permutation.model
    const cost = permResult.usage?.totalCost ?? 0

    const rateColor = passed === permResult.cases.length ? colors.green : passed > failed ? colors.yellow : colors.red

    console.log(
      `${model.padEnd(35)} ${String(passed).padStart(6)} ${String(failed).padStart(6)} ${rateColor}${rate.padStart(8)}${colors.reset} ${formatDuration(permResult.totalDurationMs).padStart(10)} ${formatCost(cost).padStart(12)}`
    )
  }

  console.log("=".repeat(90))
}

/**
 * Print summary of evaluation results.
 */
export function printSummary<TOutput, TExpected>(result: SuiteResult<TOutput, TExpected>): void {
  console.log("\n" + "=".repeat(60))
  console.log(`${colors.cyan}Suite: ${result.suiteName}${colors.reset}`)
  console.log("=".repeat(60))

  for (const permResult of result.permutations) {
    const { permutation, cases, totalDurationMs } = permResult
    const passedCases = cases.filter((c) => !c.error && c.evaluations.every((e) => e.passed))
    const failedCases = cases.filter((c) => c.error || c.evaluations.some((e) => !e.passed))

    if (permutation.runTitle) {
      console.log(`\nRun: ${permutation.runTitle}`)
      console.log(`  Model: ${permutation.model}`)
    } else {
      console.log(`\nPermutation: ${permutation.model}`)
    }
    if (permutation.temperature !== undefined) {
      console.log(`  Temperature: ${permutation.temperature}`)
    }
    if (permutation.promptVariant) {
      console.log(`  Prompt Variant: ${permutation.promptVariant}`)
    }

    console.log(
      `\n  ${colors.green}Passed: ${passedCases.length}${colors.reset}  ${colors.red}Failed: ${failedCases.length}${colors.reset}  ${colors.dim}Duration: ${formatDuration(totalDurationMs)}${colors.reset}`
    )

    const executedEntries = Object.entries(permResult.executedModels ?? {})
    if (executedEntries.length > 0) {
      console.log(
        `  ${colors.dim}Executed: ${executedEntries.map(([m, n]) => `${m} (${n} calls)`).join(", ")}${colors.reset}`
      )
    }

    // With repeat runs, the per-case tally is the readable unit — one line per
    // case with its pass rate — instead of N repeated lines.
    if (permResult.runs > 1) {
      console.log(`\n  Cases (pass rate over ${permResult.runs} runs):`)
      const byCase = new Map<string, { name: string; passes: number; total: number }>()
      for (const caseResult of cases) {
        const passed = !caseResult.error && caseResult.evaluations.every((e) => e.passed)
        const agg = byCase.get(caseResult.caseId) ?? { name: caseResult.caseName, passes: 0, total: 0 }
        agg.passes += passed ? 1 : 0
        agg.total += 1
        byCase.set(caseResult.caseId, agg)
      }
      for (const [caseId, agg] of byCase) {
        const rate = agg.passes / agg.total
        const mark =
          rate === 1
            ? `${colors.green}✓${colors.reset}`
            : rate === 0
              ? `${colors.red}✗${colors.reset}`
              : `${colors.yellow}~${colors.reset}`
        console.log(`    ${mark} ${agg.passes}/${agg.total} ${agg.name} ${colors.dim}(${caseId})${colors.reset}`)
      }
      if (permResult.runEvaluations.length > 0) {
        console.log("\n  Run Evaluations (across all runs):")
        for (const evaluation of permResult.runEvaluations) {
          const status = evaluation.passed ? colors.green : colors.red
          console.log(`    ${status}${evaluation.name}: ${evaluation.score}${colors.reset}`)
          if (evaluation.details) console.log(`      ${colors.dim}${evaluation.details}${colors.reset}`)
        }
      }
      continue
    }

    // Show all cases
    console.log("\n  Cases:")
    for (const caseResult of cases) {
      const passed = !caseResult.error && caseResult.evaluations.every((e) => e.passed)

      if (passed) {
        // Passed case - compact output
        console.log(`    ${colors.green}✓${colors.reset} ${caseResult.caseName}`)
      } else {
        // Failed case - detailed output
        console.log(`    ${colors.red}✗${colors.reset} ${caseResult.caseName}`)

        if (caseResult.error) {
          console.log(`      ${colors.red}Error: ${caseResult.error.message}${colors.reset}`)

          // Show raw model response for parsing errors
          if (NoObjectGeneratedError.isInstance(caseResult.error) && caseResult.error.text) {
            console.log(`      ${colors.dim}Raw response:${colors.reset}`)
            console.log(`${colors.dim}${indent(formatValue(caseResult.error.text, 500), 8)}${colors.reset}`)
          }

          // Show input that caused the error
          console.log(`      ${colors.dim}Input:${colors.reset}`)
          console.log(`${colors.dim}${indent(formatValue(caseResult.input), 8)}${colors.reset}`)
        } else {
          // Evaluation failures (not errors) - show input, output, expected
          for (const evaluation of caseResult.evaluations.filter((e) => !e.passed)) {
            console.log(`      ${colors.yellow}${evaluation.name}: ${evaluation.score}${colors.reset}`)
            if (evaluation.details) {
              console.log(`        ${colors.dim}${evaluation.details}${colors.reset}`)
            }
          }

          console.log(`      ${colors.dim}Input:${colors.reset}`)
          console.log(`${colors.dim}${indent(formatValue(caseResult.input), 8)}${colors.reset}`)

          console.log(`      ${colors.dim}Output:${colors.reset}`)
          console.log(`${colors.dim}${indent(formatValue(caseResult.output), 8)}${colors.reset}`)

          console.log(`      ${colors.dim}Expected:${colors.reset}`)
          console.log(`${colors.dim}${indent(formatValue(caseResult.expectedOutput), 8)}${colors.reset}`)
        }
      }
    }

    // Show run-level evaluations
    if (permResult.runEvaluations.length > 0) {
      console.log("\n  Run Evaluations:")
      for (const evaluation of permResult.runEvaluations) {
        const status = evaluation.passed ? colors.green : colors.red
        console.log(`    ${status}${evaluation.name}: ${evaluation.score}${colors.reset}`)
      }
    }
  }

  console.log("\n" + "=".repeat(60))
}

/**
 * Run a single evaluation suite.
 */
export async function runSuite<TInput, TOutput, TExpected>(
  suite: EvalSuite<TInput, TOutput, TExpected>,
  options: RunnerOptions = {}
): Promise<SuiteResult<TOutput, TExpected>> {
  console.log(`\n${colors.cyan}Running suite: ${suite.name}${colors.reset}`)
  if (suite.description) {
    console.log(`${colors.dim}${suite.description}${colors.reset}`)
  }

  // Create AI wrapper
  const ai = createEvalAI()

  // Determine permutations to run
  let permutations = suite.defaultPermutations
  if (options.model) {
    // Support comma-separated models for comparison
    const models = options.model.split(",").map((m) => m.trim())
    permutations = models.map((model) => ({
      model,
      temperature: options.temperature,
    }))
  }

  const permutationResults: PermutationResult<TOutput, TExpected>[] = []

  // Use parallel execution with template DBs if multiple permutations
  const useParallel = permutations.length > 1 && (options.parallel ?? 1) > 1

  if (useParallel) {
    // Create template DB once with migrations
    console.log(`\n${colors.dim}Setting up template database...${colors.reset}`)
    const template = await setupEvalTemplate(suite.name)

    try {
      // Run permutations in parallel (limited concurrency)
      const concurrency = Math.min(options.parallel ?? 4, permutations.length)
      console.log(
        `${colors.dim}Running ${permutations.length} permutations with ${concurrency} parallel workers${colors.reset}`
      )

      const chunks: EvalPermutation[][] = []
      for (let i = 0; i < permutations.length; i += concurrency) {
        chunks.push(permutations.slice(i, i + concurrency))
      }

      for (const chunk of chunks) {
        const results = await Promise.all(
          chunk.map((permutation) => runPermutationIsolated(suite, permutation, template, ai, options))
        )

        permutationResults.push(...results)
      }
    } finally {
      await template.cleanup()
    }
  } else {
    // Sequential execution with single database
    const dbResult = await setupEvalDatabase({ label: suite.name })
    const fixture = await createWorkspaceFixture(dbResult.pool)

    try {
      for (const permutation of permutations) {
        const permLabel = permutation.runTitle || permutation.model
        console.log(`\n${colors.yellow}Permutation: ${permLabel}${colors.reset}`)

        const permResult = await runPermutation(suite, permutation, dbResult, ai, fixture, options)
        permutationResults.push(permResult)
      }
    } finally {
      await dbResult.cleanup()
    }
  }

  const result: SuiteResult<TOutput, TExpected> = {
    suiteName: suite.name,
    permutations: permutationResults,
  }

  // Print summary
  printSummary(result)

  // Print comparison table if multiple permutations
  printComparisonTable(permutationResults)

  return result
}

/**
 * Run multiple evaluation suites.
 */
export async function runSuites(
  suites: EvalSuite<unknown, unknown, unknown>[],
  options: RunnerOptions = {}
): Promise<SuiteResult<unknown, unknown>[]> {
  // Filter suites if specified
  const suitesToRun = options.suite ? suites.filter((s) => s.name === options.suite) : suites

  if (suitesToRun.length === 0) {
    if (options.suite) {
      console.log(`${colors.red}No suite found with name: ${options.suite}${colors.reset}`)
      console.log(`Available suites: ${suites.map((s) => s.name).join(", ")}`)
    } else {
      console.log(`${colors.yellow}No suites to run${colors.reset}`)
    }
    return []
  }

  const results: SuiteResult<unknown, unknown>[] = []

  for (const suite of suitesToRun) {
    const result = await runSuite(suite, options)
    results.push(result)
  }

  // Print overall summary
  console.log("\n" + "=".repeat(60))
  console.log(`${colors.cyan}Overall Summary${colors.reset}`)
  console.log("=".repeat(60))

  let totalPassed = 0
  let totalFailed = 0

  for (const result of results) {
    for (const permResult of result.permutations) {
      for (const caseResult of permResult.cases) {
        if (!caseResult.error && caseResult.evaluations.every((e) => e.passed)) {
          totalPassed++
        } else {
          totalFailed++
        }
      }
    }
  }

  console.log(
    `\n${colors.green}Total Passed: ${totalPassed}${colors.reset}  ${colors.red}Total Failed: ${totalFailed}${colors.reset}`
  )

  return results
}

/**
 * Run evaluation suites from a config file.
 *
 * Config files allow detailed per-component overrides for complex suites
 * like the companion agent.
 */
const companionBackedSuites = new Set(["persona-style", "brief-correction", "multimodal-vision"])
export function getPrimaryComponentOverride(suiteName: string, components?: ComponentOverrides) {
  return components?.[suiteName] ?? (companionBackedSuites.has(suiteName) ? components?.companion : undefined)
}

export async function runFromConfigFile(
  configPath: string,
  allSuites: EvalSuite<unknown, unknown, unknown>[],
  baseOptions: Omit<RunnerOptions, "model" | "cases"> = {}
): Promise<SuiteResult<unknown, unknown>[]> {
  console.log(`\n${colors.cyan}Loading config file: ${configPath}${colors.reset}`)

  // Load and validate config
  const config = loadConfigFile(configPath)
  // `-s` narrows a multi-suite config to one suite's runs. A comparison config
  // pairs suites with different prerequisites (the companion half needs a
  // Tavily key, the style half does not), so running one half has to be
  // possible without editing the file that documents the comparison.
  const suiteRuns = baseOptions.suite ? config.suites.filter((s) => s.name === baseOptions.suite) : config.suites
  if (baseOptions.suite && suiteRuns.length === 0) {
    throw new Error(
      `Config ${configPath} has no runs for suite "${baseOptions.suite}" (it defines: ${[...new Set(config.suites.map((s) => s.name))].join(", ")})`
    )
  }
  console.log(`${colors.dim}Found ${suiteRuns.length} suite run(s) in config${colors.reset}`)

  // Create AI wrapper
  const ai = createEvalAI()

  const results: SuiteResult<unknown, unknown>[] = []

  for (const runConfig of suiteRuns) {
    // Find the suite
    const suite = allSuites.find((s) => s.name === runConfig.name)
    if (!suite) {
      console.log(`${colors.red}Unknown suite: ${runConfig.name}${colors.reset}`)
      console.log(`Available suites: ${allSuites.map((s) => s.name).join(", ")}`)
      continue
    }

    console.log(`\n${colors.cyan}Running suite: ${suite.name}${colors.reset}`)
    console.log(`${colors.yellow}Run: ${runConfig.title}${colors.reset}`)
    if (suite.description) {
      console.log(`${colors.dim}${suite.description}${colors.reset}`)
    }

    // Create permutation from config
    const basePermutation = suite.defaultPermutations[0] || { model: "openrouter:anthropic/claude-haiku-4.5" }

    // A suite's same-named component is its primary model (including the
    // established companion/companion convention). Object insertion order
    // must not decide comparison attribution.
    const primaryOverride = getPrimaryComponentOverride(suite.name, runConfig.components)
    const mainModel = primaryOverride?.model ?? basePermutation.model
    const mainTemperature = primaryOverride?.temperature ?? basePermutation.temperature

    const permutation: EvalPermutation = {
      model: mainModel,
      temperature: mainTemperature,
      promptVariant: primaryOverride?.prompt,
      runTitle: runConfig.title,
    }

    // Build options with component overrides
    const runOptions: PermutationRunOptions = {
      ...baseOptions,
      cases: runConfig.cases,
      componentOverrides: runConfig.components,
    }

    // Set up database and run
    const dbResult = await setupEvalDatabase({ label: `${suite.name}-${runConfig.title.replace(/\s+/g, "-")}` })
    const fixture = await createWorkspaceFixture(dbResult.pool)

    try {
      const permLabel = permutation.runTitle || permutation.model
      console.log(`\n${colors.yellow}Permutation: ${permLabel}${colors.reset}`)

      const permResult = await runPermutation(suite, permutation, dbResult, ai, fixture, runOptions)

      const result: SuiteResult<unknown, unknown> = {
        suiteName: `${suite.name}: ${runConfig.title}`,
        permutations: [permResult],
      }

      // Print summary
      printSummary(result)
      results.push(result)
      // Flush after every completed arm. A long comparison is a sequence of
      // independent arms, and serializing only at the very end means an
      // interruption — a SIGTERM, a killed shell — throws away every arm that
      // already finished and paid for itself. With this, an interrupted run
      // keeps what it completed and `--rescore` can still read it.
      await baseOptions.onSuiteResult?.(results)
    } finally {
      await dbResult.cleanup()
    }
  }

  // Print overall summary
  console.log("\n" + "=".repeat(60))
  console.log(`${colors.cyan}Overall Summary (Config File)${colors.reset}`)
  console.log("=".repeat(60))

  let totalPassed = 0
  let totalFailed = 0

  for (const result of results) {
    for (const permResult of result.permutations) {
      for (const caseResult of permResult.cases) {
        if (!caseResult.error && caseResult.evaluations.every((e) => e.passed)) {
          totalPassed++
        } else {
          totalFailed++
        }
      }
    }
  }

  console.log(
    `\n${colors.green}Total Passed: ${totalPassed}${colors.reset}  ${colors.red}Total Failed: ${totalFailed}${colors.reset}`
  )

  return results
}
