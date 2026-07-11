#!/usr/bin/env bun
/**
 * CLI entry point for running AI evaluations.
 *
 * Usage:
 *   bun run evals/run.ts                         # Run all suites
 *   bun run evals/run.ts -s companion             # Run specific suite
 *   bun run evals/run.ts -s companion -c case-001  # Run specific case
 *   bun run evals/run.ts -m openrouter:openai/gpt-5.4-nano  # Override model
 *   bun run evals/run.ts --no-langfuse           # Skip Langfuse recording
 */

import { parseArgs } from "util"
import { runSuites, runFromConfigFile } from "./framework/runner"
import type { RunnerOptions } from "./framework/types"
import { companionSuite } from "./suites/companion/suite"
import { streamNamingSuite } from "./suites/stream-naming/suite"
import { boundaryExtractionSuite } from "./suites/boundary-extraction/suite"
import { multimodalVisionSuite } from "./suites/multimodal-vision/suite"
import { memoClassifierSuite } from "./suites/memo-classifier/suite"
import { memorizerSuite } from "./suites/memorizer/suite"
import { briefCorrectionSuite } from "./suites/brief-correction/suite"
import { isConfigFilePath } from "./framework/config-loader"

// All available suites
const allSuites = [
  companionSuite,
  streamNamingSuite,
  boundaryExtractionSuite,
  multimodalVisionSuite,
  memoClassifierSuite,
  memorizerSuite,
  briefCorrectionSuite,
]

function printHelp(): void {
  const suiteNames = allSuites.map((s) => s.name).join(", ")
  const suiteList = allSuites
    .map((s) => {
      const name = s.name.padEnd(16)
      const desc = s.description || "No description"
      return `  ${name} - ${desc}`
    })
    .join("\n")

  console.log(`
AI Evaluation Framework

Usage: bun run evals/run.ts [options]

Options:
  -h, --help            Show this help message
  -s, --suite <name>    Run specific suite (${suiteNames})
  -c, --case <id>       Run specific case(s), comma-separated
  -m, --model <ids>     Override model(s), comma-separated for comparison
  -t, --temperature <n> Override temperature (0.0-1.0)
  -p, --parallel <n>    Number of parallel workers (default: 1)
  -r, --runs <n>        Repeat every case n times, report per-case pass rates (default: 1)
  --min-pass-rate <n>   Pass-rate a case must clear when runs > 1 (0.0-1.0, default: 1.0)
  --json <file>         Write machine-readable results JSON to <file>
  --config <file>       Run from YAML config file (ignores -s, -m flags)
  --no-langfuse         Disable Langfuse recording
  -v, --verbose         Verbose output

Examples:
  bun run evals/run.ts
    Run all suites with default configuration

  bun run evals/run.ts -s ${allSuites[0]?.name || "suite-name"}
    Run only the ${allSuites[0]?.name || "suite-name"} suite

  bun run evals/run.ts -s ${allSuites[1]?.name || "suite-name"} -c case-001,case-002
    Run specific test cases

  bun run evals/run.ts -m openrouter:openai/gpt-5.4-nano
    Override model for all suites

  bun run evals/run.ts -m openrouter:openai/gpt-5.4-nano,openrouter:anthropic/claude-haiku-4.5 -p 2
    Compare models in parallel

  bun run evals/run.ts --config companion-config.yaml
    Run with detailed per-component configuration from YAML file

  bun run evals/run.ts --no-langfuse -v
    Run with verbose output, skip Langfuse recording

Config File Format (YAML):
  suites:
  - name: companion
    title: "Default configuration"
    # No component overrides - uses production defaults

  - name: companion
    title: "Claude models everywhere"
    components:
      companion:
        model: openrouter:anthropic/claude-sonnet-4.5
        temperature: 0.7
      researcher:
        model: openrouter:anthropic/claude-haiku-4.5

Available Suites:
${suiteList}
`)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      suite: { type: "string", short: "s" },
      case: { type: "string", short: "c" },
      model: { type: "string", short: "m" },
      temperature: { type: "string", short: "t" },
      parallel: { type: "string", short: "p" },
      runs: { type: "string", short: "r" },
      "min-pass-rate": { type: "string" },
      json: { type: "string" },
      config: { type: "string" },
      "no-langfuse": { type: "boolean" },
      verbose: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
  })

  if (values.help) {
    printHelp()
    process.exit(0)
  }

  // Check for required environment variable
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("Error: OPENROUTER_API_KEY environment variable is required")
    console.error("Set it in your .env file or environment")
    process.exit(1)
  }

  // Build runner options
  const options: RunnerOptions = {
    suite: values.suite,
    cases: values.case?.split(",").map((c) => c.trim()),
    model: values.model,
    temperature: values.temperature ? parseFloat(values.temperature) : undefined,
    parallel: values.parallel ? parseInt(values.parallel, 10) : undefined,
    runs: values.runs ? parseInt(values.runs, 10) : undefined,
    minPassRate: values["min-pass-rate"] ? parseFloat(values["min-pass-rate"]) : undefined,
    jsonOutput: values.json,
    noLangfuse: values["no-langfuse"],
    verbose: values.verbose,
  }

  // Validate temperature
  if (options.temperature !== undefined && (options.temperature < 0 || options.temperature > 1)) {
    console.error("Error: Temperature must be between 0.0 and 1.0")
    process.exit(1)
  }

  if (options.runs !== undefined && (!Number.isInteger(options.runs) || options.runs < 1)) {
    console.error("Error: --runs must be a positive integer")
    process.exit(1)
  }

  if (options.minPassRate !== undefined && (options.minPassRate < 0 || options.minPassRate > 1)) {
    console.error("Error: --min-pass-rate must be between 0.0 and 1.0")
    process.exit(1)
  }

  // Validate config file path
  if (values.config && !isConfigFilePath(values.config)) {
    console.error("Error: Config file must have .yaml or .yml extension")
    process.exit(1)
  }

  // Validate suite name (only when not using config file)
  if (!values.config && options.suite && !allSuites.some((s) => s.name === options.suite)) {
    console.error(`Error: Unknown suite "${options.suite}"`)
    console.error(`Available suites: ${allSuites.map((s) => s.name).join(", ")}`)
    process.exit(1)
  }

  console.log("╔══════════════════════════════════════════════════════════╗")
  console.log("║              AI Evaluation Framework                      ║")
  console.log("╚══════════════════════════════════════════════════════════╝")

  // Config file mode: run from YAML config
  if (values.config) {
    console.log(`\nRunning from config file: ${values.config}`)
    if (options.noLangfuse) {
      console.log("Langfuse recording disabled")
    }

    try {
      const results = await runFromConfigFile(values.config, allSuites as any, {
        noLangfuse: options.noLangfuse,
        verbose: options.verbose,
        parallel: options.parallel,
        runs: options.runs,
      })

      if (options.jsonOutput) {
        await Bun.write(options.jsonOutput, JSON.stringify(toJsonReport(results), null, 2))
        console.log(`\nResults written to ${options.jsonOutput}`)
      }

      const minPassRate = options.minPassRate ?? 1
      const hasFailures = results.some((r) =>
        r.permutations.some((p) => aggregateCases(p).some((c) => c.passes / c.total < minPassRate))
      )
      process.exit(hasFailures ? 1 : 0)
    } catch (error) {
      console.error("\nEvaluation failed with error:")
      console.error(error)
      process.exit(1)
    }
  }

  // Standard mode: run with CLI flags
  if (options.suite) {
    console.log(`\nRunning suite: ${options.suite}`)
  } else {
    console.log(`\nRunning all ${allSuites.length} suites`)
  }

  if (options.model) {
    const models = options.model.split(",").map((m: string) => m.trim())
    if (models.length > 1) {
      console.log(`Comparing ${models.length} models: ${models.map((m: string) => m.split("/").pop()).join(", ")}`)
    } else {
      console.log(`Model override: ${options.model}`)
    }
  }

  if (options.parallel && options.parallel > 1) {
    console.log(`Parallel workers: ${options.parallel}`)
  }

  if (options.noLangfuse) {
    console.log("Langfuse recording disabled")
  }

  try {
    // Safe cast: runSuites accepts EvalSuite<unknown, unknown, unknown>[] but TypeScript
    // can't unify different generic instantiations. Each suite is processed independently.
    const results = await runSuites(allSuites as any, options)

    if (options.jsonOutput) {
      await Bun.write(options.jsonOutput, JSON.stringify(toJsonReport(results), null, 2))
      console.log(`\nResults written to ${options.jsonOutput}`)
    }

    // A case passes when its pass rate over the repeat runs clears the
    // threshold (default 1 = every run, matching single-run behavior).
    const minPassRate = options.minPassRate ?? 1
    const hasFailures = results.some((r) =>
      r.permutations.some((p) => aggregateCases(p).some((c) => c.passes / c.total < minPassRate))
    )

    process.exit(hasFailures ? 1 : 0)
  } catch (error) {
    console.error("\nEvaluation failed with error:")
    console.error(error)
    process.exit(1)
  }
}

interface CaseAggregate {
  caseId: string
  caseName: string
  passes: number
  total: number
  /** Failing evaluator details from the most recent failing run, for the JSON report. */
  lastFailure?: { name: string; details?: string }[]
}

function aggregateCases(p: {
  cases: Array<{ caseId: string; caseName: string; error?: Error; evaluations: Array<any> }>
}): CaseAggregate[] {
  const byCase = new Map<string, CaseAggregate>()
  for (const c of p.cases) {
    const passed = !c.error && c.evaluations.every((e) => e.passed)
    const agg = byCase.get(c.caseId) ?? { caseId: c.caseId, caseName: c.caseName, passes: 0, total: 0 }
    agg.passes += passed ? 1 : 0
    agg.total += 1
    if (!passed) {
      agg.lastFailure = c.error
        ? [{ name: "error", details: c.error.message }]
        : c.evaluations.filter((e) => !e.passed).map((e) => ({ name: e.name, details: e.details }))
    }
    byCase.set(c.caseId, agg)
  }
  return [...byCase.values()]
}

function toJsonReport(results: Array<any>) {
  return {
    suites: results.map((r) => ({
      suiteName: r.suiteName,
      permutations: r.permutations.map((p: any) => ({
        model: p.permutation.model,
        temperature: p.permutation.temperature ?? null,
        runs: p.runs,
        executedModels: p.executedModels,
        usage: p.usage ?? null,
        totalDurationMs: p.totalDurationMs,
        runEvaluations: p.runEvaluations.map((e: any) => ({
          name: e.name,
          score: e.score,
          passed: e.passed,
          details: e.details ?? null,
        })),
        cases: aggregateCases(p).map((c) => ({
          caseId: c.caseId,
          caseName: c.caseName,
          passes: c.passes,
          runs: c.total,
          passRate: c.passes / c.total,
          lastFailure: c.lastFailure ?? null,
        })),
      })),
    })),
  }
}

main()
