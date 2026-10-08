import type { Pool } from "pg"
import { z } from "zod"
import { withClient, type Querier } from "../../../db"
import { AISpendDeniedError, composeAbortSignal, isAbortError, type AI } from "@threahq/agent-runtime"
import type { ConfigResolver, ResearcherConfig } from "../../../lib/ai/config-resolver"
import { COMPONENT_PATHS } from "../../../lib/ai/config-resolver"
import { StreamTypes, type AuthoredByKind, type FeatureFlagValue, type TraceSource } from "@threahq/types"
import type { EmbeddingServiceLike, MemoAudience } from "../../memos"
import { MessageRepository, type Message } from "../../messaging"
import { MemoRepository, classifyMemoQueryIntent } from "../../memos"
import { SearchRepository } from "../../search"
import { StreamRepository, type Stream } from "../../streams"
import { AttachmentRepository } from "../../attachments"
import { PeoplePurposes, UserRepository } from "../../workspaces"
import type { PeopleResolverLike, PersonResolution } from "./people-resolver"
import {
  computeAgentAccessSpec,
  memoAudienceForSpec,
  resolveMemoViewer,
  resolvePeopleViewer,
  type AgentAccessSpec,
} from "./access-spec"
import {
  formatPeopleSection,
  formatRetrievedContext,
  enrichMessageSearchResults,
  type EnrichedMemoResult,
  type EnrichedMessageResult,
  type EnrichedAttachmentResult,
  type RawMessageSearchResult,
} from "./context-formatter"
import {
  resolveQuoteReplies,
  renderMessageWithQuoteContext,
  extractAppendedQuoteContext,
  DEFAULT_MAX_QUOTE_DEPTH,
} from "../quote-resolver"
import { logger } from "../../../lib/logger"
import { workspaceHomeUrl, workspaceMemoUrl, workspaceMessageUrl, workspaceStreamUrl } from "../workspace-links"
import { hybridWeightsForQuery, searchRankingForFlag, type SearchRanking } from "../../search"
import {
  PEOPLE_MAX_AUTHOR_SEARCHES,
  PEOPLE_MAX_REFERENCES,
  PEOPLE_ROSTER_LIMIT,
  WORKSPACE_AGENT_MAX_PLANNED_QUERIES,
  WORKSPACE_AGENT_MAX_RESULTS_PER_SEARCH,
  WORKSPACE_AGENT_MAX_ROOM_RESULTS_PER_SEARCH,
  WORKSPACE_AGENT_PLANNER_TIMEOUT_MS,
  WORKSPACE_AGENT_SYSTEM_PROMPT,
} from "./config"
import { buildBaselineQueries } from "./query/baseline-queries"

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
  /** Memo sources: who authored the cited memo (agent-captured knowledge is flagged in citations). */
  authoredByKind?: AuthoredByKind
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
  /** The invoking user's resolved `search` flag; "off" keeps the pre-rework message ranking. */
  searchFlag: FeatureFlagValue<"search">
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
  /** The asker's IANA timezone, the clock retrieved times are shown on. */
  timezone?: string
}

/**
 * Dependencies for the WorkspaceAgent.
 */
export interface WorkspaceAgentDeps {
  pool: Pool
  ai: AI
  configResolver: ConfigResolver
  embeddingService: EmbeddingServiceLike
  peopleResolver: PeopleResolverLike
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
  people: z.array(z.string()),
})

/** `authorId` narrows a message search to what one person wrote; the planner never sets it. */
type SearchQuery = z.infer<typeof retrievalPlanSchema>["queries"][number] & { authorId?: string }

interface PersonName {
  name: string
  slug: string
}

interface MemoReaders {
  viewerUserId: string | undefined
  audiences: readonly MemoAudience[]
}

/** The room a question is asked in: its root stream, and for an aside also the room of the stream it was opened over. */
async function roomRootIds(db: Querier, stream: Stream): Promise<string[]> {
  const root = stream.rootStreamId
    ? await StreamRepository.findById(db, stream.workspaceId, stream.rootStreamId)
    : stream
  if (!root || root.type !== StreamTypes.ASIDE || !root.parentStreamId) return [stream.rootStreamId ?? stream.id]
  const host = await StreamRepository.findById(db, stream.workspaceId, root.parentStreamId)
  return host ? [root.id, host.rootStreamId ?? host.id] : [root.id]
}

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

function messageAsSearchResult(message: Message): RawMessageSearchResult {
  return {
    id: message.id,
    streamId: message.streamId,
    content: message.contentMarkdown,
    authorId: message.authorId,
    authorType: message.authorType,
    createdAt: message.createdAt,
  }
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
 * one broad planned search pass alongside a deterministic baseline.
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

    const earlyExit = this.checkAbortOrDeadline(input)
    if (earlyExit) {
      return this.buildPartialResult([], [], [], workspaceId, input.timezone, substeps, earlyExit)
    }

    // Phase 1: Fetch all setup data with withClient (no transaction, fast reads ~100-200ms)
    const fetchedData = await withClient(pool, async (client) => {
      const stream = await StreamRepository.findById(client, workspaceId, streamId)
      if (!stream) {
        return { stream: null, accessSpec: null, accessibleStreamIds: null, roomStreamIds: [], names: new Map() }
      }

      const accessSpec = await computeAgentAccessSpec(client, {
        stream,
        invokingUserId,
      })

      const accessibleStreamIds = await SearchRepository.getAccessibleStreamsForAgent(client, accessSpec, workspaceId)

      const accessible = new Set(accessibleStreamIds)
      const roomStreamIds = (
        await SearchRepository.expandStreamIdsWithThreads(client, workspaceId, await roomRootIds(client, stream))
      ).filter((id) => accessible.has(id))

      const authorIds = new Set([invokingUserId, ...input.conversationHistory.map((message) => message.authorId)])
      const names = new Map<string, PersonName>(
        (await UserRepository.findByIds(client, workspaceId, [...authorIds])).map((user) => [
          user.id,
          { name: user.name, slug: user.slug },
        ])
      )

      return { stream, accessSpec, accessibleStreamIds, roomStreamIds, names }
    })

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
    return this.runSearchLoop(
      pool,
      input,
      fetchedData.accessSpec,
      fetchedData.accessibleStreamIds,
      fetchedData.roomStreamIds,
      fetchedData.names,
      substeps
    )
  }

  /**
   * Search loop: a deterministic baseline search runs in parallel with one planner call, then the planner's
   * extra queries run once. Bounded by `input.deadlineAt` and per-call abort signals.
   *
   * Uses pool.query for individual DB operations instead of holding a connection
   * through the entire loop (which includes AI calls).
   */
  private async runSearchLoop(
    pool: Pool,
    input: WorkspaceAgentInput,
    accessSpec: AgentAccessSpec,
    accessibleStreamIds: string[],
    roomStreamIds: string[],
    names: Map<string, PersonName>,
    substeps: WorkspaceAgentSubstep[]
  ): Promise<WorkspaceAgentResult> {
    const { configResolver, embeddingService } = this.deps
    const { workspaceId, query, conversationHistory } = input
    const ranking = searchRankingForFlag(input.searchFlag)

    // User-scoped memos (roadmap 6.4) are private to one owner, and the
    // researcher's reply + broadcast trace sources reach every participant of the
    // invocation stream — so a private memo may only be retrieved when the audience
    // is exactly that owner. `resolveMemoViewer` is the single authority for that
    // gate (undefined ⇒ user-scoped memos excluded); `audiences` gates agent memos
    // by whether the audience can read the streams they were written from.
    const memoReaders: MemoReaders = {
      viewerUserId: resolveMemoViewer(accessSpec),
      audiences: [memoAudienceForSpec(accessSpec)],
    }

    // Resolve config for workspace agent
    const config = (await configResolver.resolve(COMPONENT_PATHS.COMPANION_RESEARCHER)) as ResearcherConfig

    const conversation = conversationLines(conversationHistory, names)
    const asker = names.get(input.invokingUserId)
    const contextSummary = buildContextSummary(conversation, asker)
    // Already in the main agent's prompt; retrieving them again only crowds out new context.
    const excludedMessageIds = new Set(conversationHistory.map((message) => message.id))

    let allMemos: EnrichedMemoResult[] = []
    let allMessages: EnrichedMessageResult[] = []
    let allAttachments: EnrichedAttachmentResult[] = []

    // ── Parallel speculative baseline search + planner LLM ──
    //
    // The baseline queries are deterministic — they don't need an LLM. We fire
    // their executeQueries call in parallel with the planner LLM so the slowest
    // path (planner: ~1-3s) overlaps with the DB search (~500ms-1s). On the
    // common case where the planner's queries are mostly covered by baseline,
    // we need ~zero extra DB work after planning.

    this.emitSubstep(substeps, "Planning queries…", input.onSubstep)

    const preExec = this.checkAbortOrDeadline(input)
    if (preExec) {
      return this.buildPartialResult(
        allMemos,
        allMessages,
        allAttachments,
        workspaceId,
        input.timezone,
        substeps,
        preExec
      )
    }

    const baselineQueries = buildBaselineQueries(query)

    // Fire both in parallel.
    const baselinePromise =
      baselineQueries.length > 0
        ? this.executeQueries(
            pool,
            baselineQueries,
            workspaceId,
            accessibleStreamIds,
            roomStreamIds,
            embeddingService,
            memoReaders,
            true,
            excludedMessageIds,
            ranking
          )
        : Promise.resolve({ memos: [], messages: [], attachments: [] })

    const planPromise = this.planRetrieval({
      contextSummary,
      config,
      workspaceId,
      query,
      signal: input.signal,
      deadlineAt: input.deadlineAt,
    })

    const [baselineResults, plan] = await Promise.all([baselinePromise, planPromise])

    // Merge baseline results immediately so they're preserved even if abort fires
    // before the planner-only search runs.
    allMemos = mergeMemoResults(allMemos, baselineResults.memos)
    allMessages = mergeMessageResults(allMessages, baselineResults.messages)
    allAttachments = mergeAttachmentResults(allAttachments, baselineResults.attachments)
    const baselineKeys = new Set(baselineQueries.map(queryKey))

    // Abort may have fired during planner/baseline
    const postPlan = this.checkAbortOrDeadline(input)
    if (postPlan) {
      return this.buildPartialResult(
        allMemos,
        allMessages,
        allAttachments,
        workspaceId,
        input.timezone,
        substeps,
        postPlan
      )
    }

    // Compute planner-only queries: any planner queries not already in the baseline set.
    const plannerOnlyDeduped = dedupeQueries(plan.queries.filter((q) => !baselineKeys.has(queryKey(q)))).slice(
      0,
      WORKSPACE_AGENT_MAX_PLANNED_QUERIES
    )

    if (baselineQueries.length === 0 && plan.queries.length === 0 && plan.people.length === 0) {
      logger.debug({ query, reasoning: plan.reasoning }, "Workspace agent could not generate any queries")
      return this.emptyResult(substeps)
    }

    if (plannerOnlyDeduped.length > 0) {
      this.emitSubstep(
        substeps,
        `Searching with ${plannerOnlyDeduped.length} planned ${plannerOnlyDeduped.length === 1 ? "query" : "queries"}…`,
        input.onSubstep
      )
    }
    const references = [...new Set(plan.people)].slice(0, PEOPLE_MAX_REFERENCES)
    if (references.length > 0) {
      this.emitSubstep(substeps, `Identifying ${references.join(", ")}…`, input.onSubstep)
    }

    const searchFor = (queries: SearchQuery[]) =>
      this.executeQueries(
        pool,
        queries,
        workspaceId,
        accessibleStreamIds,
        roomStreamIds,
        embeddingService,
        memoReaders,
        true,
        excludedMessageIds,
        ranking
      )
    // Who the query names is resolved while the planner's queries run; each person found then gets a search of
    // what they wrote.
    const [plannerResults, { people, authorResults }] = await Promise.all([
      searchFor(plannerOnlyDeduped),
      this.resolvePeople(pool, input, accessSpec, references, asker, conversation, roomStreamIds).then(
        async (people) => ({
          people,
          authorResults: await searchFor(authorQueries(query, people)),
        })
      ),
    ])
    for (const results of [plannerResults, authorResults]) {
      allMemos = mergeMemoResults(allMemos, results.memos)
      allMessages = mergeMessageResults(allMessages, results.messages)
      allAttachments = mergeAttachmentResults(allAttachments, results.attachments)
    }

    const postSearch = this.checkAbortOrDeadline(input)
    if (postSearch) {
      return this.buildPartialResult(
        allMemos,
        allMessages,
        allAttachments,
        workspaceId,
        input.timezone,
        substeps,
        postSearch,
        people
      )
    }

    logger.info(
      {
        query,
        memoCount: allMemos.length,
        messageCount: allMessages.length,
        attachmentCount: allAttachments.length,
        accessSpecType: accessSpec.type,
        people: people.map((person) => person.status),
      },
      "Workspace agent completed"
    )

    return this.buildFinalResult(
      allMemos,
      allMessages,
      allAttachments,
      workspaceId,
      input.timezone,
      substeps,
      false,
      people
    )
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
   * (this exact bug was caught in review — see PR #333).
   */
  private makePerCallSignal(
    params: { signal: AbortSignal | undefined; deadlineAt: number | undefined },
    perCallMs: number
  ): { signal: AbortSignal; cleanup: () => void } {
    const { signal: parentSignal, deadlineAt } = params
    const remainingBudget = deadlineAt !== undefined ? Math.max(0, deadlineAt - Date.now()) : Infinity
    // Clamp the per-call cap to the remaining total budget so a late call can't
    // outlive the deadline (this exact bug was caught in review — see PR #333).
    return composeAbortSignal({
      parent: parentSignal,
      timeoutMs: Math.min(perCallMs, remainingBudget),
      timeoutReason: "per-call timeout",
    })
  }

  /**
   * Build the final, complete (non-partial) result.
   */
  private buildFinalResult(
    memos: EnrichedMemoResult[],
    messages: EnrichedMessageResult[],
    attachments: EnrichedAttachmentResult[],
    workspaceId: string,
    timezone: string | undefined,
    substeps: WorkspaceAgentSubstep[],
    partial: boolean,
    people: PersonResolution[]
  ): WorkspaceAgentResult {
    const sources = this.buildSources(memos, messages, attachments, workspaceId)
    const retrievedContext = joinContext(
      formatRetrievedContext(memos, messages, attachments, workspaceId, timezone),
      people
    )
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
    timezone: string | undefined,
    substeps: WorkspaceAgentSubstep[],
    reason: WorkspaceAgentPartialReason,
    people: PersonResolution[] = []
  ): WorkspaceAgentResult {
    const stopText =
      reason === "user_abort"
        ? "Stopped on user request. Returning partial results…"
        : "Deadline reached. Returning partial results…"
    // Don't double-call onSubstep here — the caller already saw the abort path.
    substeps.push({ text: stopText, at: new Date().toISOString() })

    const sources = this.buildSources(memos, messages, attachments, workspaceId)
    const retrievedContext = joinContext(
      formatRetrievedContext(memos, messages, attachments, workspaceId, timezone),
      people
    )

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
            content: `Plan the searches for this query.

## Query
${query}

${contextSummary}

Respond with:
- reasoning: the directions you chose and why
- queries: the search queries, each with target, type, and query text
- people: every person the answer depends on, as the query or the conversation refers to them ("Kate", "my manager", "me", "she"). Include the asker when they refer to themselves. Leave out the assistant. Empty when the query is about no one in particular.`,
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
        return { reasoning: "Aborted", queries: [], people: [] }
      }
      logger.warn({ error }, "Workspace agent retrieval planning failed, falling back to baseline")
      return { reasoning: "Planning failed", queries: [], people: [] }
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
    roomStreamIds: string[],
    embeddingService: EmbeddingServiceLike,
    memoReaders: MemoReaders,
    includeSurroundingContext: boolean,
    excludedMessageIds: Set<string>,
    ranking: SearchRanking
  ): Promise<{
    memos: EnrichedMemoResult[]
    messages: EnrichedMessageResult[]
    attachments: EnrichedAttachmentResult[]
  }> {
    // Execute all queries in parallel.
    const results = await Promise.all(
      queries.map(async (query) => {
        if (query.target === "memos") {
          const memoResults = await this.searchMemos(
            pool,
            query,
            workspaceId,
            accessibleStreamIds,
            memoReaders,
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
            roomStreamIds,
            includeSurroundingContext,
            excludedMessageIds,
            ranking
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
      })
    )

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
    memoReaders: MemoReaders,
    embeddingService: EmbeddingServiceLike
  ): Promise<EnrichedMemoResult[]> {
    // Gates user-scoped memos (roadmap 6.4): `viewerUserId` is set only when the invocation
    // audience is exactly the invoking user (a private scratchpad), so a private-tier memo
    // is never retrieved into — and thus cited/broadcast to — a shared room.
    // Undefined ⇒ user-scoped memos excluded (fail closed).
    const filterBase = { streamIds: accessibleStreamIds, ...memoReaders }
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
          filters: filterBase,
          limit: WORKSPACE_AGENT_MAX_RESULTS_PER_SEARCH,
          keywordWeight: intent.keywordWeight,
          semanticWeight: intent.semanticWeight,
          applyStructuralBoost: intent.intent !== "temporal",
        })
        const results =
          hybridResults.length > 0
            ? hybridResults
            : await MemoRepository.fullTextSearch(pool, {
                workspaceId,
                query: query.query,
                filters: filterBase,
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
            filters: filterBase,
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
        filters: filterBase,
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
    roomStreamIds: string[],
    includeSurroundingContext: boolean,
    excludedMessageIds: Set<string>,
    ranking: SearchRanking
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
        const filters = query.authorId ? { authorId: query.authorId } : {}
        const normalizedQuery = searchQuery.trim()
        const hasQuery = normalizedQuery.length > 0
        const hasEmbedding = embedding.length > 0
        // Skipped ids are dropped after ranking, so the fetch widens by their count to still fill `limit`.
        const search = async (streamIds: string[], limit: number, skip: Set<string>) => {
          const params = { workspaceId, query: normalizedQuery, streamIds, filters, limit: limit + skip.size, ranking }
          const primary =
            hasQuery && hasEmbedding
              ? await SearchRepository.hybridSearch(client, {
                  ...params,
                  embedding,
                  ...hybridWeightsForQuery(normalizedQuery, ranking),
                })
              : await SearchRepository.fullTextSearch(client, params)
          const results =
            hasQuery && hasEmbedding && primary.length === 0
              ? await SearchRepository.fullTextSearch(client, params)
              : primary
          return results.filter((result) => !skip.has(result.id)).slice(0, limit)
        }

        const workspaceResults = await search(
          accessibleStreamIds,
          WORKSPACE_AGENT_MAX_RESULTS_PER_SEARCH,
          excludedMessageIds
        )
        // Ranking always fills its limit, so the room leg is capped below the workspace leg: an irrelevant room
        // still contributes only a few hits.
        const roomResults =
          roomStreamIds.length > 0
            ? await search(
                roomStreamIds,
                WORKSPACE_AGENT_MAX_ROOM_RESULTS_PER_SEARCH,
                new Set([...excludedMessageIds, ...workspaceResults.map((result) => result.id)])
              )
            : []

        const filteredSearchResults = [...workspaceResults, ...roomResults]
        const rawResults: RawMessageSearchResult[] = [...filteredSearchResults]
        if (includeSurroundingContext && filteredSearchResults.length > 0) {
          const surroundingBatches = await Promise.all(
            filteredSearchResults
              .slice(0, 3)
              .map((result) => MessageRepository.findSurrounding(client, workspaceId, result.id, result.streamId, 1, 1))
          )
          rawResults.push(...surroundingBatches.flat().map(messageAsSearchResult))

          // A reply read without the post that opened its thread loses what it is replying to.
          const hitStreams = await StreamRepository.findByIds(client, workspaceId, [
            ...new Set(filteredSearchResults.map((result) => result.streamId)),
          ])
          const rootMessageIds = hitStreams.flatMap((stream) =>
            stream.type === StreamTypes.THREAD && stream.parentAnchorId ? [stream.parentAnchorId] : []
          )
          if (rootMessageIds.length > 0) {
            const roots = await MessageRepository.findByIdsInStreams(
              client,
              workspaceId,
              rootMessageIds,
              accessibleStreamIds
            )
            rawResults.push(...[...roots.values()].map(messageAsSearchResult))
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

        const enriched = await enrichMessageSearchResults(client, workspaceId, [...dedupedResultsById.values()])
        const room = new Set(roomStreamIds)
        for (const e of enriched) {
          if (room.has(e.streamId)) e.inCurrentRoom = true
        }

        // Resolve quote-reply precursors for each retrieved message so Ariadne
        // sees the full source of anything that was quoted, not just the
        // snippet. Requires a batch fetch because `EnrichedMessageResult` does
        // not carry `contentJson`.
        if (enriched.length > 0) {
          const seedMessageMap = await MessageRepository.findByIdsInStreams(
            client,
            workspaceId,
            enriched.map((e) => e.id),
            accessibleStreamIds
          )
          if (seedMessageMap.size > 0) {
            const { resolved, authorNames, pinnedVersions } = await resolveQuoteReplies(client, workspaceId, {
              seedMessages: [...seedMessageMap.values()],
              accessibleStreamIds: new Set(accessibleStreamIds),
            })
            if (resolved.size > 0) {
              const quoteStreamIds = [...new Set([...resolved.values()].map((m) => m.streamId))]
              for (const e of enriched) {
                const seed = seedMessageMap.get(e.id)
                if (!seed) continue
                const rendered = renderMessageWithQuoteContext(
                  seed,
                  resolved,
                  authorNames,
                  0,
                  DEFAULT_MAX_QUOTE_DEPTH,
                  pinnedVersions
                )
                const appended = extractAppendedQuoteContext(rendered, seed.contentMarkdown)
                if (appended.length > 0) {
                  e.quoteContext = appended
                  e.quoteStreamIds = quoteStreamIds
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
        url: workspaceMemoUrl(workspaceId, memo.id),
        snippet: memo.abstract.slice(0, 200),
        memoId: memo.id,
        streamId: sourceStream?.id,
        streamName: sourceStream?.name ?? sourceStream?.type,
        authoredByKind: memo.authoredByKind,
      })
    }

    for (const msg of messages) {
      sources.push({
        type: "workspace",
        traceType: "workspace_message",
        title: `${msg.authorName} in ${msg.streamName}`,
        url: workspaceMessageUrl(workspaceId, msg.streamId, msg.id),
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
        url: att.streamId ? workspaceStreamUrl(workspaceId, att.streamId) : workspaceHomeUrl(workspaceId),
        snippet: att.summary?.slice(0, 200),
        streamId: att.streamId ?? undefined,
      })
    }

    return sources
  }

  /** The workspace users `references` name, nearest to the asker first, each left unresolved when the resolver could not answer. */
  private async resolvePeople(
    pool: Pool,
    input: WorkspaceAgentInput,
    accessSpec: AgentAccessSpec,
    references: string[],
    asker: PersonName | undefined,
    conversation: { author: string; text: string }[],
    roomStreamIds: string[]
  ): Promise<PersonResolution[]> {
    if (!asker || references.length === 0) return []
    const { workspaceId, invokingUserId } = input
    const unresolved = (): PersonResolution[] => references.map((reference) => ({ reference, status: "unresolved" }))
    try {
      const roster = await UserRepository.listByCircle(pool, workspaceId, {
        askerId: invokingUserId,
        roomStreamIds,
        scope: { viewer: resolvePeopleViewer(accessSpec, input.streamId), purpose: PeoplePurposes.VISIBLE },
        limit: PEOPLE_ROSTER_LIMIT,
      })
      if (roster.length === PEOPLE_ROSTER_LIMIT) {
        logger.info({ workspaceId, references }, "Workspace agent people roster truncated; farthest people left out")
      }
      const resolutions = await this.deps.peopleResolver.resolve({
        workspaceId,
        userId: invokingUserId,
        asker: { id: invokingUserId, ...asker },
        conversation,
        query: input.query,
        references,
        roster,
        signal: input.signal,
      })
      if (!resolutions) {
        logger.info({ workspaceId, references }, "People resolver unavailable; references left unresolved")
        return unresolved()
      }
      return resolutions
    } catch (error) {
      if (error instanceof AISpendDeniedError) throw error
      if (isAbortError(error)) return []
      logger.warn({ error, workspaceId }, "Workspace agent people resolution failed")
      return unresolved()
    }
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

/** Normalized key for query-level deduplication across baseline + planner sets. */
function queryKey(q: SearchQuery): string {
  return `${q.target}|${q.type}|${q.query.toLowerCase().trim()}|${q.authorId ?? ""}`
}

/** The last few messages, each under its author's name when the author is a workspace user. */
function conversationLines(
  conversationHistory: Message[],
  names: Map<string, PersonName>
): { author: string; text: string }[] {
  return conversationHistory.slice(-5).map((message) => ({
    author: names.get(message.authorId)?.name ?? message.authorType,
    text: message.contentMarkdown,
  }))
}

function buildContextSummary(conversation: { author: string; text: string }[], asker: PersonName | undefined): string {
  const historyText = conversation.map((line) => `${line.author}: ${line.text}`).join("\n")
  const askedBy = asker ? `## Asked by\n${asker.name} (@${asker.slug})\n\n` : ""
  return `${askedBy}## Recent Conversation
${historyText || "No recent messages."}`
}

function authorQueries(query: string, people: PersonResolution[]): SearchQuery[] {
  const authorIds = [
    ...new Set(people.flatMap((resolution) => (resolution.status === "resolved" ? [resolution.person.id] : []))),
  ]
  return authorIds
    .slice(0, PEOPLE_MAX_AUTHOR_SEARCHES)
    .map((authorId) => ({ target: "messages", type: "semantic", query, authorId }))
}

function joinContext(retrieved: string | null, people: PersonResolution[]): string | null {
  const sections = [retrieved, formatPeopleSection(people)].filter((section) => section !== null)
  return sections.length > 0 ? sections.join("\n\n") : null
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
