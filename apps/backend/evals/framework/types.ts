/**
 * Core types for the AI evaluation framework.
 *
 * Designed for end-to-end evals with real database, real services, and real AI calls.
 * Integrates with Langfuse for experiment tracking.
 */

import type { Pool } from "pg"
import type { AI } from "@threa/agent-runtime"
import type { ConfigResolver } from "../../src/lib/ai/config-resolver"
import type { ComponentOverrides } from "./config-types"

// -----------------------------------------------------------------------------
// Usage Tracking
// -----------------------------------------------------------------------------

/**
 * Accumulates token usage and cost across AI calls.
 * Call recordUsage() after each AI call to track costs.
 */
export interface UsageAccumulator {
  /** Record usage from an AI call */
  recordUsage(usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cost?: number }): void
  /** Get accumulated totals */
  getTotal(): { inputTokens: number; outputTokens: number; totalCost: number }
}

/**
 * Create a new usage accumulator for tracking AI costs.
 */
export function createUsageAccumulator(): UsageAccumulator {
  let inputTokens = 0
  let outputTokens = 0
  let totalCost = 0

  return {
    recordUsage(usage) {
      inputTokens += usage.promptTokens ?? 0
      outputTokens += usage.completionTokens ?? 0
      totalCost += usage.cost ?? 0
    },
    getTotal() {
      return { inputTokens, outputTokens, totalCost }
    },
  }
}

// -----------------------------------------------------------------------------
// Context
// -----------------------------------------------------------------------------

/**
 * Context provided to each evaluation case.
 * Contains database connection, AI wrapper, and permutation info.
 */
export interface EvalContext {
  pool: Pool
  ai: AI
  workspaceId: string
  userId: string
  permutation: EvalPermutation
  /** Usage accumulator for tracking AI costs - call recordUsage() after AI calls */
  usage: UsageAccumulator
  /** Eval credentials sourced by the runner from environment/config */
  credentials: {
    tavilyApiKey?: string
  }
  /** Component-specific overrides from config file */
  componentOverrides?: ComponentOverrides
  /**
   * Config resolver for AI components.
   * Use this to get model/temperature/prompt configs instead of importing from config.ts.
   * Already has eval overrides applied from componentOverrides or permutation.
   */
  configResolver: ConfigResolver
}

// -----------------------------------------------------------------------------
// Permutations
// -----------------------------------------------------------------------------

/**
 * A permutation defines the configuration for an evaluation run.
 * Allows testing across different models, temperatures, and prompt variants.
 */
export interface EvalPermutation {
  /** Model in provider:modelPath format (e.g., "openrouter:anthropic/claude-haiku-4.5") */
  model: string
  /** Temperature for generation (0.0 to 1.0) */
  temperature?: number
  /** Key into suite's promptVariants registry */
  promptVariant?: string
  /** Title for this run (from config file) */
  runTitle?: string
}

// -----------------------------------------------------------------------------
// Cases
// -----------------------------------------------------------------------------

/**
 * A single evaluation case with input and expected output.
 * The generic types allow type-safe case definitions.
 */
export interface EvalCase<TInput, TExpected> {
  /** Unique identifier for this case (used in CLI filtering) */
  id: string
  /** Human-readable name for the case */
  name: string
  /** Input data passed to the task function */
  input: TInput
  /** Expected output for evaluator comparison */
  expectedOutput: TExpected
  /** Optional setup function to prepare test data */
  setup?: (ctx: EvalContext) => Promise<void>
  /** Optional teardown function to clean up after the case */
  teardown?: (ctx: EvalContext) => Promise<void>
}

// -----------------------------------------------------------------------------
// Evaluators
// -----------------------------------------------------------------------------

/**
 * Result from an evaluator.
 * Score is typically 0.0 (fail) to 1.0 (pass), but can be any numeric range.
 */
export interface EvaluatorResult {
  /** Name of the evaluator (used in Langfuse scoring) */
  name: string
  /** Score value - typically 0.0 to 1.0 */
  score: number
  /** Whether this evaluation passed (for aggregate reporting) */
  passed: boolean
  /** Optional details explaining the score */
  details?: string
}

/**
 * Evaluator function that compares actual output to expected.
 * Can be async to support LLM-as-judge evaluators.
 */
export interface Evaluator<TOutput, TExpected> {
  /** Name of this evaluator */
  name: string
  /** Evaluate function comparing output to expected */
  evaluate: (output: TOutput, expected: TExpected, ctx: EvalContext) => Promise<EvaluatorResult> | EvaluatorResult
}

/**
 * Run-level evaluator that operates on aggregate results.
 * Used for metrics like overall accuracy, consistency, etc.
 */
export interface RunEvaluator<TOutput, TExpected> {
  /** Name of this run evaluator */
  name: string
  /** Evaluate function operating on all case results */
  evaluate: (results: CaseResult<TOutput, TExpected>[]) => Promise<EvaluatorResult> | EvaluatorResult
}

// -----------------------------------------------------------------------------
// Results
// -----------------------------------------------------------------------------

/**
 * Result from running a single case.
 */
export interface CaseResult<TOutput, TExpected> {
  caseId: string
  caseName: string
  input: unknown
  output: TOutput
  expectedOutput: TExpected
  evaluations: EvaluatorResult[]
  /** Duration in milliseconds */
  durationMs: number
  /** Error if the case failed to run */
  error?: Error
}

/**
 * Result from running all cases in a permutation.
 */
export interface PermutationResult<TOutput, TExpected> {
  permutation: EvalPermutation
  cases: CaseResult<TOutput, TExpected>[]
  runEvaluations: EvaluatorResult[]
  /** Total duration in milliseconds */
  totalDurationMs: number
  /** Token usage stats */
  usage?: {
    inputTokens: number
    outputTokens: number
    totalCost?: number
  }
}

/**
 * Result from running an entire suite.
 */
export interface SuiteResult<TOutput, TExpected> {
  suiteName: string
  permutations: PermutationResult<TOutput, TExpected>[]
  /** Langfuse trace ID if recording was enabled */
  langfuseTraceId?: string
}

// -----------------------------------------------------------------------------
// Suite
// -----------------------------------------------------------------------------

/**
 * An evaluation suite defines the complete evaluation configuration.
 * Generic types ensure type safety between input, output, and expected values.
 */
export interface EvalSuite<TInput, TOutput, TExpected> {
  /** Unique name for this suite (used in CLI) */
  name: string

  /** Description of what this suite evaluates */
  description?: string

  /** Test cases to run */
  cases: EvalCase<TInput, TExpected>[]

  /**
   * Task function that produces output from input.
   * This is the function under test.
   */
  task: (input: TInput, ctx: EvalContext) => Promise<TOutput>

  /** Evaluators applied to each case result */
  evaluators: Evaluator<TOutput, TExpected>[]

  /** Optional run-level evaluators for aggregate metrics */
  runEvaluators?: RunEvaluator<TOutput, TExpected>[]

  /** Default permutations to run when none are specified via CLI */
  defaultPermutations: EvalPermutation[]

  /**
   * Registry of prompt variants for testing different system prompts.
   * Keys are variant names, values are the prompt strings.
   */
  promptVariants?: Record<string, string>

  /** Optional suite-level setup (runs once before all cases) */
  setup?: (ctx: EvalContext) => Promise<void>

  /** Optional suite-level teardown (runs once after all cases) */
  teardown?: (ctx: EvalContext) => Promise<void>
}

// -----------------------------------------------------------------------------
// Runner Options
// -----------------------------------------------------------------------------

/**
 * Options for the evaluation runner.
 */
export interface RunnerOptions {
  /** Filter to specific suite by name */
  suite?: string
  /** Filter to specific case IDs */
  cases?: string[]
  /** Override default permutations with custom model(s) - comma-separated for comparison */
  model?: string
  /** Override default temperature */
  temperature?: number
  /** Number of parallel workers (default: 1) */
  parallel?: number
  /** Disable Langfuse recording */
  noLangfuse?: boolean
  /** Verbose output */
  verbose?: boolean
}

// -----------------------------------------------------------------------------
// Database Options
// -----------------------------------------------------------------------------

/**
 * Options for database setup.
 */
export interface DatabaseOptions {
  /** Label for the database (used in name) */
  label?: string
}
