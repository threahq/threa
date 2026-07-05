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
import { isConfigFilePath } from "./framework/config-loader"

// All available suites
const allSuites = [
  companionSuite,
  streamNamingSuite,
  boundaryExtractionSuite,
  multimodalVisionSuite,
  memoClassifierSuite,
  memorizerSuite,
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
    noLangfuse: values["no-langfuse"],
    verbose: values.verbose,
  }

  // Validate temperature
  if (options.temperature !== undefined && (options.temperature < 0 || options.temperature > 1)) {
    console.error("Error: Temperature must be between 0.0 and 1.0")
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
      })

      const hasFailures = results.some((r) =>
        r.permutations.some((p) => p.cases.some((c) => c.error || c.evaluations.some((e) => !e.passed)))
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

    // Determine exit code based on results
    const hasFailures = results.some((r) =>
      r.permutations.some((p) => p.cases.some((c) => c.error || c.evaluations.some((e) => !e.passed)))
    )

    process.exit(hasFailures ? 1 : 0)
  } catch (error) {
    console.error("\nEvaluation failed with error:")
    console.error(error)
    process.exit(1)
  }
}

main()
