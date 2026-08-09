import type { Pool } from "pg"
import { z } from "zod"
import { withClient, withTransaction, type Querier } from "../../db"
import {
  AgentStepTypes,
  AuthorTypes,
  ConversationIntents,
  StreamTypes,
  type AgentSessionRerunContext,
  type AgentToolEffect,
  type AuthorType,
  type ConversationDirective,
  type SourceItem,
} from "@threa/types"
import type { UserPreferencesService } from "../user-preferences"
import type { WorkspaceIntegrationService } from "../workspace-integrations"
import { assertStreamWritable, StreamPoliciesRepository, StreamRepository, resolveBriefStreamId } from "../streams"
import { MessageRepository, MessageVersionRepository } from "../messaging"
import { UserRepository } from "../workspaces"
import { resolveEligibleConversation } from "./companion/conversation-highlight"
import { PersonaRepository, resolveDraftTestPersona, type Persona } from "./persona-repository"
import { PersonaConfigDraftRepository } from "./persona-config-draft-repository"
import { AgentSessionRepository, SessionStatuses, type AgentSession } from "./session-repository"
import { StreamEventRepository } from "../streams"
import { AttachmentRepository } from "../attachments"
import { awaitAttachmentProcessing } from "../attachments"
import type { TraceEmitter } from "./trace-emitter"
import type { SessionAbortRegistry } from "./session-abort-registry"
import type { AI, CostContext } from "@threa/agent-runtime"
import type { SearchService } from "../search"
import type { ConversationSummaryService } from "./conversation-summary-service"
import type { AttachmentService } from "../attachments"
import type { MemoExplorerService } from "../memos"
import type { StorageProvider } from "../../lib/storage/s3-client"
import type { ModelRegistry } from "@threa/agent-runtime"
import { WorkspaceAgent, type WorkspaceAgentResult } from "./researcher"
import { GeneralResearcher, GENERAL_RESEARCH_TOOL_POLICY, type GeneralResearchResult } from "./general-researcher"
import { logger } from "../../lib/logger"
import { buildAgentContext, buildToolSet, withCompanionSession, type WithSessionResult } from "./companion"
import { deriveTurnFlags, type TurnPurpose } from "./turn-purpose"
import { resolveTurnModel } from "./turn-model"
import { resolveContextWindowPolicy } from "./context-window-policy"
import { resolveBagForStream, persistSnapshot, appendBagToSystemPrompt, type ResolvedBag } from "./context-bag"
import {
  canOfferUserSettings,
  createMemoizedGithubClient,
  createMemoizedLinearClient,
  type RunGeneralResearchOptions,
} from "./tools"
import { createSessionTraceProjector, type AgentRuntimeConfig, type NewMessageInfo } from "./runtime"
import { ToolGuardianService } from "./guardian/service"
import type { ConfigResolver } from "../../lib/ai/config-resolver"
import {
  InProcessTurnDriver,
  TurnDeliveries,
  TurnDigestCollector,
  generateTurnDigest,
  negotiateCapabilities,
  type TurnRequest,
  type TurnSink,
} from "@threa/agent-runtime"
import type { SessionTrace } from "./trace-emitter"
import {
  SUPERSEDE_RESPONSE_VALIDATOR_MAX_TOKENS,
  SUPERSEDE_RESPONSE_VALIDATOR_MODEL_ID,
  SUPERSEDE_RESPONSE_VALIDATOR_TEMPERATURE,
  TURN_DIGEST_MODEL_ID,
} from "./config"

export type { WithSessionResult }

/**
 * What the stub companion claims to have written (`USE_STUB_COMPANION=true`,
 * browser suite only). Deliberately mixed: two settings rows with a diff, one
 * labelled delegation that resolves to a route, and one follow-up that resolves
 * to none — enough for a real browser to check column count, truncation and
 * the inert-vs-link split.
 */
const STUB_EFFECTS: AgentToolEffect[] = [
  { kind: "settings", target: "theme", before: "light", after: "dark" },
  { kind: "settings", target: "timezone", before: "Europe/Stockholm", after: "Europe/Copenhagen" },
  { kind: "delegation", label: "Plan out how to set up and use Threa", target: "dlg_stub" },
  { kind: "follow_up", label: "Check in on how things are going", target: "fu_stub" },
  // A memo opens a dialog rather than navigating, so the browser suite needs one
  // to check that the overlay actually lands on top of the stream.
  { kind: "memo", label: "User test run: settings, delegation, follow-up", target: "memo_stub" },
]

const STUB_EFFECTS_CONTENT = "update_user_settings, delegate_task, schedule_follow_up, save_memo"

export interface PersonaAgentDeps {
  pool: Pool
  ai: AI
  traceEmitter: TraceEmitter
  /**
   * Registry of per-session AbortControllers for cooperative, graceful tool cancellation.
   * Used by long-running tools (e.g. workspace_research) via AgentRuntime.toolSignalProvider
   * and by the socket handler for `agent_session:research:abort`.
   */
  sessionAbortRegistry: SessionAbortRegistry
  userPreferencesService: UserPreferencesService
  /** Resolves per-component AI config (model, temperature, prompt) — used by the tool guardian. */
  configResolver: ConfigResolver
  workspaceAgent: WorkspaceAgent
  generalResearcher: GeneralResearcher
  searchService: SearchService
  conversationSummaryService: ConversationSummaryService
  attachmentService: AttachmentService
  memoExplorerService: MemoExplorerService
  storage: StorageProvider
  modelRegistry: ModelRegistry
  workspaceIntegrationService?: WorkspaceIntegrationService
  assertInitiatorWritable?: typeof assertStreamWritable
  tavilyApiKey?: string
  stubResponse?: string
  createMessage: (params: {
    initiatingUserId: string
    workspaceId: string
    streamId: string
    authorId: string
    authorType: AuthorType
    content: string
    sources?: SourceItem[]
    sessionId?: string
    /**
     * Pre-computed access scope (from `AgentAccessSpec`) used to authorize
     * inline attachment references and cross-stream share/quote pointers.
     * Persona-authored messages must set this — personas have no
     * `stream_members` rows so the membership-keyed gate always denies.
     * The scope is invocation-bounded (a public channel agent only sees
     * public streams, etc.); passing the user's full access here would be
     * a privilege escalation.
     */
    accessibleStreamIds?: string[]
    /**
     * Declared conversation for this reply (roadmap 3.3): an agent reply joins
     * the conversation it's participating in, resolved from the trigger's own
     * topic. Omit to let boundary extraction infer (today's most-recently-active
     * fallback). Only `existing` is used here — the anchor is an extant topic.
     */
    conversation?: ConversationDirective
  }) => Promise<{ id: string }>
  editMessage: (params: {
    initiatingUserId: string
    workspaceId: string
    streamId: string
    messageId: string
    actorId: string
    content: string
    /** Same semantics as `createMessage.accessibleStreamIds`. */
    accessibleStreamIds?: string[]
  }) => Promise<{ id: string } | null>
  deleteMessage: (params: {
    initiatingUserId: string
    workspaceId: string
    streamId: string
    messageId: string
    actorId: string
  }) => Promise<{ id: string } | null>
  addReaction: (params: {
    initiatingUserId: string
    workspaceId: string
    streamId: string
    messageId: string
    emoji: string
    actorId: string
  }) => Promise<{ id: string } | null>
  removeReaction: (params: {
    initiatingUserId: string
    workspaceId: string
    streamId: string
    messageId: string
    emoji: string
    actorId: string
  }) => Promise<{ id: string } | null>
  createThread: (params: {
    initiatingUserId: string
    workspaceId: string
    parentStreamId: string
    parentAnchorId: string
    createdBy: string
  }) => Promise<{ id: string }>
  /**
   * Schedule a follow-up (durable "check back later" work). Bound to the
   * `AgentFollowUpService` in server.ts; the turn supplies the stream/persona/
   * session identity and the best-effort source-conversation anchor. Absent when
   * follow-ups aren't wired (e.g. some test harnesses), which disables the tool.
   */
  scheduleFollowUp?: (params: {
    initiatingUserId: string
    workspaceId: string
    streamId: string
    personaId: string
    sessionId: string
    sourceConversationId: string | null
    note: string
    scheduledFor: Date
  }) => Promise<import("./tools/tool-deps").ScheduleFollowUpToolResult>
  /**
   * Follow-up admin callbacks (list / cancel / update), bound to the
   * `AgentFollowUpService` in server.ts. The turn supplies `streamId` so each is
   * scoped to the stream it runs in — a persona administers only its own
   * stream's follow-ups. Wired together with `scheduleFollowUp`; all present or
   * all absent (harnesses without follow-ups omit the whole bundle).
   */
  listFollowUps?: (params: {
    workspaceId: string
    streamId: string
  }) => Promise<import("./tools/tool-deps").FollowUpSummary[]>
  cancelFollowUp?: (params: {
    workspaceId: string
    streamId: string
    followUpId: string
  }) => Promise<import("./tools/tool-deps").CancelFollowUpToolResult>
  updateFollowUp?: (params: {
    initiatingUserId: string
    workspaceId: string
    streamId: string
    followUpId: string
    note?: string
    scheduledFor?: Date
  }) => Promise<import("./tools/tool-deps").UpdateFollowUpToolResult>
  /**
   * Load a fired follow-up's context (the note it carries + when it was
   * scheduled) so the turn it wakes can be told why. Bound to
   * `AgentFollowUpService.getById` in server.ts; consulted only when a job
   * carries `followUpId`. Absent in harnesses that don't wire follow-ups, in
   * which case the turn degrades to a plain catch-up.
   */
  loadFollowUp?: (params: {
    workspaceId: string
    followUpId: string
  }) => Promise<{ note: string; scheduledFor: Date } | null>
  /**
   * Write the stream's durable brief (roadmap 4.2), bound to the
   * `StreamBriefService` in server.ts. The turn supplies the effective-root
   * stream, the persona identity, the model's reason, and the version it read at
   * context time. Absent in harnesses that don't wire briefs, which disables the
   * `update_stream_brief` tool.
   */
  updateBrief?: (params: {
    initiatingUserId: string
    workspaceId: string
    streamId: string
    requestedStreamId: string
    personaId: string
    content: string
    reason: string
    expectedVersion: number
  }) => Promise<import("./tools/tool-deps").UpdateStreamBriefToolResult>
  /**
   * Compile a delegation hand-off (roadmap 5.1), bound to the
   * `DelegationService` in server.ts. The turn supplies identity, the
   * source-conversation anchor, and the invoking user's access reach; context
   * refs are validated against that user before the row lands. Absent when
   * delegations aren't wired, which disables the `delegate_task` tool.
   */
  delegateTask?: (params: {
    initiatingUserId: string
    workspaceId: string
    streamId: string
    personaId: string
    sessionId: string
    sourceConversationId: string | null
    invokingUserId: string
    accessibleStreamIds: string[]
    title: string
    brief: string
    contextRefs: string[]
  }) => Promise<import("./tools/tool-deps").DelegateTaskToolResult>
  /**
   * Write an agent-authored memo (roadmap 6.2), bound to `MemoService.saveMemoGenerated`
   * in server.ts. The turn supplies its workspace/stream/session identity; the
   * tool supplies the memo content + source-message anchors. Absent in harnesses
   * that don't wire memos, which disables the `save_memo` tool.
   */
  saveMemo?: (params: {
    initiatingUserId: string
    workspaceId: string
    streamId: string
    sessionId: string | null
    sourceStreamIds: string[]
    title: string
    abstract: string
    keyPoints: string[]
    tags: string[]
    knowledgeType: import("@threa/types").KnowledgeType
    sourceMessageIds: string[]
    invokingUserId?: string | null
    scope?: import("@threa/types").MemoScope
  }) => Promise<import("./tools/tool-deps").SaveMemoToolResult>
}

export interface PersonaAgentInput {
  workspaceId: string
  streamId: string
  messageId: string
  personaId: string
  serverId: string
  /**
   * Why this turn is running (roadmap 1.5). One discriminated union replaces the
   * four orthogonal optional signals that used to accumulate here — mention,
   * supersede rerun, fired follow-up, and plain companion catch-up. A fired
   * follow-up carries a synthetic `messageId` (no real trigger message); the
   * agent loads its row and injects the "why you woke up" prompt section.
   */
  purpose: TurnPurpose
  /** Human principal that authorized this generated turn. */
  initiatingUserId: string
  /** Invocation time override for deterministic evals/tests. Production leaves this unset. */
  currentTime?: Date
  /**
   * Queue retry accounting, forwarded to {@link withCompanionSession} so a
   * failed-but-retryable attempt emits a non-terminal `agent_session:interrupted`
   * instead of a terminal `agent_session:failed`. Absent when the caller isn't the
   * queue worker (evals/tests), in which case a failure is treated as terminal.
   */
  attempt?: number
  maxAttempts?: number
}

export interface PersonaAgentResult {
  sessionId: string | null
  messagesSent: number
  sentMessageIds: string[]
  status: "completed" | "failed" | "skipped"
  skipReason?: string
  lastSeenSequence?: bigint
  retryable?: boolean
  streamId?: string
  personaId?: string
}

interface SupersededMessagePlan {
  messageIds: string[]
  nextIndex: number
  /** The superseded session row — model resolution reads its validation-failure marker (roadmap 2.3). */
  supersededSession: AgentSession
}

export class PersonaAgent {
  /**
   * The plaintext TurnDriver of the turn contract. Long-lived (INV-13): each
   * turn passes its own TurnRequest + TurnSink; the driver runs AgentRuntime
   * in-process.
   */
  private readonly turnDriver: InProcessTurnDriver

  constructor(private readonly deps: PersonaAgentDeps) {
    this.turnDriver = new InProcessTurnDriver({ ai: deps.ai })
  }

  async run(input: PersonaAgentInput): Promise<PersonaAgentResult> {
    const {
      pool,
      ai,
      traceEmitter,
      sessionAbortRegistry,
      userPreferencesService,
      workspaceAgent,
      generalResearcher,
      searchService,
      conversationSummaryService,
      attachmentService,
      memoExplorerService,
      storage,
      modelRegistry,
      workspaceIntegrationService,
      tavilyApiKey,
      stubResponse,
      createMessage,
      editMessage,
      deleteMessage,
      addReaction,
      removeReaction,
      createThread,
      scheduleFollowUp,
      listFollowUps,
      cancelFollowUp,
      updateFollowUp,
      loadFollowUp,
      updateBrief,
      delegateTask,
      saveMemo,
    } = this.deps
    const { workspaceId, streamId, messageId, personaId, serverId, purpose, currentTime, attempt, maxAttempts } = input
    // Supersede-rerun payload, extracted once from the purpose (roadmap 1.5) and
    // threaded through the session setup, reconciliation, trace, and validator.
    const supersedesSessionId = purpose.kind === "supersede_rerun" ? purpose.supersedesSessionId : undefined
    const rerunContext = purpose.kind === "supersede_rerun" ? purpose.rerunContext : undefined

    const precheck = await withClient(pool, async (client) => {
      // Test-drive turns run the editor's unsaved draft, not the saved override
      // (roadmap 7.1). A gone/mismatched draft resolves to null and falls through
      // to normal resolution — a mid-chat commit/discard must never fail the turn.
      let persona: Persona | null = null
      if (purpose.kind === "draft_test") {
        const draft = await PersonaConfigDraftRepository.findById(client, workspaceId, purpose.draftId)
        // The draft applies over the saved persona — built-in defaults or the
        // custom row; `customBase` supplies the row for a custom (ignored for a
        // built-in). A gone/corrupt draft resolves to the saved base.
        const savedBase = await PersonaRepository.findById(client, personaId, workspaceId)
        persona = resolveDraftTestPersona(draft, personaId, workspaceId, savedBase) ?? savedBase
      }
      if (!persona) {
        persona = await PersonaRepository.findById(client, personaId, workspaceId)
      }
      if (!persona || persona.status !== "active") {
        return { skip: true as const, reason: "persona not found or inactive" }
      }

      const stream = await StreamRepository.findById(client, streamId)
      if (!stream) {
        return { skip: true as const, reason: "stream not found" }
      }

      const latestSequence = await StreamEventRepository.getLatestSequence(client, streamId)
      const triggerMessageRevision = await MessageVersionRepository.getCurrentRevision(client, messageId)

      // Per-stream tool-privacy policy. Rows live on the non-thread root —
      // threads inherit their root's policy, mirroring stream access (INV-62).
      // For a channel mention the eager thread created below inherits from the
      // channel (= this streamId) the same way.
      const policyStreamId = stream.type === StreamTypes.THREAD ? (stream.rootStreamId ?? streamId) : streamId
      const streamToolPolicy = await StreamPoliciesRepository.getToolPolicy(client, workspaceId, policyStreamId)

      // The surface a thread actually belongs to. `update_user_settings` is
      // offered on scratchpads and on threads rooted in one, so it needs the
      // ROOT's type, not the thread's — read here, in the transaction that is
      // already resolving the root for the policy, rather than as a second
      // query later.
      const rootStream = policyStreamId === streamId ? stream : await StreamRepository.findById(client, policyStreamId)
      const rootStreamType = rootStream?.type ?? null
      const rootStreamCreatedBy = rootStream?.createdBy ?? null

      return {
        skip: false as const,
        persona,
        stream,
        initialSequence: latestSequence ?? BigInt(0),
        triggerMessageRevision,
        streamToolPolicy,
        rootStreamType,
        rootStreamCreatedBy,
      }
    })

    if (precheck.skip) {
      return {
        sessionId: null,
        messagesSent: 0,
        sentMessageIds: [],
        status: "skipped",
        skipReason: precheck.reason,
      }
    }

    const {
      persona,
      stream,
      initialSequence,
      triggerMessageRevision,
      streamToolPolicy,
      rootStreamType,
      rootStreamCreatedBy,
    } = precheck

    // A fired follow-up has no trigger message (synthetic `messageId`); load its
    // row so the turn can be told it IS the scheduled check-in firing (roadmap
    // 1.2). If the row is gone or no loader is wired the turn degrades to a plain
    // catch-up — the two live staging bugs (declining the check-in, re-scheduling
    // in a loop) stem from exactly that context-less path, so this is the fix.
    let followUpContext: { note: string; scheduledFor: Date } | undefined
    if (purpose.kind === "follow_up") {
      const followUp = loadFollowUp ? await loadFollowUp({ workspaceId, followUpId: purpose.followUpId }) : null
      if (followUp) {
        followUpContext = { note: followUp.note, scheduledFor: followUp.scheduledFor }
      } else {
        logger.warn(
          { workspaceId, followUpId: purpose.followUpId, streamId },
          "Fired follow-up row not found or loader unbound; running as a plain catch-up turn"
        )
      }
    }
    const isFollowUp = followUpContext !== undefined

    const sessionOptions = (targetStreamId: string, targetInitialSequence: bigint) => ({
      pool,
      triggerMessageId: messageId,
      streamId: targetStreamId,
      rootStreamId: stream.rootStreamId ?? stream.id,
      personaId: persona.id,
      personaName: persona.name,
      workspaceId,
      serverId,
      initialSequence: targetInitialSequence,
      triggerMessageRevision,
      supersedesSessionId,
      rerunContext,
      attempt,
      maxAttempts,
    })

    // Create the thread eagerly so successful session events go there for
    // channel mentions. If principal thread creation is denied, run that error
    // through a parent-stream session lifecycle: there is no child stream to
    // own the failure, but the consumed job must still terminalize exactly once.
    const isChannelMention = purpose.kind === "mention" && stream.type === StreamTypes.CHANNEL
    let sessionStreamId = streamId
    let parentStreamId: string | undefined
    let parentMessageId: string | undefined
    let eagerThreadDenialResult: WithSessionResult | null = null
    if (isChannelMention) {
      try {
        const thread = await createThread({
          initiatingUserId: input.initiatingUserId,
          workspaceId,
          parentStreamId: streamId,
          parentAnchorId: messageId,
          createdBy: persona.id,
        })
        sessionStreamId = thread.id
        parentStreamId = streamId
        parentMessageId = messageId
        logger.info({ threadId: thread.id, streamId, messageId }, "Created thread for channel mention (eager)")
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : null
        if (code !== "STREAM_READ_ONLY" && code !== "STREAM_NOT_FOUND") throw error
        eagerThreadDenialResult = await withCompanionSession(sessionOptions(streamId, initialSequence), async () => {
          throw error
        })
      }
    } else if (stream.type === StreamTypes.THREAD && stream.parentStreamId && stream.parentAnchorId) {
      // Session in an existing thread: viewers of the parent timeline watch it
      // through the thread slot on the anchor (message or card), so the inline
      // indicator events must reach the parent stream's room too — the same
      // wiring channel mentions get via their eagerly created thread. The anchor
      // is the coalesced id (`event_` for card threads, `msg_` otherwise).
      parentStreamId = stream.parentStreamId
      parentMessageId = stream.parentAnchorId ?? undefined
    }

    const finalizeSessionResult = (result: WithSessionResult): PersonaAgentResult => {
      // Notify trace rooms about terminal status
      if (
        result.status === "completed" ||
        result.status === "failed" ||
        (result.status === "skipped" && result.sessionId)
      ) {
        const trace = traceEmitter.forSession({
          sessionId: result.sessionId!,
          workspaceId,
          streamId: sessionStreamId,
          triggerMessageId: messageId,
          personaName: persona.name,
          parentStreamId,
          parentMessageId,
        })
        if (result.status === "completed") {
          trace.notifyCompleted()
        } else if (result.status === "failed" && !result.willRetry) {
          // A retryable attempt isn't terminal — don't flash the trace dialog red
          // (the retry resumes this session). notifyActivityEnded still fires to stop
          // the live ticker; the retry re-emits notifyActivityStarted.
          trace.notifyFailed()
        }
        trace.notifyActivityEnded()
      }

      switch (result.status) {
        case "skipped":
          return {
            sessionId: result.sessionId,
            messagesSent: 0,
            sentMessageIds: [],
            status: "skipped",
            skipReason: result.reason,
          }

        case "failed":
          return {
            sessionId: result.sessionId,
            messagesSent: 0,
            sentMessageIds: [],
            status: "failed",
            retryable: result.retryable,
          }

        case "completed":
          return {
            sessionId: result.sessionId,
            messagesSent: result.messagesSent,
            sentMessageIds: result.sentMessageIds,
            status: "completed",
            lastSeenSequence: result.lastSeenSequence,
            streamId,
            personaId,
          }
      }
    }

    if (eagerThreadDenialResult) return finalizeSessionResult(eagerThreadDenialResult)

    const result = await withCompanionSession(
      sessionOptions(sessionStreamId, isChannelMention ? BigInt(0) : initialSequence),
      async (session, db) => {
        const trace = traceEmitter.forSession({
          sessionId: session.id,
          workspaceId,
          streamId: sessionStreamId,
          triggerMessageId: messageId,
          personaName: persona.name,
          parentStreamId,
          parentMessageId,
        })
        trace.notifyActivityStarted()

        // The worker intentionally does not preflight authority: this durable
        // session must own denial bookkeeping. Reject before context hydration
        // can spend AI work, then recheck again at the final provider boundary
        // below so a transition during hydration cannot slip through.
        await withTransaction(db, (tx) =>
          (this.deps.assertInitiatorWritable ?? assertStreamWritable)(tx, {
            workspaceId,
            streamId: sessionStreamId,
            principal: { kind: "user", userId: input.initiatingUserId },
          })
        )

        // Resolve the per-turn hydration policy at the dispatch (`Hydrate`)
        // seam — window budget + whether prior turn digests carry — and hand it
        // to the context build. For a DM this reads the PRIOR completed
        // session's cursor (the current RUNNING session, just inserted, is
        // skipped) to decide the episode boundary (§2.8 Q7/Q8). Two related
        // reads with no AI work, so take a single connection — unlike
        // buildAgentContext below, which holds none across its rolling-summary
        // AI call (INV-41).
        const policy = await withClient(pool, (client) => resolveContextWindowPolicy(client, { stream }))

        const agentContext = await buildAgentContext(
          { db: pool, userPreferencesService, conversationSummaryService },
          { workspaceId, streamId, stream, messageId, persona, purpose, policy, currentTime, followUp: followUpContext }
        )

        // Resolve an attached ContextBag (if any) so `stable + delta` flow into
        // the system prompt for this turn. Live-follow: the bag is re-resolved
        // every turn, so edits/deletes on the source thread surface in the
        // "Since last turn" delta block. Runs after `buildAgentContext` so we
        // can fold its output into the same systemPrompt the AgentRuntime sees.
        // INV-41: `resolveBagForStream` releases the DB connection before any
        // summarization AI call runs.
        const bagCostContext: CostContext = {
          workspaceId,
          userId: agentContext.invokingUserId,
          sessionId: session.id,
          origin: agentContext.invokingUserId ? "user" : "system",
        }
        const resolvedBag: ResolvedBag | null = await resolveBagForStream(
          { pool, ai, costContext: bagCostContext },
          streamId
        )

        // Persist which message IDs are in the agent's context window
        // so edit-triggered reruns can check exact membership
        const contextMessageIds = agentContext.streamContext.conversationHistory.map((m) => m.id)
        await AgentSessionRepository.updateContextMessageIds(pool, session.id, contextMessageIds)

        // Initial context for the leading CONTEXT_RECEIVED trace step — the
        // runtime emits it as a `context:received` event at run start, through
        // the same projector as every other step.
        let initialContext: NonNullable<AgentRuntimeConfig["initialContext"]> | undefined
        if (agentContext.streamContext.conversationHistory.length > 0) {
          const history = agentContext.streamContext.conversationHistory
          const triggerIdx = history.findIndex((m) => m.id === messageId)
          const contextMessages = triggerIdx >= 0 ? history.slice(Math.max(0, triggerIdx - 4)) : history.slice(-5)

          // Surface the resolved context-bag (the same one folded into the
          // system prompt above) on the trace step so the dialog can render
          // the same "X messages in #foo" pill the in-stream message shows,
          // plus the actual referenced messages. The point of the trace is
          // to expose more than what's visible in the stream — without this
          // the user can't see what was fed to the model.
          const attachedContext = resolvedBag
            ? {
                refs: resolvedBag.refs.map((ref) => ({
                  kind: ref.kind,
                  streamId: ref.streamId,
                  conversationId: ref.conversationId,
                  fromMessageId: ref.fromMessageId,
                  toMessageId: ref.toMessageId,
                  originMessageId: ref.originMessageId,
                  source: ref.source,
                  messages: ref.items.map((m) => ({
                    messageId: m.messageId,
                    authorName: m.authorName,
                    createdAt: m.createdAt,
                    content: m.contentMarkdown.slice(0, 300),
                  })),
                })),
              }
            : undefined

          initialContext = {
            messages: contextMessages.map((m) => ({
              messageId: m.id,
              authorName: agentContext.authorNames.get(m.authorId) ?? "Unknown",
              authorType: m.authorType,
              createdAt: m.createdAt.toISOString(),
              content: m.contentMarkdown,
              isTrigger: m.id === messageId,
            })),
            extras: {
              rerunContext: toTraceRerunContext(rerunContext),
              ...(attachedContext && { attachedContext }),
            },
          }
        }

        // Build workspace agent callback for on-demand workspace research. The
        // signal comes from SessionAbortRegistry via AgentRuntime.toolSignalProvider —
        // cancelling aborts gracefully (partial results) rather than failing the
        // whole session.
        let runWorkspaceAgent:
          | ((
              query: string,
              opts: { signal: AbortSignal; onSubstep: (text: string) => void; deadlineAt: number }
            ) => Promise<WorkspaceAgentResult>)
          | undefined
        if (agentContext.triggerMessage && agentContext.invokingUserId) {
          const capturedInvokingUserId = agentContext.invokingUserId
          runWorkspaceAgent = (query, { signal, onSubstep, deadlineAt }) =>
            workspaceAgent.search({
              workspaceId,
              streamId,
              query,
              conversationHistory: agentContext.streamContext.conversationHistory,
              invokingUserId: capturedInvokingUserId,
              signal,
              onSubstep,
              deadlineAt,
            })
        }

        const targetStreamId = sessionStreamId
        const supersededMessagePlan = await this.loadSupersededMessagePlan(db, {
          supersedesSessionId,
          streamId: targetStreamId,
          personaId: persona.id,
          triggerMessageId: messageId,
        })
        const isSupersedeRerun = !!supersededMessagePlan

        // The purpose as it effectively behaves this turn: a supersede rerun
        // whose target session vanished (no reusable plan), or a follow-up whose
        // row failed to load, degrades to a plain catch-up. The purpose prompt
        // section and the derived runtime flags both key off this, so wording and
        // behavior match what the turn actually does.
        let effectivePurpose: TurnPurpose = purpose
        if (purpose.kind === "supersede_rerun" && !isSupersedeRerun) effectivePurpose = { kind: "catch_up" }
        else if (purpose.kind === "follow_up" && !isFollowUp) effectivePurpose = { kind: "catch_up" }
        const turnFlags = deriveTurnFlags(effectivePurpose)

        // Per-turn model resolution (roadmap 2.3), at the dispatch seam like
        // the context-window policy: persona.model by default; a supersede
        // rerun whose previous attempt failed the response validator runs on
        // the persona's escalationModel. Visible as a model_escalated trace
        // step so the trace explains why this turn cost more.
        const turnModel = resolveTurnModel(persona, {
          purpose: effectivePurpose,
          supersededSession: supersededMessagePlan?.supersededSession ?? null,
        })
        if (turnModel.escalated) {
          const escalationStep = await trace.startStep({
            stepType: AgentStepTypes.MODEL_ESCALATED,
            content: JSON.stringify({
              fromModel: persona.model,
              toModel: turnModel.model,
              cause: "previous_attempt_failed_validation",
            }),
          })
          await escalationStep.complete({})
        }

        // The turn's conversation anchor (roadmap 3.3): the trigger message's own
        // topic, resolved via the canonical resolver (INV-35) — prefer the
        // trigger's PRIMARY conversation, else the most recently active one
        // overlapping the context window (the fallback carries the common case,
        // since the trigger is usually not classified on the turn it fires —
        // extraction lags). Best-effort per §2.8 Q8; null when nothing overlaps
        // (e.g. E2E streams the segmenter skips, or a follow-up turn with no
        // trigger message). Memoized so every write this turn — the reply's
        // declared conversation AND a scheduled follow-up's source anchor — lands
        // on the same topic, and so it resolves at most once.
        let triggerConversationResolved = false
        let triggerConversationId: string | null = null
        const resolveTriggerConversationId = async (): Promise<string | null> => {
          if (triggerConversationResolved) return triggerConversationId
          triggerConversationResolved = true
          if (agentContext.triggerMessage) {
            const anchor = await resolveEligibleConversation(db, {
              workspaceId,
              preferMessageId: agentContext.triggerMessage.id,
              windowMessageIds: contextMessageIds,
              isEligible: () => true,
            })
            triggerConversationId = anchor?.id ?? null
          }
          return triggerConversationId
        }

        // `sources` is required on the commit payload (empty array = none) so a
        // caller can't silently drop citations — see TurnCommit.
        const doSendMessage = async (msgInput: { content: string; sources: SourceItem[] }) => {
          const latestSession = await AgentSessionRepository.findById(db, session.id)
          if (!latestSession || latestSession.status !== SessionStatuses.RUNNING) {
            throw new Error(`Session ${session.id} is no longer running`)
          }

          const reusableMessageId = supersededMessagePlan?.messageIds[supersededMessagePlan.nextIndex]
          if (reusableMessageId) {
            supersededMessagePlan.nextIndex += 1

            try {
              // Deliberately no `sources` here: the message_edited event has
              // never carried them, and the rerun's citations still reach their
              // one render surface — the session trace — via the runtime's
              // message:edited event (the trace projector persists
              // event.sources). E2E streams never take this path: editMessage
              // refuses them and the catch below falls through to
              // createMessage, which seals sources into the payload.
              const editedMessage = await editMessage({
                initiatingUserId: input.initiatingUserId,
                workspaceId,
                streamId: targetStreamId,
                messageId: reusableMessageId,
                actorId: persona.id,
                content: msgInput.content,
                accessibleStreamIds: agentContext.accessibleStreamIds ? [...agentContext.accessibleStreamIds] : [],
              })
              if (editedMessage) {
                return { messageId: editedMessage.id, operation: "edited" as const }
              }
            } catch (err) {
              logger.warn(
                { err, sessionId: session.id, supersedesSessionId, messageId: reusableMessageId },
                "Failed to edit superseded message; creating a new message instead"
              )
            }
          }

          // Declare the reply's conversation (roadmap 3.3) so it's assigned
          // synchronously to the trigger's topic in the send txn and boundary
          // extraction skips its most-recently-active fallback — this is the fix
          // for busy channels where the last-touched topic isn't the one being
          // replied to. The anchor is the trigger's own conversation, which
          // always shares the reply's access root (trigger + reply sit in the
          // same stream, or a channel and a thread beneath it), so the assigner's
          // cross-root guard never rejects it. Null anchor → omit → today's
          // behavior. Not on the supersede EDIT path above: an edit keeps the
          // conversation the original send already declared.
          const declaredConversationId = await resolveTriggerConversationId()
          const message = await createMessage({
            initiatingUserId: input.initiatingUserId,
            workspaceId,
            streamId: targetStreamId,
            authorId: persona.id,
            authorType: AuthorTypes.PERSONA,
            content: msgInput.content,
            sources: msgInput.sources,
            sessionId: session.id,
            ...(declaredConversationId && {
              conversation: { intent: ConversationIntents.EXISTING, conversationId: declaredConversationId },
            }),
            // Personas have no `stream_members` rows; pass the agent's
            // scope-restricted `AgentAccessSpec` reach so inline-attachment
            // and share gates run against the same set the workspace tools
            // already use (private channel = that channel + public, public
            // channel = public only, scratchpad = user-full). NOT the
            // invoking user's full access — that would be a scope escalation.
            // Always pass an array (even empty) so the persona path uses the
            // set-membership gate. Falling back to `undefined` would route
            // through the user-path membership check keyed by authorId, which
            // unconditionally denies for personas (no `stream_members` rows).
            accessibleStreamIds: agentContext.accessibleStreamIds ? [...agentContext.accessibleStreamIds] : [],
          })
          return { messageId: message.id, operation: "created" as const }
        }

        // Build workspace tool deps (requires invoking member for access control).
        // `accessibleStreamIds` was computed once by buildAgentContext; reuse it
        // here instead of recomputing (avoids drift between quote-resolution and
        // workspace-tool access scopes).
        let workspaceDeps: import("./tools/tool-deps").WorkspaceToolDeps | undefined
        if (agentContext.invokingUserId && agentContext.accessibleStreamIds) {
          workspaceDeps = {
            db,
            workspaceId,
            accessibleStreamIds: [...agentContext.accessibleStreamIds],
            invokingUserId: agentContext.invokingUserId,
            searchService,
            attachmentService,
            memoExplorer: memoExplorerService,
            storage,
          }
        }

        // Reaction callbacks for the react_to_message tool, bound to this
        // persona's identity so the tool only supplies the target message, its
        // stream, and the emoji. Reactions are attributed to the persona (the
        // server.ts wrapper fixes actorType to "persona"), never the invoking
        // user.
        const reactionDeps: import("./tools/tool-deps").ReactionToolDeps = {
          addReaction: ({ streamId: targetStream, messageId: targetMessage, emoji }) =>
            addReaction({
              initiatingUserId: input.initiatingUserId,
              workspaceId,
              streamId: targetStream,
              messageId: targetMessage,
              emoji,
              actorId: persona.id,
            }),
          removeReaction: ({ streamId: targetStream, messageId: targetMessage, emoji }) =>
            removeReaction({
              initiatingUserId: input.initiatingUserId,
              workspaceId,
              streamId: targetStream,
              messageId: targetMessage,
              emoji,
              actorId: persona.id,
            }),
        }

        // Follow-up scheduling for the schedule_follow_up tool, bound to this
        // persona/session/stream. The source-conversation anchor shares the
        // reply's anchor (`resolveTriggerConversationId`, INV-35) so a follow-up
        // and the reply that scheduled it point at the same topic.
        const followUpDeps: import("./tools/tool-deps").FollowUpToolDeps | undefined =
          scheduleFollowUp && listFollowUps && cancelFollowUp && updateFollowUp
            ? {
                scheduleFollowUp: async ({ note, scheduledFor }) =>
                  scheduleFollowUp({
                    initiatingUserId: input.initiatingUserId,
                    workspaceId,
                    streamId: session.streamId,
                    personaId: persona.id,
                    sessionId: session.id,
                    sourceConversationId: await resolveTriggerConversationId(),
                    note,
                    scheduledFor,
                  }),
                listFollowUps: () => listFollowUps({ workspaceId, streamId: session.streamId }),
                cancelFollowUp: ({ followUpId }) =>
                  cancelFollowUp({ workspaceId, streamId: session.streamId, followUpId }),
                updateFollowUp: ({ followUpId, note, scheduledFor }) =>
                  updateFollowUp({
                    initiatingUserId: input.initiatingUserId,
                    workspaceId,
                    streamId: session.streamId,
                    followUpId,
                    note,
                    scheduledFor,
                  }),
              }
            : undefined

        // Brief maintenance for the update_stream_brief tool (roadmap 4.2), bound
        // to this persona and the brief's effective root (threads inherit the
        // root's brief — INV-62, same key the context read used). The version the
        // tool writes against is the one read at context time (below), so a
        // concurrent human edit surfaces as a conflict, not a silent clobber.
        const briefStreamId = resolveBriefStreamId(stream)
        const briefDeps: import("./tools/tool-deps").UpdateStreamBriefToolDeps | undefined = updateBrief
          ? {
              updateBrief: ({ content, reason, expectedVersion }) =>
                updateBrief({
                  initiatingUserId: input.initiatingUserId,
                  workspaceId,
                  streamId: briefStreamId,
                  requestedStreamId: session.streamId,
                  personaId: persona.id,
                  content,
                  reason,
                  expectedVersion,
                }),
            }
          : undefined

        // Delegation hand-off for the delegate_task tool (roadmap 5.1), bound to
        // this persona/session/stream and the invoking user. Deliberately absent
        // — disabling the tool — on sealed streams (a server-built plaintext
        // brief cannot egress an E2E stream, the #1118 ruling) and on turns
        // without a human trigger, since the hand-off may carry only what the
        // requesting user can see.
        const delegationUserId = agentContext.invokingUserId
        const delegationStreamIds = agentContext.accessibleStreamIds
        const delegateDeps: import("./tools/tool-deps").DelegateTaskToolDeps | undefined =
          delegateTask && delegationUserId && delegationStreamIds && !stream.e2eEnabled
            ? {
                delegateTask: async ({ title, brief, contextRefs }) =>
                  delegateTask({
                    initiatingUserId: input.initiatingUserId,
                    workspaceId,
                    streamId: session.streamId,
                    personaId: persona.id,
                    sessionId: session.id,
                    sourceConversationId: await resolveTriggerConversationId(),
                    invokingUserId: delegationUserId,
                    accessibleStreamIds: [...delegationStreamIds],
                    title,
                    brief,
                    contextRefs,
                  }),
              }
            : undefined

        // Settings changes for the update_user_settings tool, bound to the
        // INVOKING USER — never a tool parameter, so a cross-user write cannot
        // be expressed. Three independent conditions, each for its own reason:
        // the effective root must be a scratchpad (settings are personal; a
        // channel or DM is shared context), a human must have triggered the turn
        // (otherwise there is no user whose settings these are), and the stream
        // must not be sealed (the enclave runs its own loop and cannot reach
        // this service). Absent deps mean the tool is never built, so the model
        // is not told about a capability it would only be refused.
        const settingsUserId = agentContext.invokingUserId
        const settingsDeps: import("./tools/tool-deps").UpdateUserSettingsToolDeps | undefined =
          settingsUserId &&
          canOfferUserSettings({
            rootStreamType,
            rootStreamCreatedBy,
            invokingUserId: settingsUserId,
            rerunCause: rerunContext?.cause,
            e2eEnabled: stream.e2eEnabled === true,
          })
            ? {
                updateSettings: async (patch) => {
                  const before = await this.deps.userPreferencesService.getPreferences(workspaceId, settingsUserId)
                  const after = await this.deps.userPreferencesService.updatePreferences(
                    workspaceId,
                    settingsUserId,
                    patch
                  )
                  return { before, after }
                },
              }
            : undefined

        // Memo saving for the save_memo tool (roadmap 6.2), bound to this
        // persona's stream + session. The write scopes dedup and the capture
        // event to the addressed stream, and records the session as provenance.
        // A saved memo may only anchor to messages in the turn's own stream
        // family — the addressed stream and its effective root (threads inherit
        // the root). This binds the memo's inherited retrieval access (INV-62) to
        // the producing stream, so it can't be widened by citing a message in a
        // broader stream the user also happens to see.
        const saveMemoStreamIds = Array.from(new Set([session.streamId, resolveBriefStreamId(stream)]))
        const saveMemoDeps: import("./tools/tool-deps").SaveMemoToolDeps | undefined = saveMemo
          ? {
              saveMemo: (params) =>
                saveMemo({
                  initiatingUserId: input.initiatingUserId,
                  workspaceId,
                  streamId: session.streamId,
                  sessionId: session.id,
                  sourceStreamIds: saveMemoStreamIds,
                  // The human the agent serves owns a `user`-scoped save (roadmap 6.4).
                  invokingUserId: agentContext.invokingUserId,
                  ...params,
                }),
            }
          : undefined

        const githubDeps = workspaceIntegrationService
          ? { workspaceId, getClient: createMemoizedGithubClient(workspaceIntegrationService, workspaceId) }
          : undefined
        const linearDeps = workspaceIntegrationService
          ? { workspaceId, getClient: createMemoizedLinearClient(workspaceIntegrationService, workspaceId) }
          : undefined

        // Build the general researcher callback. Like runWorkspaceAgent it
        // requires invoking-user context (workspace search primitives are
        // access-scoped to that user). The researcher drives the persona's
        // PRIMITIVE tools — web, URL reads, workspace search, GitHub, Linear —
        // NOT a nested workspace_research sub-agent (runWorkspaceAgent is
        // deliberately omitted from its tool set).
        let runGeneralResearch:
          | ((query: string, opts: RunGeneralResearchOptions) => Promise<GeneralResearchResult>)
          | undefined
        if (agentContext.triggerMessage && agentContext.invokingUserId) {
          // Drop integration tools the workspace hasn't connected so buildToolSet
          // doesn't log "tools enabled but no deps" warnings on every research
          // call. Web + workspace primitives degrade silently already.
          const researcherEnabledTools = GENERAL_RESEARCH_TOOL_POLICY.filter((toolName) => {
            if (toolName.startsWith("github_")) return Boolean(githubDeps)
            if (toolName.startsWith("linear_")) return Boolean(linearDeps)
            return true
          })
          // The stream's tool policy folds over the sub-loop's toolset too —
          // general_research must not reach surfaces the stream restricts.
          const { tools: researcherTools } = negotiateCapabilities({
            streamPolicy: streamToolPolicy,
            tools: buildToolSet({
              enabledTools: researcherEnabledTools,
              tavilyApiKey,
              currentTime: agentContext.streamContext.temporal?.currentTime,
              timezone: agentContext.streamContext.temporal?.timezone,
              workspace: workspaceDeps,
              github: githubDeps,
              linear: linearDeps,
              supportsVision: false,
            }),
          })
          const researchCostContext: CostContext = {
            workspaceId,
            userId: agentContext.invokingUserId,
            sessionId: session.id,
            origin: "user",
          }
          const conversationContext = formatConversationContext(
            agentContext.streamContext.conversationHistory,
            agentContext.authorNames
          )
          runGeneralResearch = (query, { signal, onSubstep, deadlineAt }) =>
            generalResearcher.research({
              workspaceId,
              query,
              conversationContext,
              tools: researcherTools,
              costContext: researchCostContext,
              signal,
              deadlineAt,
              onSubstep,
            })
        }

        // The per-stream tool policy gates the persona's toolset (one chokepoint
        // shared with the enclave). The system prompt follows automatically:
        // composeSystemPrompt derives tool prose from the surviving toolset.
        const { tools } = negotiateCapabilities({
          streamPolicy: streamToolPolicy,
          tools: buildToolSet({
            enabledTools: persona.enabledTools,
            tavilyApiKey,
            currentTime: agentContext.streamContext.temporal?.currentTime,
            timezone: agentContext.streamContext.temporal?.timezone,
            runWorkspaceAgent,
            runGeneralResearch,
            workspace: workspaceDeps,
            reactions: reactionDeps,
            followUps: followUpDeps,
            brief: briefDeps,
            briefVersion: agentContext.streamBrief?.version ?? 0,
            delegation: delegateDeps,
            saveMemo: saveMemoDeps,
            settings: settingsDeps,
            github: githubDeps,
            linear: linearDeps,
            supportsVision: modelRegistry.supportsVision(turnModel.model),
          }),
        })

        if (stubResponse) {
          // The stub also writes one tool step carrying effects, so the browser
          // suite can exercise the real effect surfaces — the trace step's
          // WROTE badge and diff, and the session card's grid — through the
          // real data path (step column → collectSessionEffects → lifecycle
          // payload) without a model call. Layout is the part jsdom cannot
          // judge, so it has to be asserted in a real browser somewhere.
          const step = await trace.startStep({ stepType: AgentStepTypes.TOOL_CALL, content: STUB_EFFECTS_CONTENT })
          await step.effects(STUB_EFFECTS)
          await step.complete({ content: STUB_EFFECTS_CONTENT })

          const msg = await doSendMessage({ content: stubResponse, sources: [] })
          return {
            messagesSent: 1,
            sentMessageIds: [msg.messageId],
            lastSeenSequence: session.lastSeenSequence ?? initialSequence,
          }
        }

        const model = ai.getLanguageModel(turnModel.model)
        const parsed = ai.parseModel(turnModel.model)

        // Collects the turn's completed tool calls (content + sources) so a
        // turn_digest step can carry the tool work into later turns (C-1).
        const digestCollector = new TurnDigestCollector()

        // Split at its cache boundary: the stable half is what the prompt-cache
        // breakpoint covers (tool definitions ride the same span), the volatile
        // half carries temporal grounding, turn digests, and the bag delta.
        const composedPrompt = appendBagToSystemPrompt(
          agentContext.composeSystemPrompt(tools, effectivePurpose),
          resolvedBag
        )

        // The turn as dispatch mints it: delivery + model binding + this
        // turn's prompt, history, toolset, and sampling params.
        const turnRequest: TurnRequest = {
          delivery: TurnDeliveries.PLAINTEXT,
          model,
          modelString: turnModel.model,
          // Origin is "user" for mention-triggered runs where we can attribute
          // cost to the invoking user; otherwise fall back to "system".
          costContext: {
            workspaceId,
            userId: agentContext.invokingUserId,
            sessionId: session.id,
            origin: agentContext.invokingUserId ? "user" : "system",
          },
          // The purpose's prompt section (mention/follow-up early, supersede
          // reconciliation last) is composed here from the effective purpose —
          // one dispatch, no bespoke supersede wrap at the call site (roadmap 1.5).
          systemPrompt: composedPrompt.stable,
          volatileSystemPrompt: composedPrompt.volatile,
          messages: agentContext.messages,
          initialContext,
          tools,
          maxTokens: persona.maxTokens,
          temperature: persona.temperature,
          // Supersede reruns and fired follow-ups may legitimately conclude
          // "nothing to add" — this exposes `keep_response` so they end silently
          // instead of the runtime auto-committing filler. Derived from the
          // purpose kind, never set ad hoc (roadmap 1.5).
          allowNoMessageOutput: turnFlags.allowNoMessageOutput,
          // Reviews every tier-2 call before it runs. Always supplied on this
          // path rather than only when a guarded tool is present: which tools
          // the turn holds is decided further up (persona enablement, stream
          // policy, dependency availability), so gating the guardian on that
          // decision would put a second copy of it here to drift out of sync.
          // AgentRuntime refuses to start if a guarded tool arrives without
          // one, which is the check that actually holds.
          toolGuardian: new ToolGuardianService(
            { ai, configResolver: this.deps.configResolver },
            {
              workspaceId,
              streamId: session.streamId,
              personaId: persona.id,
              sessionId: session.id,
              // The principal every guarded tool on this turn acts as — the
              // same id their deps are bound to. Without it the guardian
              // cannot tell the bound user's request from another
              // participant's message in the same stream.
              invokingUserId: agentContext.invokingUserId,
              costContext: {
                workspaceId,
                userId: agentContext.invokingUserId,
                sessionId: session.id,
                origin: agentContext.invokingUserId ? "user" : "system",
              },
            }
          ),
          validateFinalResponse: isSupersedeRerun
            ? buildSupersedeResponseValidator({
                ai,
                sessionId: session.id,
                rerunContext,
                costContext: {
                  workspaceId,
                  userId: agentContext.invokingUserId,
                  sessionId: session.id,
                  origin: agentContext.invokingUserId ? "user" : "system",
                },
              })
            : undefined,
          telemetry: {
            functionId: "agent-loop",
            metadata: {
              model_id: parsed.modelId,
              model_provider: parsed.modelProvider,
              model_name: parsed.modelName,
              model_escalated: turnModel.escalated,
              personaId: persona.id,
              // The trigger stream the agent is invoked in — threaded as a
              // `disclose` subject ref (design §7.3). The full set of streams
              // read into context is not cheaply enumerable here, so the trigger
              // stream stands in for the egress's data subject.
              subjectRefs: [{ type: "stream", id: streamId }],
            },
          },
        }

        // One graceful-Stop controller per session, registered up front (not
        // lazily per-tool) so a Stop lands even when no tool has run yet — it
        // cancels a pending LLM iteration (via runAbortSignal) and cuts any
        // in-flight tool fetch (via toolSignalProvider). The socket handler
        // aborts it; `finally` unregisters. This is the session-abort channel,
        // distinct from shouldAbort (which fails the session).
        const sessionAbortController = sessionAbortRegistry.register(session.id, {
          workspaceId,
          streamId: sessionStreamId,
        })

        // The host edges this turn runs against: the commit path, the trace
        // observers, and the abort + interjection channels that used to be
        // handed to the loop as raw closures.
        const turnSink: TurnSink = {
          commitMessage: doSendMessage,
          observers: [createSessionTraceProjector(trace), digestCollector],
          shouldAbort: async () => {
            const latestSession = await AgentSessionRepository.findById(db, session.id)
            if (!latestSession) return "session missing"
            if (latestSession.status === SessionStatuses.RUNNING) return null
            if (latestSession.status === SessionStatuses.DELETED) return "session deleted"
            if (latestSession.status === SessionStatuses.SUPERSEDED) return "session superseded"
            return null
          },
          // Hand the session-Stop signal to every tool: the long HTTP-fetch
          // tools (web_search, read_url) and the research tools check it and
          // return partial gracefully; tools that ignore it are unaffected, and
          // the loop halts at the next boundary regardless via runAbortSignal.
          toolSignalProvider: () => sessionAbortController.signal,
          // Cancels a pending LLM iteration and halts the loop gracefully when a
          // Stop lands with no tool running (or between tool calls).
          runAbortSignal: sessionAbortController.signal,
          newMessages: {
            check: async (checkStreamId, sinceSequence, excludeAuthorId) => {
              const events = await StreamEventRepository.list(db, checkStreamId, {
                types: ["message_created", "message_edited", "message_deleted"],
                afterSequence: sinceSequence,
                limit: 50,
              })

              const filteredEvents = events.filter((event) => event.actorId !== excludeAuthorId)
              if (filteredEvents.length === 0) return []

              const changedMessageIds = filteredEvents
                .map((event) => (event.payload as { messageId?: string }).messageId)
                .filter((messageId): messageId is string => typeof messageId === "string")

              const messagesById = await MessageRepository.findByIds(db, changedMessageIds)

              const userIds = [
                ...new Set(
                  filteredEvents
                    .filter((event) => event.actorType === "user" && event.actorId)
                    .map((event) => event.actorId!)
                ),
              ]
              const personaIds = [
                ...new Set(
                  filteredEvents
                    .filter((event) => event.actorType === "persona" && event.actorId)
                    .map((event) => event.actorId!)
                ),
              ]

              const [members, personas] = await Promise.all([
                userIds.length > 0 ? UserRepository.findByIds(db, workspaceId, userIds) : Promise.resolve([]),
                personaIds.length > 0 ? PersonaRepository.findByIds(db, personaIds, workspaceId) : Promise.resolve([]),
              ])

              const names = new Map<string, string>()
              for (const m of members) names.set(m.id, m.name)
              for (const p of personas) names.set(p.id, p.name)

              return filteredEvents.flatMap<NewMessageInfo>((event) => {
                const eventPayload = event.payload as { messageId?: string }
                const eventMessageId = eventPayload.messageId
                if (!eventMessageId) return []

                const message = messagesById.get(eventMessageId)
                const authorId = event.actorId ?? message?.authorId ?? "system"
                const authorType = event.actorType ?? message?.authorType ?? AuthorTypes.SYSTEM
                const authorName = names.get(authorId) ?? (authorType === AuthorTypes.SYSTEM ? "System" : "Unknown")

                if (event.eventType === "message_created") {
                  if (!message) return []
                  return [
                    {
                      sequence: event.sequence,
                      messageId: message.id,
                      changeType: "message_created" as const,
                      content: message.contentMarkdown,
                      authorId,
                      authorName,
                      authorType,
                      createdAt: event.createdAt.toISOString(),
                    },
                  ]
                }

                if (event.eventType === "message_edited") {
                  return [
                    {
                      sequence: event.sequence,
                      messageId: eventMessageId,
                      changeType: "message_edited" as const,
                      content: message?.contentMarkdown
                        ? `[Message edited]\\n${message.contentMarkdown}`
                        : "[Message edited]",
                      authorId,
                      authorName,
                      authorType,
                      createdAt: event.createdAt.toISOString(),
                    },
                  ]
                }

                return [
                  {
                    sequence: event.sequence,
                    messageId: eventMessageId,
                    changeType: "message_deleted" as const,
                    content: "[Message deleted]",
                    authorId,
                    authorName,
                    authorType,
                    createdAt: event.createdAt.toISOString(),
                  },
                ]
              })
            },
            updateSequence: async (updateSessionId, sequence) => {
              await AgentSessionRepository.updateLastSeenSequence(db, updateSessionId, sequence)
            },
            awaitAttachments: async (messageIds) => {
              const attachmentsByMessage = await AttachmentRepository.findByMessageIds(db, messageIds)
              const allAttachmentIds: string[] = []
              for (const attachments of attachmentsByMessage.values()) {
                for (const a of attachments) allAttachmentIds.push(a.id)
              }
              if (allAttachmentIds.length > 0) {
                await awaitAttachmentProcessing(db, allAttachmentIds)
              }
            },
            streamId: targetStreamId,
            sessionId: session.id,
            personaId: persona.id,
            lastProcessedSequence: session.lastSeenSequence ?? initialSequence,
          },
        }

        try {
          await withTransaction(db, (tx) =>
            (this.deps.assertInitiatorWritable ?? assertStreamWritable)(tx, {
              workspaceId,
              streamId: targetStreamId,
              principal: { kind: "user", userId: input.initiatingUserId },
            })
          )
          const loopResult = await this.turnDriver.runTurn(turnRequest, turnSink)
          const retainedMessageIds =
            isSupersedeRerun && loopResult.sentMessageIds.length === 0
              ? [...supersededMessagePlan.messageIds]
              : loopResult.sentMessageIds

          if (isSupersedeRerun && loopResult.sentMessageIds.length === 0) {
            logger.info(
              {
                sessionId: session.id,
                supersedesSessionId,
                retainedMessageCount: retainedMessageIds.length,
                reason: loopResult.noMessageReason,
              },
              "Supersede rerun kept previous session messages unchanged"
            )
          }

          // The rerun could not produce a valid revision (drafts repeatedly
          // failed the response validator). Mark the session so the NEXT rerun
          // that supersedes it escalates to the persona's escalationModel
          // (roadmap 2.3).
          if (isSupersedeRerun && loopResult.responseValidationFailed) {
            await AgentSessionRepository.markResponseValidationFailed(db, session.id)
          }

          if (supersededMessagePlan) {
            await this.reconcileSupersededMessages({
              workspaceId,
              streamId: targetStreamId,
              initiatingUserId: input.initiatingUserId,
              personaId: persona.id,
              sessionId: session.id,
              supersedesSessionId,
              supersededMessageIds: supersededMessagePlan.messageIds,
              retainedMessageIds,
              deleteMessage,
            })
          }

          // Persist the render snapshot so the next turn's diff is anchored
          // against the state we just rendered. Idempotent UPDATE; safe if a
          // retry re-runs the turn body. Written after `runtime.run()` settles
          // to match the crash-window semantics of `persistSnapshot` itself
          // (INV-41: no DB connection held across the AI call).
          if (resolvedBag) {
            await persistSnapshot(pool, workspaceId, resolvedBag.bagId, resolvedBag.nextSnapshot)
          }

          // Turn digest (C-1): condense the turn's tool work into a final
          // turn_digest step so later turns can answer follow-ups without
          // re-running the tools. Best-effort and last — the reply is already
          // committed, so a digest failure must never fail the turn.
          await this.persistTurnDigest({
            ai,
            digestCollector,
            trace,
            sessionId: session.id,
            workspaceId,
            streamId,
            invokingUserId: agentContext.invokingUserId,
            replyText: loopResult.sentContents.at(-1),
          })

          return {
            messagesSent: loopResult.messagesSent,
            sentMessageIds: retainedMessageIds,
            lastSeenSequence: loopResult.lastProcessedSequence,
          }
        } finally {
          // Release the session-abort controller registered at turn start.
          sessionAbortRegistry.unregister(session.id)
        }
      }
    )

    return finalizeSessionResult(result)
  }

  /**
   * Generate + persist the turn's digest step (C-1). No-op when the turn used
   * no tools (a plain chat turn's reply already carries over in history).
   * Strictly best-effort: any failure logs and returns — the user-visible turn
   * has already succeeded.
   */
  private async persistTurnDigest(params: {
    ai: AI
    digestCollector: TurnDigestCollector
    trace: SessionTrace
    sessionId: string
    workspaceId: string
    streamId: string
    invokingUserId: string | undefined
    replyText: string | undefined
  }): Promise<void> {
    const { ai, digestCollector, trace, sessionId, workspaceId, streamId, invokingUserId, replyText } = params
    if (!digestCollector.hasToolWork) return

    try {
      const digest = await generateTurnDigest({
        ai,
        model: ai.getLanguageModel(TURN_DIGEST_MODEL_ID),
        modelString: TURN_DIGEST_MODEL_ID,
        records: digestCollector.records,
        replyText,
        telemetry: {
          functionId: "turn-digest",
          // The trigger stream rides as a `disclose` subject ref (design §7.3) so
          // this secondary egress links to the same data subject as the agent loop.
          metadata: {
            model_id: TURN_DIGEST_MODEL_ID,
            session_id: sessionId,
            subjectRefs: [{ type: "stream", id: streamId }],
          },
        },
        context: {
          workspaceId,
          userId: invokingUserId,
          sessionId,
          origin: invokingUserId ? "user" : "system",
        },
      })
      if (!digest) return

      const step = await trace.startStep({
        stepType: AgentStepTypes.TURN_DIGEST,
        content: JSON.stringify(digest),
      })
      await step.complete({})
    } catch (err) {
      logger.warn({ err, sessionId }, "Turn digest generation failed; completing the turn without one")
    }
  }

  private async loadSupersededMessagePlan(
    db: Querier,
    params: {
      supersedesSessionId?: string
      streamId: string
      personaId: string
      triggerMessageId: string
    }
  ): Promise<SupersededMessagePlan | null> {
    const { supersedesSessionId, streamId, personaId, triggerMessageId } = params
    if (!supersedesSessionId) return null

    const supersededSession = await AgentSessionRepository.findById(db, supersedesSessionId)
    if (!supersededSession) {
      logger.warn({ supersedesSessionId }, "Superseded session was not found; skipping reconciliation")
      return null
    }

    if (
      supersededSession.streamId !== streamId ||
      supersededSession.personaId !== personaId ||
      supersededSession.triggerMessageId !== triggerMessageId
    ) {
      logger.warn(
        {
          supersedesSessionId,
          expected: { streamId, personaId, triggerMessageId },
          actual: {
            streamId: supersededSession.streamId,
            personaId: supersededSession.personaId,
            triggerMessageId: supersededSession.triggerMessageId,
          },
        },
        "Superseded session mismatch; skipping reconciliation"
      )
      return null
    }

    const eventMessageIds = await StreamEventRepository.listMessageIdsBySession(db, streamId, supersededSession.id)
    const candidateMessageIds = dedupeMessageIds([...eventMessageIds, ...supersededSession.sentMessageIds])
    if (candidateMessageIds.length === 0) {
      return { messageIds: [], nextIndex: 0, supersededSession }
    }

    const messagesById = await MessageRepository.findByIds(db, candidateMessageIds)
    const reusableMessageIds = candidateMessageIds.filter((id) => {
      const message = messagesById.get(id)
      if (!message || message.deletedAt) return false
      return (
        message.streamId === streamId && message.authorType === AuthorTypes.PERSONA && message.authorId === personaId
      )
    })

    return { messageIds: reusableMessageIds, nextIndex: 0, supersededSession }
  }

  private async reconcileSupersededMessages(params: {
    workspaceId: string
    streamId: string
    initiatingUserId: string
    personaId: string
    sessionId: string
    supersedesSessionId?: string
    supersededMessageIds: string[]
    retainedMessageIds: string[]
    deleteMessage: PersonaAgentDeps["deleteMessage"]
  }): Promise<void> {
    const {
      workspaceId,
      streamId,
      initiatingUserId,
      personaId,
      sessionId,
      supersedesSessionId,
      supersededMessageIds,
      retainedMessageIds,
      deleteMessage,
    } = params

    const retained = new Set(retainedMessageIds)
    const staleMessageIds = supersededMessageIds.filter((id) => !retained.has(id))
    for (const messageId of staleMessageIds) {
      try {
        await deleteMessage({
          initiatingUserId,
          workspaceId,
          streamId,
          messageId,
          actorId: personaId,
        })
      } catch (err) {
        logger.error(
          { err, sessionId, supersedesSessionId, messageId },
          "Failed deleting stale superseded message during reconciliation"
        )
      }
    }
  }
}

/** Number of recent messages handed to the general researcher as grounding context. */
const RESEARCH_CONTEXT_MESSAGE_COUNT = 6
/** Per-message character cap in the researcher's conversation context block. */
const RESEARCH_CONTEXT_MESSAGE_CHARS = 300

/**
 * Build a compact, recent-conversation context string for the general
 * researcher. The researcher does not see the live chat — only the delegated
 * query plus this block — so it carries just enough to disambiguate references
 * ("the PR we discussed", "their proposal") without dumping full history.
 */
function formatConversationContext(
  history: Array<{ authorId: string; contentMarkdown: string }>,
  authorNames: Map<string, string>
): string | undefined {
  const recent = history.slice(-RESEARCH_CONTEXT_MESSAGE_COUNT)
  const lines: string[] = []
  for (const message of recent) {
    const text = message.contentMarkdown.trim()
    if (!text) continue
    const author = authorNames.get(message.authorId) ?? "Unknown"
    const clipped =
      text.length > RESEARCH_CONTEXT_MESSAGE_CHARS ? `${text.slice(0, RESEARCH_CONTEXT_MESSAGE_CHARS)}…` : text
    lines.push(`${author}: ${clipped}`)
  }
  return lines.length > 0 ? lines.join("\n") : undefined
}

function dedupeMessageIds(ids: string[]): string[] {
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const id of ids) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    deduped.push(id)
  }
  return deduped
}

function toTraceRerunContext(rerunContext?: AgentSessionRerunContext): Record<string, unknown> | undefined {
  if (!rerunContext) return undefined
  return {
    cause: rerunContext.cause,
    editedMessageId: rerunContext.editedMessageId,
    editedMessageBefore: rerunContext.editedMessageBefore ?? null,
    editedMessageAfter: rerunContext.editedMessageAfter ?? null,
    editedMessageRevision: rerunContext.editedMessageRevision ?? null,
  }
}

const SupersedeResponseValidationSchema = z.object({
  verdict: z.enum(["accept", "revise"]),
  reason: z.string().min(1).max(280),
})

function buildSupersedeResponseValidator(params: {
  ai: AI
  sessionId: string
  rerunContext?: AgentSessionRerunContext
  costContext: CostContext
}): (content: string) => Promise<string | null> {
  const { ai, sessionId, rerunContext, costContext } = params
  const editedBefore = rerunContext?.editedMessageBefore ?? null
  const editedAfter = rerunContext?.editedMessageAfter ?? null

  return async (content: string): Promise<string | null> => {
    const candidate = content.trim()
    if (candidate.length === 0) {
      return "Your response is empty. Provide a direct, useful answer to the edited request."
    }

    try {
      const { value } = await ai.generateObject({
        model: SUPERSEDE_RESPONSE_VALIDATOR_MODEL_ID,
        schema: SupersedeResponseValidationSchema,
        telemetry: {
          functionId: "agent-rerun-response-validation",
          metadata: {
            session_id: sessionId,
            rerun_cause: rerunContext?.cause ?? "unknown",
          },
        },
        context: costContext,
        maxTokens: SUPERSEDE_RESPONSE_VALIDATOR_MAX_TOKENS,
        temperature: SUPERSEDE_RESPONSE_VALIDATOR_TEMPERATURE,
        messages: [
          {
            role: "system",
            content:
              "You are validating whether an assistant response is acceptable for a supersede rerun in a chat agent.\n" +
              "Decide if the candidate response should be accepted as the final answer to the edited request.\n" +
              "Return JSON only via schema.\n" +
              "Use verdict='accept' when the response directly and helpfully addresses the edited user request.\n" +
              "Use verdict='revise' when the response does not adequately answer the edited request (for example only meta discussion, only reconfirmation, or insufficiently actionable output).",
          },
          {
            role: "user",
            content: JSON.stringify({
              rerunCause: rerunContext?.cause ?? null,
              editedMessageBefore: editedBefore,
              editedMessageAfter: editedAfter,
              candidateResponse: candidate.length > 4000 ? `${candidate.slice(0, 4000)}...` : candidate,
            }),
          },
        ],
      })

      return value.verdict === "revise" ? value.reason : null
    } catch (err) {
      logger.warn({ err, sessionId }, "Supersede response validation failed; skipping validation gate")
      return null
    }
  }
}
