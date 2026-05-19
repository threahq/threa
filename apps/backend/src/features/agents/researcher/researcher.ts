import type { Pool } from "pg"
import { z } from "zod"
import { withClient } from "../../../db"
import { isAbortError, type AI } from "../../../lib/ai/ai"
import type { ConfigResolver, ResearcherConfig } from "../../../lib/ai/config-resolver"
import { COMPONENT_PATHS } from "../../../lib/ai/config-resolver"
import type { TraceSource } from "@threa/types"
import type { EmbeddingServiceLike } from "../../memos"
import { MessageRepository, type Message } from "../../messaging"
import { MemoRepository, classifyMemoQueryIntent } from "../../memos"
import { SearchRepository } from "../../search"
import { StreamRepository } from "../../streams"
import { AttachmentRepository } from "../../attachments"
import { computeAgentAccessSpec, type AgentAccessSpec } from "./access-spec"
import {
  formatRetrievedContext,
  enrichMessageSearchResults,
  type EnrichedMemoResult,
  type EnrichedMessageResult,
  type EnrichedAttachmentResult,
} from "./context-formatter"
import {
  resolveQuoteReplies,
  renderMessageWithQuoteContext,
  extractAppendedQuoteContext,
  DEFAULT_MAX_QUOTE_DEPTH,
} from "../quote-resolver"
import { logger } from "../../../lib/logger"
import { SEMANTIC_DISTANCE_THRESHOLD } from "../../search"
import {
  WORKSPACE_AGENT_MAX_ITERATIONS,
  WORKSPACE_AGENT_MAX_RESULTS_PER_SEARCH,
  WORKSPACE_AGENT_MAX_ADDITIONAL_QUERIES,
  WORKSPACE_AGENT_PLANNER_TIMEOUT_MS,
  WORKSPACE_AGENT_EVALUATOR_TIMEOUT_MS,
  WORKSPACE_AGENT_SYSTEM_PROMPT,
} from "./config"
import { buildBaselineQueries } from "./query/baseline-queries"
import { withResearcherSpan } from "./researcher-trace"

/**
 * Source item for citation - extended to support workspace sources.
 */
export interface WorkspaceSourceItem {
  type: "web" | "workspace"
  traceType?: TraceSource["type"]
  title: string
  url: string
  snippet?: string
  memoId?: string
  streamId?: string
  streamName?: string
  messageId?: string
  authorName?: string
}

/**
 * Reason a research call returned partial results rather than completing fully.
 */
export type WorkspaceAgentPartialReason = "user_abort" | "timeout"

/**
 * Persisted record of a single substep emitted during research execution.
 *
 * The researcher accumulates these in lockstep with live `onSubstep` callbacks via
 * the `emitSubstep` helper so the live stream and the persisted log always match.
 * On completion the tool's `trace.formatContent` bakes this array into step.content
 * JSON — no separate persistence path.
 */
export interface WorkspaceAgentSubstep {
  /** Human-readable phase text shown to the user. */
  text: string
  /** ISO timestamp when the substep was emitted. */
  at: string
}

/**
 * Result from running the workspace agent.
 */
export interface WorkspaceAgentResult {
  /** Formatted context to inject into system prompt */
  retrievedContext: string | null
  /** Sources for citation in the final message */
  sources: WorkspaceSourceItem[]
  /** Memos found (for debugging/logging) */
  memos: EnrichedMemoResult[]
  /** Messages found (for debugging/logging) */
  messages: EnrichedMessageResult[]
  /** Attachments found (for debugging/logging) */
  attachments?: EnrichedAttachmentResult[]
  /**
   * Full substep log accumulated during execution. Always populated (may be empty
   * for early-exit cases). Baked into step.content JSON for browser-refresh stability.
   */
  substeps: WorkspaceAgentSubstep[]
  /**
   * True when execution was cut short (abort or timeout) and the returned memos/
   * messages/attachments represent what was collected so far, not a completed run.
   */
  partial?: boolean
  /** Why the result is partial, if `partial === true`. */
  partialReason?: WorkspaceAgentPartialReason
}

/**
 * Input for running the workspace agent.
 */
export interface WorkspaceAgentInput {
  workspaceId: string
  streamId: string
  /** What the main agent wants to find */
  query: string
  conversationHistory: Message[]
  invokingUserId: string
  /**
   * Cooperative cancellation signal (from SessionAbortRegistry). When aborted the
   * researcher stops at the next safe checkpoint and returns partial results.
   * NOT the same as AgentRuntime.shouldAbort — this is graceful, not fatal.
   */
  signal?: AbortSignal
  /**
   * Called for each substep of execution. Used by the tool layer to emit
   * `tool:progress` events which become `agent_session:substep` socket events.
   * The researcher also records every substep into the result's `substeps` log.
   */
  onSubstep?: (text: string) => void
  /**
   * Absolute wall-clock deadline as epoch milliseconds. When `Date.now() >=
   * deadlineAt` at a checkpoint, the researcher returns partial results with
   * `partialReason: "timeout"`.
   */
  deadlineAt?: number
}

/**
 * Dependencies for the WorkspaceAgent.
 */
export interface WorkspaceAgentDeps {
  pool: Pool
  ai: AI
  configResolver: ConfigResolver
  embeddingService: EmbeddingServiceLike
}

// Schema for retrieval planning (always generates queries, no needsSearch gate)
const retrievalPlanSchema = z.object({
  reasoning: z.string(),
  queries: z.array(
    z.object({
      target: z.enum(["memos", "messages", "attachments"]),
      type: z.enum(["semantic", "exact"]),
      query: z.string(),
    })
  ),
})

// Schema for evaluation after seeing results
const evaluationSchema = z.object({
  sufficient: z.boolean(),
  additionalQueries: z
    .array(
      z.object({
        target: z.enum(["memos", "messages", "attachments"]),
        type: z.enum(["semantic", "exact"]),
        query: z.string(),
      })
    )
    .nullable(),
  reasoning: z.string(),
})

type SearchQuery = z.infer<typeof retrievalPlanSchema>["queries"][number]

function mergeMemoResults(existing: EnrichedMemoResult[], incoming: EnrichedMemoResult[]): EnrichedMemoResult[] {
  const merged = [...existing]
  const seen = new Set(existing.map((memo) => memo.memo.id))

  for (const memo of incoming) {
    if (seen.has(memo.memo.id)) continue
    seen.add(memo.memo.id)
    merged.push(memo)
  }

  return merged
}

function mergeMessageResults(
  existing: EnrichedMessageResult[],
  incoming: EnrichedMessageResult[]
): EnrichedMessageResult[] {
  const merged = [...existing]
  const seen = new Set(existing.map((message) => message.id))

  for (const message of incoming) {
    if (seen.has(message.id)) continue
    seen.add(message.id)
    merged.push(message)
  }

  return merged
}

function mergeAttachmentResults(
  existing: EnrichedAttachmentResult[],
  incoming: EnrichedAttachmentResult[]
): EnrichedAttachmentResult[] {
  const merged = [...existing]
  const seen = new Set(existing.map((attachment) => attachment.id))

  for (const attachment of incoming) {
    if (seen.has(attachment.id)) continue
    seen.add(attachment.id)
    merged.push(attachment)
  }

  return merged
}

/**
 * Workspace retrieval subagent that searches workspace knowledge on demand.
 *
 * Pure retrieval — the main agent decides *when* to call this. When called,
 * it always searches. Implements the GAM pattern:
 * plan retrieval → execute → evaluate → iterate.
 */
export class WorkspaceAgent {
  constructor(private readonly deps: WorkspaceAgentDeps) {}

  /**
   * Search entry point.
   *
   * IMPORTANT: Uses three-phase pattern (INV-41) to avoid holding database
   * connections during AI calls (which can take 10-30+ seconds total):
   *
   * Phase 1: Fetch all setup data with withClient (~100-200ms)
   * Phase 2: AI search loop with no connection held (10-30+ seconds)
   *          Uses pool.query for individual DB operations (fast)
   */
  async search(input: WorkspaceAgentInput): Promise<WorkspaceAgentResult> {
    const { pool } = this.deps
    const { workspaceId, streamId, invokingUserId } = input
    const substeps: WorkspaceAgentSubstep[] = []

    this.emitSubstep(substeps, "Checking workspace access…", input.onSubstep)

    // Abort check before any work
    const earlyExit = this.checkAbortOrDeadline(input)
    if (earlyExit) {
      return this.buildPartialResult([], [], [], workspaceId, substeps, earlyExit)
    }

    // Phase 1: Fetch all setup data with withClient (no transaction, fast reads ~100-200ms)
    const fetchedData = await withClient(pool, async (client) => {
      const stream = await StreamRepository.findById(client, streamId)
      if (!stream) {
        return { stream: null, accessSpec: null, accessibleStreamIds: null }
      }

      const accessSpec = await computeAgentAccessSpec(client, {
        stream,
        invokingUserId,
      })

      // Get accessible streams for searches
      const accessibleStreamIds = await SearchRepository.getAccessibleStreamsForAgent(client, accessSpec, workspaceId)

      return { stream, accessSpec, accessibleStreamIds }
    })

    // Return empty if stream not found
    if (!fetchedData.stream || !fetchedData.accessSpec || !fetchedData.accessibleStreamIds) {
      logger.warn({ streamId }, "Stream not found for workspace agent")
      return this.emptyResult(substeps)
    }

    logger.info(
      {
        query: input.query,
        accessSpecType: fetchedData.accessSpec.type,
        accessibleStreamCount: fetchedData.accessibleStreamIds.length,
        accessibleStreamIds: fetchedData.accessibleStreamIds.slice(0, 10),
      },
      "Workspace agent computed access"
    )

    if (fetchedData.accessibleStreamIds.length === 0) {
      logger.warn(
        { query: input.query, accessSpec: fetchedData.accessSpec },
        "No accessible streams for workspace agent"
      )
      return this.emptyResult(substeps)
    }

    // Phase 2: Run search loop (AI calls + DB queries, no connection held)
    return this.runSearchLoop(pool, input, fetchedData.accessSpec, fetchedData.accessibleStreamIds, substeps)
  }

  /**
   * Main search loop: bootstrap retrieval → refinement loop.
   *
   * This is the GAM "deep research" loop, structured as:
   *
   *   Iteration 1 (bootstrap):  parallel speculative baseline + planner LLM
   *   Iterations 2..N (refine): evaluate accumulated results → run any
   *                             additional queries the evaluator requests
   *
   * Bounded by:
   * - A hard wall-clock deadline via `input.deadlineAt`
   * - Per-AI-call abort signals composed from the user-abort signal + deadline
   * - `config.maxIterations` (defaults to `WORKSPACE_AGENT_MAX_ITERATIONS`)
   *   controls the total iteration count, so the refinement loop runs
   *   `maxIterations - 1` times. Setting it to 1 disables refinement entirely.
   *
   * `seenQueryKeys` accumulates across every iteration so each refinement pass
   * deduplicates against the union of all earlier queries — not just the
   * previous one.
   *
   * Uses pool.query for individual DB operations instead of holding a connection
   * through the entire loop (which includes AI calls).
   */
  private async runSearchLoop(
    pool: Pool,
    input: WorkspaceAgentInput,
    accessSpec: AgentAccessSpec,
    accessibleStreamIds: string[],
    substeps: WorkspaceAgentSubstep[]
  ): Promise<WorkspaceAgentResult> {
    const { configResolver, embeddingService } = this.deps
    const { workspaceId, query, conversationHistory, invokingUserId } = input

    // Resolve config for workspace agent
    const config = (await configResolver.resolve(COMPONENT_PATHS.COMPANION_RESEARCHER)) as ResearcherConfig

    const contextSummary = this.buildContextSummary(query, conversationHistory)
    const maxIterations = config.maxIterations ?? WORKSPACE_AGENT_MAX_ITERATIONS
    const excludedMessageIds = new Set<string>()
    const seenQueryKeys = new Set<string>()

    let allMemos: EnrichedMemoResult[] = []
    let allMessages: EnrichedMessageResult[] = []
    let allAttachments: EnrichedAttachmentResult[] = []

    // ── Iteration 1: parallel speculative baseline search + planner LLM ──
    //
    // The baseline queries are deterministic — they don't need an LLM. We fire
    // their executeQueries call in parallel with the planner LLM so the slowest
    // path (planner: ~1-3s) overlaps with the DB search (~500ms-1s). On the
    // common case where the planner's queries are mostly covered by baseline,
    // we need ~zero extra DB work after planning.

    this.emitSubstep(substeps, "Planning queries…", input.onSubstep)

    const preExec = this.checkAbortOrDeadline(input)
    if (preExec) {
      return this.buildPartialResult(allMemos, allMessages, allAttachments, workspaceId, substeps, preExec)
    }

    const baselineQueries = buildBaselineQueries(query)

    // Fire both in parallel. Each phase is wrapped in its own OTEL span so the
    // Langfuse trace shows intent ("baseline" / "plan-llm") instead of a flat
    // bag of embeds — and the per-phase input/output payloads carry the actual
    // queries and result counts.
    const baselinePromise =
      baselineQueries.length > 0
        ? withResearcherSpan(
            "ws-research:baseline",
            {
              input: { count: baselineQueries.length, queries: baselineQueries },
              extractOutput: summarizeQueryBatch,
            },
            () =>
              this.executeQueries(
                pool,
                baselineQueries,
                workspaceId,
                accessibleStreamIds,
                embeddingService,
                invokingUserId,
                true,
                excludedMessageIds
              )
          )
        : Promise.resolve({ memos: [], messages: [], attachments: [] })

    const planPromise = withResearcherSpan(
      "ws-research:plan-llm",
      {
        input: { query, contextSummary },
        extractOutput: (plan) => ({ reasoning: plan.reasoning, queries: plan.queries }),
      },
      () =>
        this.planRetrieval({
          contextSummary,
          config,
          workspaceId,
          query,
          signal: input.signal,
          deadlineAt: input.deadlineAt,
        })
    )

    const [baselineResults, plan] = await Promise.all([baselinePromise, planPromise])

    // Merge baseline results immediately so they're preserved even if abort fires
    // before the planner-only search runs.
    allMemos = mergeMemoResults(allMemos, baselineResults.memos)
    allMessages = mergeMessageResults(allMessages, baselineResults.messages)
    allAttachments = mergeAttachmentResults(allAttachments, baselineResults.attachments)
    for (const q of baselineQueries) seenQueryKeys.add(queryKey(q))

    // Abort may have fired during planner/baseline
    const postPlan = this.checkAbortOrDeadline(input)
    if (postPlan) {
      return this.buildPartialResult(allMemos, allMessages, allAttachments, workspaceId, substeps, postPlan)
    }

    // Compute planner-only queries: any planner queries not already in the baseline set.
    const plannerOnlyDeduped = dedupeQueries(plan.queries.filter((q) => !seenQueryKeys.has(queryKey(q))))

    if (plannerOnlyDeduped.length > 0) {
      this.emitSubstep(
        substeps,
        `Refining with ${plannerOnlyDeduped.length} planned ${plannerOnlyDeduped.length === 1 ? "query" : "queries"}…`,
        input.onSubstep
      )

      const plannerResults = await withResearcherSpan(
        "ws-research:plan-execute",
        {
          input: { count: plannerOnlyDeduped.length, queries: plannerOnlyDeduped },
          extractOutput: summarizeQueryBatch,
        },
        () =>
          this.executeQueries(
            pool,
            plannerOnlyDeduped,
            workspaceId,
            accessibleStreamIds,
            embeddingService,
            invokingUserId,
            true,
            excludedMessageIds
          )
      )

      allMemos = mergeMemoResults(allMemos, plannerResults.memos)
      allMessages = mergeMessageResults(allMessages, plannerResults.messages)
      allAttachments = mergeAttachmentResults(allAttachments, plannerResults.attachments)
      for (const q of plannerOnlyDeduped) seenQueryKeys.add(queryKey(q))
    } else if (baselineQueries.length === 0 && plan.queries.length === 0) {
      // No baseline, no planner queries — nothing to search.
      logger.debug({ query, reasoning: plan.reasoning }, "Workspace agent could not generate any queries")
      return this.emptyResult(substeps)
    }

    // Short-circuit: nothing found in iteration 1. The evaluator cannot salvage
    // an empty workspace — return non-partial empty (this is a successful
    // "nothing relevant here" result, not a truncated partial).
    if (allMemos.length + allMessages.length + allAttachments.length === 0) {
      logger.info(
        { query, accessSpecType: accessSpec.type },
        "Workspace agent iteration 1 returned no results; short-circuiting"
      )
      return this.buildFinalResult(allMemos, allMessages, allAttachments, workspaceId, substeps, false)
    }

    // ── Refinement loop (iterations 2..maxIterations): evaluator-driven ──
    //
    // Each pass: evaluate accumulated results → if sufficient, exit; else dedupe
    // additional queries against everything seen so far → execute → merge.
    // Setting maxIterations=1 skips this loop entirely.
    //
    // Each iteration is wrapped in its own OTEL span (`ws-research:refine N/M`)
    // with `evaluate` and `execute` as nested children, so the trace shows
    // exactly which iteration ran what. The body returns a tagged outcome so
    // partial-result and stop conditions can short-circuit the outer loop
    // without losing the span boundary.
    let stopRefining = false
    for (let iteration = 2; iteration <= maxIterations && !stopRefining; iteration++) {
      const outcome = await withResearcherSpan(
        `ws-research:refine ${iteration}/${maxIterations}`,
        {
          input: {
            iteration,
            maxIterations,
            accumulated: {
              memos: allMemos.length,
              messages: allMessages.length,
              attachments: allAttachments.length,
            },
          },
          extractOutput: (o: RefineIterationOutcome) => o.summary,
        },
        async (): Promise<RefineIterationOutcome> => {
          // Abort check before evaluator (each iteration is a checkpoint)
          const preEval = this.checkAbortOrDeadline(input)
          if (preEval) {
            return { kind: "partial", reason: preEval, summary: { aborted: preEval } }
          }

          this.emitSubstep(substeps, "Evaluating results…", input.onSubstep)

          const evaluation = await withResearcherSpan(
            "ws-research:evaluate",
            {
              input: {
                query,
                contextSummary,
                accumulated: {
                  memos: allMemos.length,
                  messages: allMessages.length,
                  attachments: allAttachments.length,
                },
              },
              extractOutput: (e) => ({
                sufficient: e.sufficient,
                reasoning: e.reasoning,
                additionalQueries: e.additionalQueries ?? [],
              }),
            },
            () =>
              this.evaluateResults(
                contextSummary,
                allMemos,
                allMessages,
                allAttachments,
                config,
                workspaceId,
                query,
                input.signal,
                input.deadlineAt
              )
          )

          if (evaluation.sufficient) {
            logger.debug({ query, reasoning: evaluation.reasoning }, "Workspace agent found sufficient results")
            return { kind: "stop", summary: { stopped: "sufficient", reasoning: evaluation.reasoning } }
          }

          const additional = (evaluation.additionalQueries ?? []).slice(0, WORKSPACE_AGENT_MAX_ADDITIONAL_QUERIES)
          const iterationQueries = dedupeQueries(additional).filter((q) => !seenQueryKeys.has(queryKey(q)))
          if (iterationQueries.length === 0) {
            logger.debug({ query }, "Workspace agent has no new queries to run; stopping refinement")
            return { kind: "stop", summary: { stopped: "no_new_queries", reasoning: evaluation.reasoning } }
          }

          // Abort check before execute
          const preExecIter = this.checkAbortOrDeadline(input)
          if (preExecIter) {
            return { kind: "partial", reason: preExecIter, summary: { aborted: preExecIter } }
          }

          this.emitSubstep(
            substeps,
            `Iteration ${iteration}/${maxIterations}: refining with ${iterationQueries.length} ${iterationQueries.length === 1 ? "query" : "queries"}…`,
            input.onSubstep
          )

          const iterationResults = await withResearcherSpan(
            "ws-research:execute",
            {
              input: { count: iterationQueries.length, queries: iterationQueries },
              extractOutput: summarizeQueryBatch,
            },
            () =>
              this.executeQueries(
                pool,
                iterationQueries,
                workspaceId,
                accessibleStreamIds,
                embeddingService,
                invokingUserId,
                true,
                excludedMessageIds
              )
          )

          allMemos = mergeMemoResults(allMemos, iterationResults.memos)
          allMessages = mergeMessageResults(allMessages, iterationResults.messages)
          allAttachments = mergeAttachmentResults(allAttachments, iterationResults.attachments)
          for (const q of iterationQueries) seenQueryKeys.add(queryKey(q))

          return {
            kind: "continue",
            summary: {
              ranQueries: iterationQueries.length,
              total: {
                memos: allMemos.length,
                messages: allMessages.length,
                attachments: allAttachments.length,
              },
            },
          }
        }
      )

      if (outcome.kind === "partial") {
        return this.buildPartialResult(allMemos, allMessages, allAttachments, workspaceId, substeps, outcome.reason)
      }
      if (outcome.kind === "stop") {
        stopRefining = true
      }
    }

    // Final abort check before building result
    const postLoop = this.checkAbortOrDeadline(input)
    if (postLoop) {
      return this.buildPartialResult(allMemos, allMessages, allAttachments, workspaceId, substeps, postLoop)
    }

    logger.info(
      {
        query,
        memoCount: allMemos.length,
        messageCount: allMessages.length,
        attachmentCount: allAttachments.length,
        accessSpecType: accessSpec.type,
      },
      "Workspace agent completed"
    )

    return this.buildFinalResult(allMemos, allMessages, allAttachments, workspaceId, substeps, false)
  }

  // ──────────────────────────────────────────────────────────────────────
  // Abort / deadline helpers
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Record a substep into the persistent log and fire the live callback.
   * Keeping both sides in a single helper guarantees they never drift.
   */
  private emitSubstep(
    substeps: WorkspaceAgentSubstep[],
    text: string,
    onSubstep: ((text: string) => void) | undefined
  ): void {
    substeps.push({ text, at: new Date().toISOString() })
    try {
      onSubstep?.(text)
    } catch (err) {
      logger.warn({ err, text }, "onSubstep callback threw; swallowing")
    }
  }

  /**
   * Returns a `WorkspaceAgentPartialReason` if the loop should stop immediately,
   * or undefined to continue. Called at safe checkpoints between phases.
   */
  private checkAbortOrDeadline(input: WorkspaceAgentInput): WorkspaceAgentPartialReason | undefined {
    if (input.signal?.aborted) return "user_abort"
    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) return "timeout"
    return undefined
  }

  /**
   * Build a composed per-call AbortSignal: fires when any of (user abort signal,
   * total deadline, per-call timeout) fires. Returns a cleanup function that must
   * be called in a `finally` to release timers / listeners.
   *
   * Takes explicit `signal` + `deadlineAt` rather than a `WorkspaceAgentInput` so
   * callers can't accidentally drop the deadline by casting a partial object
   * (Greptile caught exactly this bug — see PR #333).
   */
  private makePerCallSignal(
    params: { signal: AbortSignal | undefined; deadlineAt: number | undefined },
    perCallMs: number
  ): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController()
    const { signal: parentSignal, deadlineAt } = params

    const remainingBudget = deadlineAt !== undefined ? Math.max(0, deadlineAt - Date.now()) : Infinity
    const effectiveMs = Math.min(perCallMs, remainingBudget)

    const abortWithTimeout = () => {
      try {
        controller.abort(new DOMException("per-call timeout", "TimeoutError"))
      } catch {
        // DOMException not available in all runtimes; fall back to a plain Error
        controller.abort(new Error("per-call timeout"))
      }
    }

    let timer: ReturnType<typeof setTimeout> | null = null
    if (effectiveMs <= 0) {
      // Already past the deadline — abort synchronously so the awaiting AI call
      // throws AbortError immediately instead of consuming its full per-call budget.
      abortWithTimeout()
    } else if (effectiveMs !== Infinity) {
      timer = setTimeout(abortWithTimeout, effectiveMs)
    }

    let parentListener: (() => void) | null = null
    if (parentSignal) {
      if (parentSignal.aborted) {
        controller.abort(parentSignal.reason)
      } else {
        parentListener = () => controller.abort(parentSignal.reason)
        parentSignal.addEventListener("abort", parentListener, { once: true })
      }
    }

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer)
      if (parentListener && parentSignal) {
        parentSignal.removeEventListener("abort", parentListener)
      }
    }

    return { signal: controller.signal, cleanup }
  }

  /**
   * Build the final, complete (non-partial) result.
   */
  private buildFinalResult(
    memos: EnrichedMemoResult[],
    messages: EnrichedMessageResult[],
    attachments: EnrichedAttachmentResult[],
    workspaceId: string,
    substeps: WorkspaceAgentSubstep[],
    partial: boolean
  ): WorkspaceAgentResult {
    const sources = this.buildSources(memos, messages, attachments, workspaceId)
    const retrievedContext = formatRetrievedContext(memos, messages, attachments)
    return {
      retrievedContext,
      sources,
      memos,
      messages,
      attachments,
      substeps,
      ...(partial ? { partial: true } : {}),
    }
  }

  /**
   * Build a partial result from whatever has been collected so far. Appends a
   * "Returning partial results…" substep so the user sees why the run stopped.
   */
  private buildPartialResult(
    memos: EnrichedMemoResult[],
    messages: EnrichedMessageResult[],
    attachments: EnrichedAttachmentResult[],
    workspaceId: string,
    substeps: WorkspaceAgentSubstep[],
    reason: WorkspaceAgentPartialReason
  ): WorkspaceAgentResult {
    const stopText =
      reason === "user_abort"
        ? "Stopped on user request. Returning partial results…"
        : "Deadline reached. Returning partial results…"
    // Don't double-call onSubstep here — the caller already saw the abort path.
    substeps.push({ text: stopText, at: new Date().toISOString() })

    const sources = this.buildSources(memos, messages, attachments, workspaceId)
    const retrievedContext = formatRetrievedContext(memos, messages, attachments)

    logger.info(
      {
        reason,
        memoCount: memos.length,
        messageCount: messages.length,
        attachmentCount: attachments.length,
      },
      "Workspace agent returning partial result"
    )

    return {
      retrievedContext,
      sources,
      memos,
      messages,
      attachments,
      substeps,
      partial: true,
      partialReason: reason,
    }
  }

  /**
   * Plan retrieval queries for the given query.
   *
   * Wrapped in a per-call AbortSignal (user-abort + total-deadline + planner timeout).
   * On abort or schema repair failure returns an empty plan — the caller falls back
   * to baseline queries.
   */
  private async planRetrieval(params: {
    contextSummary: string
    config: ResearcherConfig
    workspaceId: string
    query: string
    signal: AbortSignal | undefined
    deadlineAt: number | undefined
  }): Promise<z.infer<typeof retrievalPlanSchema>> {
    const { ai } = this.deps
    const { contextSummary, config, workspaceId, query, signal, deadlineAt } = params

    const perCall = this.makePerCallSignal({ signal, deadlineAt }, WORKSPACE_AGENT_PLANNER_TIMEOUT_MS)
    try {
      const { value } = await ai.generateObject({
        model: config.modelId,
        schema: retrievalPlanSchema,
        messages: [
          { role: "system", content: WORKSPACE_AGENT_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Break down this query into targeted search queries to find relevant workspace knowledge.

## Query
${query}

${contextSummary}

Respond with:
- reasoning: brief explanation of your retrieval strategy
- queries: array of search queries to execute

Each query must have:
- target: "memos" | "messages" | "attachments"
- type: "semantic" | "exact"
- query: the search text

Guidelines for search:
- Use target "memos" for summarized knowledge (decisions, context, discussions)
- Use target "messages" for specific quotes, recent activity, or exact terms
- Use target "attachments" when looking for documents, images, or files
- Use type "semantic" for concepts/topics
- Use type "exact" for error messages, IDs, or quoted text`,
          },
        ],
        temperature: config.temperature,
        abortSignal: perCall.signal,
        telemetry: { functionId: "ws-plan", metadata: { query } },
        context: { workspaceId, origin: "system" },
      })

      return value
    } catch (error) {
      if (isAbortError(error)) {
        logger.debug({ query }, "Workspace planner aborted; returning empty plan")
        return { reasoning: "Aborted", queries: [] }
      }
      logger.warn({ error }, "Workspace agent retrieval planning failed, falling back to baseline")
      return { reasoning: "Planning failed", queries: [] }
    } finally {
      perCall.cleanup()
    }
  }

  /**
   * Evaluate if current results are sufficient.
   *
   * Wrapped in a per-call AbortSignal. On abort, treat as "sufficient" so the loop
   * exits cleanly with whatever was collected rather than stalling waiting for a
   * verdict we can't get.
   */
  private async evaluateResults(
    contextSummary: string,
    memos: EnrichedMemoResult[],
    messages: EnrichedMessageResult[],
    attachments: EnrichedAttachmentResult[],
    config: ResearcherConfig,
    workspaceId: string,
    query: string,
    signal: AbortSignal | undefined,
    deadlineAt: number | undefined
  ): Promise<z.infer<typeof evaluationSchema>> {
    const { ai } = this.deps
    const resultsText = this.formatResultsForEvaluation(memos, messages, attachments)

    const perCall = this.makePerCallSignal({ signal, deadlineAt }, WORKSPACE_AGENT_EVALUATOR_TIMEOUT_MS)
    try {
      const { value } = await ai.generateObject({
        model: config.modelId,
        schema: evaluationSchema,
        messages: [
          { role: "system", content: WORKSPACE_AGENT_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Evaluate if these search results are sufficient to answer the query.

## Query
${query}

${contextSummary}

## Current Results

${resultsText || "No results found yet."}

Decision rules:
- Default to sufficient=true. Return sufficient=false only if the results clearly fail to address the core of the query AND you have a specific narrower query likely to succeed.
- If uncertain, prefer sufficient=true.
- Keep additionalQueries to at most ${WORKSPACE_AGENT_MAX_ADDITIONAL_QUERIES} — the caller will cap it anyway.

Respond with:
- sufficient: true/false
- reasoning: brief explanation
- additionalQueries: array of queries (or null if sufficient)

Each query must have:
- target: "memos" | "messages" | "attachments"
- type: "semantic" | "exact"
- query: the search text`,
          },
        ],
        temperature: config.temperature,
        abortSignal: perCall.signal,
        telemetry: { functionId: "ws-eval", metadata: { query } },
        context: { workspaceId, origin: "system" },
      })

      return value
    } catch (error) {
      if (isAbortError(error)) {
        logger.debug({ query }, "Workspace evaluator aborted; treating as sufficient")
        return { sufficient: true, additionalQueries: null, reasoning: "Aborted" }
      }
      logger.warn({ error }, "Workspace agent evaluation failed, treating as sufficient")
      return { sufficient: true, additionalQueries: null, reasoning: "Evaluation failed" }
    } finally {
      perCall.cleanup()
    }
  }

  /**
   * Execute a set of search queries in parallel.
   * Uses pool.query for individual DB operations (fast, ~10-50ms each).
   */
  private async executeQueries(
    pool: Pool,
    queries: SearchQuery[],
    workspaceId: string,
    accessibleStreamIds: string[],
    embeddingService: EmbeddingServiceLike,
    invokingUserId: string,
    includeSurroundingContext: boolean,
    excludedMessageIds: Set<string>
  ): Promise<{
    memos: EnrichedMemoResult[]
    messages: EnrichedMessageResult[]
    attachments: EnrichedAttachmentResult[]
  }> {
    // Execute all queries in parallel. Each query gets its own OTEL span so the
    // trace shows what each underlying ai.embed was *for*: target, type, and
    // the query text in the span input, plus result counts/snippets in the
    // output. The embed/search work runs inside the span context so the AI
    // SDK's `ai.embed` span nests under the per-query span automatically.
    const results = await Promise.all(
      queries.map((query) =>
        withResearcherSpan(
          `ws-research:query (${query.target}|${query.type})`,
          {
            input: { target: query.target, type: query.type, query: query.query },
            attributes: {
              "ws.query.target": query.target,
              "ws.query.type": query.type,
            },
            extractOutput: describeQueryResult,
          },
          async () => {
            if (query.target === "memos") {
              const memoResults = await this.searchMemos(
                pool,
                query,
                workspaceId,
                accessibleStreamIds,
                embeddingService
              )
              return {
                type: "memos" as const,
                memos: memoResults,
                messages: [] as EnrichedMessageResult[],
                attachments: [] as EnrichedAttachmentResult[],
                search: {
                  target: "memos" as const,
                  type: query.type,
                  query: query.query,
                  resultCount: memoResults.length,
                },
              }
            } else if (query.target === "messages") {
              const messageResults = await this.searchMessages(
                pool,
                query,
                workspaceId,
                accessibleStreamIds,
                includeSurroundingContext,
                excludedMessageIds
              )
              return {
                type: "messages" as const,
                memos: [] as EnrichedMemoResult[],
                messages: messageResults,
                attachments: [] as EnrichedAttachmentResult[],
                search: {
                  target: "messages" as const,
                  type: query.type,
                  query: query.query,
                  resultCount: messageResults.length,
                },
              }
            } else {
              const attachmentResults = await this.searchAttachments(pool, query, workspaceId, accessibleStreamIds)
              return {
                type: "attachments" as const,
                memos: [] as EnrichedMemoResult[],
                messages: [] as EnrichedMessageResult[],
                attachments: attachmentResults,
                search: {
                  target: "attachments" as const,
                  type: query.type,
                  query: query.query,
                  resultCount: attachmentResults.length,
                },
              }
            }
          }
        )
      )
    )

    // Aggregate results
    const memos: EnrichedMemoResult[] = []
    const messages: EnrichedMessageResult[] = []
    const attachments: EnrichedAttachmentResult[] = []
    const searches: Array<{ target: string; type: string; query: string; resultCount: number }> = []

    for (const result of results) {
      memos.push(...result.memos)
      messages.push(...result.messages)
      attachments.push(...result.attachments)
      searches.push(result.search)
    }

    logger.debug(
      {
        queryCount: searches.length,
        searches: searches.map((search) => ({
          target: search.target,
          type: search.type,
          query: search.query,
          resultCount: search.resultCount,
        })),
      },
      "Workspace agent query batch completed"
    )

    return { memos, messages, attachments }
  }

  /**
   * Search memos with a query.
   * Uses withClient for DB operations (fast, ~10-50ms).
   */
  private async searchMemos(
    pool: Pool,
    query: SearchQuery,
    workspaceId: string,
    accessibleStreamIds: string[],
    embeddingService: EmbeddingServiceLike
  ): Promise<EnrichedMemoResult[]> {
    // For semantic search, generate embedding (AI, no DB, ~200-500ms)
    if (query.type === "semantic") {
      try {
        const embedding = await embeddingService.embed(query.query, {
          workspaceId,
          functionId: "ws-memo-embed",
        })
        // Hybrid keyword + vector with RRF fusion (B1); the intent
        // classifier (B4) bends the per-list weights and the B2 structural
        // boost (bypassed for temporal intent). The accessible-stream
        // predicate is the agent-invocation scope resolved upstream and is
        // pushed into both inner CTEs before fusion (§3.1). Single query
        // (INV-30). The B3 reranker is intentionally not run on this
        // latency-budgeted multi-search loop — the plan cost-gates rerank
        // to the user-facing surface.
        const intent = classifyMemoQueryIntent(query.query)
        const hybridResults = await MemoRepository.hybridSearch(pool, {
          workspaceId,
          query: query.query,
          embedding,
          filters: { streamIds: accessibleStreamIds },
          limit: WORKSPACE_AGENT_MAX_RESULTS_PER_SEARCH,
          keywordWeight: intent.keywordWeight,
          semanticWeight: intent.semanticWeight,
          applyStructuralBoost: intent.intent !== "temporal",
          semanticDistanceThreshold: SEMANTIC_DISTANCE_THRESHOLD,
        })
        const results =
          hybridResults.length > 0
            ? hybridResults
            : await MemoRepository.fullTextSearch(pool, {
                workspaceId,
                query: query.query,
                filters: { streamIds: accessibleStreamIds },
                limit: WORKSPACE_AGENT_MAX_RESULTS_PER_SEARCH,
              })

        return results.map((r) => ({
          memo: r.memo,
          distance: r.distance,
          sourceStream: r.sourceStream,
        }))
      } catch (error) {
        logger.warn({ error, query: query.query }, "Memo hybrid search failed; falling back to full-text")
        try {
          const fallback = await MemoRepository.fullTextSearch(pool, {
            workspaceId,
            query: query.query,
            filters: { streamIds: accessibleStreamIds },
            limit: WORKSPACE_AGENT_MAX_RESULTS_PER_SEARCH,
          })
          return fallback.map((r) => ({
            memo: r.memo,
            distance: r.distance,
            sourceStream: r.sourceStream,
          }))
        } catch (fallbackError) {
          logger.warn({ fallbackError, query: query.query }, "Memo full-text fallback failed")
          return []
        }
      }
    }

    // For exact search, use full-text search (single query, INV-30)
    try {
      const results = await MemoRepository.exactSearch(pool, {
        workspaceId,
        query: query.query,
        filters: { streamIds: accessibleStreamIds },
        limit: WORKSPACE_AGENT_MAX_RESULTS_PER_SEARCH,
      })

      return results.map((r) => ({
        memo: r.memo,
        distance: r.distance,
        sourceStream: r.sourceStream,
      }))
    } catch (error) {
      logger.warn({ error, query: query.query }, "Memo full-text search failed")
      return []
    }
  }

  /**
   * Search messages with a query and enrich results.
   * Uses withClient for DB operations (fast, ~10-50ms).
   */
  private async searchMessages(
    pool: Pool,
    query: SearchQuery,
    workspaceId: string,
    accessibleStreamIds: string[],
    includeSurroundingContext: boolean,
    excludedMessageIds: Set<string>
  ): Promise<EnrichedMessageResult[]> {
    const { embeddingService } = this.deps

    // Build query string - for exact, wrap in quotes
    const searchQuery = query.type === "exact" ? `"${query.query}"` : query.query

    try {
      // Generate embedding for semantic search (AI, no DB, ~200-500ms)
      let embedding: number[] = []
      if (searchQuery.trim()) {
        try {
          embedding = await embeddingService.embed(searchQuery, {
            workspaceId,
            functionId: "ws-msg-embed",
          })
        } catch (error) {
          logger.warn({ error }, "Failed to generate embedding, falling back to keyword-only search")
        }
      }

      // DB search (fast, ~10-50ms)
      return await withClient(pool, async (client) => {
        const filters = {}
        const normalizedQuery = searchQuery.trim()
        const hasQuery = normalizedQuery.length > 0
        const hasEmbedding = embedding.length > 0
        const primaryResults =
          !hasQuery || !hasEmbedding
            ? await SearchRepository.fullTextSearch(client, {
                query: normalizedQuery,
                streamIds: accessibleStreamIds,
                filters,
                limit: WORKSPACE_AGENT_MAX_RESULTS_PER_SEARCH,
              })
            : await SearchRepository.hybridSearch(client, {
                query: normalizedQuery,
                embedding,
                streamIds: accessibleStreamIds,
                filters,
                limit: WORKSPACE_AGENT_MAX_RESULTS_PER_SEARCH,
                semanticDistanceThreshold: SEMANTIC_DISTANCE_THRESHOLD,
              })
        const searchResults =
          hasQuery && hasEmbedding && primaryResults.length === 0
            ? await SearchRepository.fullTextSearch(client, {
                query: normalizedQuery,
                streamIds: accessibleStreamIds,
                filters,
                limit: WORKSPACE_AGENT_MAX_RESULTS_PER_SEARCH,
              })
            : primaryResults

        const filteredSearchResults = searchResults.filter((result) => !excludedMessageIds.has(result.id))
        const rawResults = [...filteredSearchResults]
        if (includeSurroundingContext && filteredSearchResults.length > 0) {
          const surroundingBatches = await Promise.all(
            filteredSearchResults
              .slice(0, 3)
              .map((result) => MessageRepository.findSurrounding(client, result.id, result.streamId, 1, 1))
          )

          for (const surrounding of surroundingBatches) {
            for (const message of surrounding) {
              if (excludedMessageIds.has(message.id)) {
                continue
              }
              rawResults.push({
                id: message.id,
                streamId: message.streamId,
                content: message.contentMarkdown,
                authorId: message.authorId,
                authorType: message.authorType,
                sequence: message.sequence,
                replyCount: message.replyCount,
                metadata: message.metadata,
                editedAt: message.editedAt,
                createdAt: message.createdAt,
                rank: 0,
              })
            }
          }

          const topStreamIds = [...new Set(filteredSearchResults.slice(0, 2).map((result) => result.streamId))]
          const recentMessagesByStream = await Promise.all(
            topStreamIds.map((streamId) => MessageRepository.list(client, streamId, { limit: 5 }))
          )
          for (const streamMessages of recentMessagesByStream) {
            for (const message of streamMessages) {
              if (excludedMessageIds.has(message.id)) {
                continue
              }
              rawResults.push({
                id: message.id,
                streamId: message.streamId,
                content: message.contentMarkdown,
                authorId: message.authorId,
                authorType: message.authorType,
                sequence: message.sequence,
                replyCount: message.replyCount,
                metadata: message.metadata,
                editedAt: message.editedAt,
                createdAt: message.createdAt,
                rank: 0,
              })
            }
          }
        }

        const dedupedResultsById = new Map<string, (typeof rawResults)[number]>()
        for (const result of rawResults) {
          if (excludedMessageIds.has(result.id)) {
            continue
          }
          if (!dedupedResultsById.has(result.id)) {
            dedupedResultsById.set(result.id, result)
          }
        }

        // Enrich results with author names and stream names
        const enriched = await enrichMessageSearchResults(client, workspaceId, [...dedupedResultsById.values()])

        // Resolve quote-reply precursors for each retrieved message so Ariadne
        // sees the full source of anything that was quoted, not just the
        // snippet. Requires a batch fetch because `EnrichedMessageResult` does
        // not carry `contentJson`.
        if (enriched.length > 0) {
          const seedMessageMap = await MessageRepository.findByIdsInStreams(
            client,
            enriched.map((e) => e.id),
            accessibleStreamIds
          )
          if (seedMessageMap.size > 0) {
            const { resolved, authorNames } = await resolveQuoteReplies(client, workspaceId, {
              seedMessages: [...seedMessageMap.values()],
              accessibleStreamIds: new Set(accessibleStreamIds),
            })
            if (resolved.size > 0) {
              for (const e of enriched) {
                const seed = seedMessageMap.get(e.id)
                if (!seed) continue
                const rendered = renderMessageWithQuoteContext(seed, resolved, authorNames, 0, DEFAULT_MAX_QUOTE_DEPTH)
                const appended = extractAppendedQuoteContext(rendered, seed.contentMarkdown)
                if (appended.length > 0) {
                  e.quoteContext = appended
                }
              }
            }
          }
        }

        return enriched
      })
    } catch (error) {
      logger.warn({ error, query: query.query }, "Message search failed")
      return []
    }
  }

  /**
   * Search attachments with a query.
   * Uses keyword search on filename and extraction content.
   */
  private async searchAttachments(
    pool: Pool,
    query: SearchQuery,
    workspaceId: string,
    accessibleStreamIds: string[]
  ): Promise<EnrichedAttachmentResult[]> {
    try {
      const results = await AttachmentRepository.searchWithExtractions(pool, {
        workspaceId,
        streamIds: accessibleStreamIds,
        query: query.query,
        limit: WORKSPACE_AGENT_MAX_RESULTS_PER_SEARCH,
      })

      return results.map((r) => ({
        id: r.id,
        filename: r.filename,
        mimeType: r.mimeType,
        streamId: r.streamId,
        contentType: r.extraction?.contentType ?? null,
        summary: r.extraction?.summary ?? null,
        createdAt: r.createdAt,
      }))
    } catch (error) {
      logger.warn({ error, query: query.query }, "Attachment search failed")
      return []
    }
  }

  /**
   * Build sources for citation.
   */
  private buildSources(
    memos: EnrichedMemoResult[],
    messages: EnrichedMessageResult[],
    attachments: EnrichedAttachmentResult[],
    workspaceId: string
  ): WorkspaceSourceItem[] {
    const sources: WorkspaceSourceItem[] = []

    for (const { memo, sourceStream } of memos) {
      sources.push({
        type: "workspace",
        traceType: "workspace_memo",
        title: memo.title,
        url: `/w/${workspaceId}/memory?memo=${memo.id}`,
        snippet: memo.abstract.slice(0, 200),
        memoId: memo.id,
        streamId: sourceStream?.id,
        streamName: sourceStream?.name ?? sourceStream?.type,
      })
    }

    for (const msg of messages) {
      sources.push({
        type: "workspace",
        traceType: "workspace_message",
        title: `${msg.authorName} in ${msg.streamName}`,
        url: `/w/${workspaceId}/s/${msg.streamId}?m=${msg.id}`,
        snippet: msg.content.slice(0, 200),
        streamId: msg.streamId,
        streamName: msg.streamName,
        messageId: msg.id,
        authorName: msg.authorName,
      })
    }

    for (const att of attachments) {
      sources.push({
        type: "workspace",
        traceType: "workspace",
        title: att.filename,
        url: att.streamId ? `/w/${workspaceId}/s/${att.streamId}` : `/w/${workspaceId}`,
        snippet: att.summary?.slice(0, 200),
        streamId: att.streamId ?? undefined,
      })
    }

    return sources
  }

  /**
   * Build context summary for the workspace agent.
   */
  private buildContextSummary(query: string, conversationHistory: Message[]): string {
    const recentMessages = conversationHistory.slice(-5)
    const historyText = recentMessages.map((m) => `${m.authorType}: ${m.contentMarkdown}`).join("\n")

    return `## Recent Conversation
${historyText || "No recent messages."}`
  }

  /**
   * Format results for evaluation prompt.
   *
   * Deliberately compact: title + short snippet only. The evaluator only needs enough
   * signal to judge "do these results address the query?" — sending the full abstracts
   * inflates the prompt (and per-iteration cost) without improving decisions.
   */
  private formatResultsForEvaluation(
    memos: EnrichedMemoResult[],
    messages: EnrichedMessageResult[],
    attachments: EnrichedAttachmentResult[]
  ): string {
    const parts: string[] = []

    if (memos.length > 0) {
      parts.push("### Memos Found")
      for (const { memo } of memos) {
        parts.push(`- ${memo.title}: ${truncateSnippet(memo.abstract)}`)
      }
    }

    if (messages.length > 0) {
      parts.push("### Messages Found")
      for (const msg of messages) {
        parts.push(`- ${msg.authorName} in ${msg.streamName}: "${truncateSnippet(msg.content)}"`)
      }
    }

    if (attachments.length > 0) {
      parts.push("### Attachments Found")
      for (const att of attachments) {
        const summary = att.summary ? `: ${truncateSnippet(att.summary)}` : ""
        parts.push(`- ${att.filename} (${att.contentType ?? att.mimeType})${summary}`)
      }
    }

    return parts.join("\n\n")
  }

  /**
   * Empty result when no queries could be generated. Preserves any substeps already
   * recorded so the trace shows why the run ended empty.
   */
  private emptyResult(substeps: WorkspaceAgentSubstep[] = []): WorkspaceAgentResult {
    return {
      retrievedContext: null,
      sources: [],
      memos: [],
      messages: [],
      attachments: [],
      substeps,
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Module-level helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Tagged outcome of a single refinement iteration. The iteration body returns
 * one of these so the surrounding `withResearcherSpan` can record output
 * before the outer loop short-circuits on partial/stop.
 */
type RefineIterationOutcome =
  | { kind: "partial"; reason: WorkspaceAgentPartialReason; summary: Record<string, unknown> }
  | { kind: "stop"; summary: Record<string, unknown> }
  | { kind: "continue"; summary: Record<string, unknown> }

/**
 * Compact summary of an `executeQueries` result for the Langfuse span output.
 * Includes counts plus a small preview of titles/snippets/filenames so the
 * trace shows what each phase actually returned, without bloating the export.
 */
function summarizeQueryBatch(r: {
  memos: EnrichedMemoResult[]
  messages: EnrichedMessageResult[]
  attachments: EnrichedAttachmentResult[]
}): Record<string, unknown> {
  return {
    memoCount: r.memos.length,
    messageCount: r.messages.length,
    attachmentCount: r.attachments.length,
    memos: r.memos.slice(0, 5).map((m) => ({ id: m.memo.id, title: m.memo.title })),
    messages: r.messages.slice(0, 5).map((m) => ({
      id: m.id,
      author: m.authorName,
      stream: m.streamName,
      snippet: truncateSnippet(m.content, 120),
    })),
    attachments: r.attachments.slice(0, 5).map((a) => ({ id: a.id, filename: a.filename })),
  }
}

/**
 * Per-query span output: count + small preview keyed by the query's target.
 * Mirrors the discriminated shape returned by the per-query branch in
 * `executeQueries` so the Langfuse span shows the actual hits.
 */
function describeQueryResult(
  result:
    | { type: "memos"; memos: EnrichedMemoResult[] }
    | { type: "messages"; messages: EnrichedMessageResult[] }
    | { type: "attachments"; attachments: EnrichedAttachmentResult[] }
): Record<string, unknown> {
  if (result.type === "memos") {
    return {
      count: result.memos.length,
      results: result.memos.slice(0, 5).map((r) => ({
        id: r.memo.id,
        title: r.memo.title,
        snippet: truncateSnippet(r.memo.abstract, 120),
      })),
    }
  }
  if (result.type === "messages") {
    return {
      count: result.messages.length,
      results: result.messages.slice(0, 5).map((m) => ({
        id: m.id,
        author: m.authorName,
        stream: m.streamName,
        snippet: truncateSnippet(m.content, 120),
      })),
    }
  }
  return {
    count: result.attachments.length,
    results: result.attachments.slice(0, 5).map((a) => ({
      id: a.id,
      filename: a.filename,
      contentType: a.contentType,
    })),
  }
}

/** Normalized key for query-level deduplication across baseline + planner sets. */
function queryKey(q: SearchQuery): string {
  return `${q.target}|${q.type}|${q.query.toLowerCase().trim()}`
}

/** Deduplicate queries by (target, type, normalized query). Stable order. */
function dedupeQueries(queries: SearchQuery[]): SearchQuery[] {
  const seen = new Set<string>()
  const out: SearchQuery[] = []
  for (const q of queries) {
    const k = queryKey(q)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(q)
  }
  return out
}

/** Truncate a snippet to ~80 chars with ellipsis for compact evaluator prompt. */
function truncateSnippet(text: string, max = 80): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 1)}…`
}
