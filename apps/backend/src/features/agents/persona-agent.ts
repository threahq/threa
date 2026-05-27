import type { Pool } from "pg"
import { z } from "zod"
import { withClient, type Querier } from "../../db"
import {
  AgentStepTypes,
  AgentTriggers,
  AuthorTypes,
  StreamTypes,
  type AgentSessionRerunContext,
  type AuthorType,
  type SourceItem,
} from "@threa/types"
import type { UserPreferencesService } from "../user-preferences"
import type { WorkspaceIntegrationService } from "../workspace-integrations"
import { StreamRepository } from "../streams"
import { MessageRepository, MessageVersionRepository } from "../messaging"
import { UserRepository } from "../workspaces"
import { PersonaRepository } from "./persona-repository"
import { AgentSessionRepository, SessionStatuses } from "./session-repository"
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
import { logger } from "../../lib/logger"
import { buildAgentContext, buildToolSet, withCompanionSession, type WithSessionResult } from "./companion"
import { resolveBagForStream, persistSnapshot, appendBagToSystemPrompt, type ResolvedBag } from "./context-bag"
import { createMemoizedGithubClient, createMemoizedLinearClient } from "./tools"
import { AgentRuntime, SessionTraceObserver, OtelObserver, type NewMessageInfo } from "./runtime"
import {
  SUPERSEDE_RESPONSE_VALIDATOR_MAX_TOKENS,
  SUPERSEDE_RESPONSE_VALIDATOR_MODEL_ID,
  SUPERSEDE_RESPONSE_VALIDATOR_TEMPERATURE,
} from "./config"

export type { WithSessionResult }

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
  workspaceAgent: WorkspaceAgent
  searchService: SearchService
  conversationSummaryService: ConversationSummaryService
  attachmentService: AttachmentService
  memoExplorerService: MemoExplorerService
  storage: StorageProvider
  modelRegistry: ModelRegistry
  workspaceIntegrationService?: WorkspaceIntegrationService
  tavilyApiKey?: string
  stubResponse?: string
  createMessage: (params: {
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
  }) => Promise<{ id: string }>
  editMessage: (params: {
    workspaceId: string
    streamId: string
    messageId: string
    actorId: string
    content: string
    /** Same semantics as `createMessage.accessibleStreamIds`. */
    accessibleStreamIds?: string[]
  }) => Promise<{ id: string } | null>
  deleteMessage: (params: {
    workspaceId: string
    streamId: string
    messageId: string
    actorId: string
  }) => Promise<{ id: string } | null>
  createThread: (params: {
    workspaceId: string
    parentStreamId: string
    parentMessageId: string
    createdBy: string
  }) => Promise<{ id: string }>
}

export interface PersonaAgentInput {
  workspaceId: string
  streamId: string
  messageId: string
  personaId: string
  serverId: string
  trigger?: typeof AgentTriggers.MENTION
  supersedesSessionId?: string
  rerunContext?: AgentSessionRerunContext
  /** Invocation time override for deterministic evals/tests. Production leaves this unset. */
  currentTime?: Date
}

export interface PersonaAgentResult {
  sessionId: string | null
  messagesSent: number
  sentMessageIds: string[]
  status: "completed" | "failed" | "skipped"
  skipReason?: string
  lastSeenSequence?: bigint
  streamId?: string
  personaId?: string
}

interface SupersededMessagePlan {
  messageIds: string[]
  nextIndex: number
}

export class PersonaAgent {
  constructor(private readonly deps: PersonaAgentDeps) {}

  async run(input: PersonaAgentInput): Promise<PersonaAgentResult> {
    const {
      pool,
      ai,
      traceEmitter,
      sessionAbortRegistry,
      userPreferencesService,
      workspaceAgent,
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
      createThread,
    } = this.deps
    const {
      workspaceId,
      streamId,
      messageId,
      personaId,
      serverId,
      trigger,
      supersedesSessionId,
      rerunContext,
      currentTime,
    } = input

    // Step 1: Load and validate persona + stream
    const precheck = await withClient(pool, async (client) => {
      const persona = await PersonaRepository.findById(client, personaId, workspaceId)
      if (!persona || persona.status !== "active") {
        return { skip: true as const, reason: "persona not found or inactive" }
      }

      const stream = await StreamRepository.findById(client, streamId)
      if (!stream) {
        return { skip: true as const, reason: "stream not found" }
      }

      const latestSequence = await StreamEventRepository.getLatestSequence(client, streamId)
      const triggerMessageRevision = await MessageVersionRepository.getCurrentRevision(client, messageId)

      return {
        skip: false as const,
        persona,
        stream,
        initialSequence: latestSequence ?? BigInt(0),
        triggerMessageRevision,
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

    const { persona, stream, initialSequence, triggerMessageRevision } = precheck

    // Step 2: For channel mentions, create thread eagerly so session events go there
    const isChannelMention = trigger === AgentTriggers.MENTION && stream.type === StreamTypes.CHANNEL
    let sessionStreamId = streamId
    let channelStreamId: string | undefined
    if (isChannelMention) {
      const thread = await createThread({
        workspaceId,
        parentStreamId: streamId,
        parentMessageId: messageId,
        createdBy: persona.id,
      })
      sessionStreamId = thread.id
      channelStreamId = streamId
      logger.info({ threadId: thread.id, streamId, messageId }, "Created thread for channel mention (eager)")
    }

    // Step 3: Run with session lifecycle
    const result = await withCompanionSession(
      {
        pool,
        triggerMessageId: messageId,
        streamId: sessionStreamId,
        personaId: persona.id,
        personaName: persona.name,
        workspaceId,
        serverId,
        initialSequence: isChannelMention ? BigInt(0) : initialSequence,
        triggerMessageRevision,
        supersedesSessionId,
        rerunContext,
      },
      async (session, db) => {
        const trace = traceEmitter.forSession({
          sessionId: session.id,
          workspaceId,
          streamId: sessionStreamId,
          triggerMessageId: messageId,
          personaName: persona.name,
          channelStreamId,
        })
        trace.notifyActivityStarted()

        // Build all context the agent needs
        const agentContext = await buildAgentContext(
          { db: pool, userPreferencesService, conversationSummaryService },
          { workspaceId, streamId, stream, messageId, persona, trigger, currentTime }
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

        // Record initial context step for trace UI
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
                  streamId: ref.streamId,
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

          const step = await trace.startStep({
            stepType: AgentStepTypes.CONTEXT_RECEIVED,
            content: JSON.stringify({
              messages: contextMessages.map((m) => ({
                messageId: m.id,
                authorName: agentContext.authorNames.get(m.authorId) ?? "Unknown",
                authorType: m.authorType,
                createdAt: m.createdAt.toISOString(),
                content: m.contentMarkdown.slice(0, 300),
                isTrigger: m.id === messageId,
              })),
              rerunContext: toTraceRerunContext(rerunContext),
              ...(attachedContext && { attachedContext }),
            }),
          })
          await step.complete({})
        }

        // Build workspace agent callback for on-demand workspace research.
        // The callback now accepts a signal, substep callback, and deadline sourced from
        // the tool layer via AgentRuntime.toolSignalProvider + AgentToolConfig.execute.onProgress.
        // Signal comes from SessionAbortRegistry — cancelling aborts gracefully (partial results)
        // rather than failing the whole session.
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

        const doSendMessage = async (msgInput: { content: string; sources?: SourceItem[] }) => {
          const latestSession = await AgentSessionRepository.findById(db, session.id)
          if (!latestSession || latestSession.status !== SessionStatuses.RUNNING) {
            throw new Error(`Session ${session.id} is no longer running`)
          }

          const reusableMessageId = supersededMessagePlan?.messageIds[supersededMessagePlan.nextIndex]
          if (reusableMessageId) {
            supersededMessagePlan.nextIndex += 1

            try {
              const editedMessage = await editMessage({
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

          const message = await createMessage({
            workspaceId,
            streamId: targetStreamId,
            authorId: persona.id,
            authorType: AuthorTypes.PERSONA,
            content: msgInput.content,
            sources: msgInput.sources,
            sessionId: session.id,
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

        const githubDeps = workspaceIntegrationService
          ? { workspaceId, getClient: createMemoizedGithubClient(workspaceIntegrationService, workspaceId) }
          : undefined
        const linearDeps = workspaceIntegrationService
          ? { workspaceId, getClient: createMemoizedLinearClient(workspaceIntegrationService, workspaceId) }
          : undefined

        const tools = buildToolSet({
          enabledTools: persona.enabledTools,
          tavilyApiKey,
          currentTime: agentContext.streamContext.temporal?.currentTime,
          timezone: agentContext.streamContext.temporal?.timezone,
          runWorkspaceAgent,
          workspace: workspaceDeps,
          github: githubDeps,
          linear: linearDeps,
          supportsVision: modelRegistry.supportsVision(persona.model),
        })

        // Stub mode: send canned response, skip AI loop
        if (stubResponse) {
          const msg = await doSendMessage({ content: stubResponse })
          return {
            messagesSent: 1,
            sentMessageIds: [msg.messageId],
            lastSeenSequence: session.lastSeenSequence ?? initialSequence,
          }
        }

        // Get model
        const model = ai.getLanguageModel(persona.model)
        const parsed = ai.parseModel(persona.model)

        // Run agent runtime
        const runtime = new AgentRuntime({
          ai,
          model,
          modelString: persona.model,
          // Origin is "user" for mention-triggered runs where we can attribute
          // cost to the invoking user; otherwise fall back to "system".
          costContext: {
            workspaceId,
            userId: agentContext.invokingUserId,
            sessionId: session.id,
            origin: agentContext.invokingUserId ? "user" : "system",
          },
          systemPrompt: appendBagToSystemPrompt(
            isSupersedeRerun
              ? buildSupersedeRerunSystemPrompt(agentContext.systemPrompt, rerunContext)
              : agentContext.systemPrompt,
            resolvedBag
          ),
          messages: agentContext.messages,
          tools,
          maxTokens: persona.maxTokens,
          temperature: persona.temperature,
          sendMessage: doSendMessage,
          allowNoMessageOutput: isSupersedeRerun,
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
            },
          },
          observers: [
            new SessionTraceObserver(trace),
            new OtelObserver({
              sessionId: session.id,
              streamId: targetStreamId,
              personaId: persona.id,
              metadata: {
                model_id: parsed.modelId,
                model_provider: parsed.modelProvider,
                model_name: parsed.modelName,
              },
            }),
          ],
          shouldAbort: async () => {
            const latestSession = await AgentSessionRepository.findById(db, session.id)
            if (!latestSession) return "session missing"
            if (latestSession.status === SessionStatuses.RUNNING) return null
            if (latestSession.status === SessionStatuses.DELETED) return "session deleted"
            if (latestSession.status === SessionStatuses.SUPERSEDED) return "session superseded"
            return null
          },
          toolSignalProvider: (_toolCallId, toolName) => {
            // Only wire graceful-abort for workspace_research in V1. Future long-running
            // tools can opt in here. The registry is lazily populated so sessions that
            // never invoke research don't allocate a controller.
            if (toolName !== "workspace_research") return undefined
            const controller = sessionAbortRegistry.register(session.id, {
              workspaceId,
              streamId: sessionStreamId,
            })
            return controller.signal
          },
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
        })

        try {
          const loopResult = await runtime.run()
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

          if (supersededMessagePlan) {
            await this.reconcileSupersededMessages({
              workspaceId,
              streamId: targetStreamId,
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

          return {
            messagesSent: loopResult.messagesSent,
            sentMessageIds: retainedMessageIds,
            lastSeenSequence: loopResult.lastProcessedSequence,
          }
        } finally {
          // Release the graceful-abort controller (if any was registered by the
          // toolSignalProvider during workspace_research tool invocation). Safe to
          // call when nothing is registered.
          sessionAbortRegistry.unregister(session.id)
        }
      }
    )

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
        channelStreamId,
      })
      if (result.status === "completed") {
        trace.notifyCompleted()
      } else if (result.status === "failed") {
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
      return { messageIds: [], nextIndex: 0 }
    }

    const messagesById = await MessageRepository.findByIds(db, candidateMessageIds)
    const reusableMessageIds = candidateMessageIds.filter((id) => {
      const message = messagesById.get(id)
      if (!message || message.deletedAt) return false
      return (
        message.streamId === streamId && message.authorType === AuthorTypes.PERSONA && message.authorId === personaId
      )
    })

    return { messageIds: reusableMessageIds, nextIndex: 0 }
  }

  private async reconcileSupersededMessages(params: {
    workspaceId: string
    streamId: string
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

function buildSupersedeRerunSystemPrompt(basePrompt: string, rerunContext?: AgentSessionRerunContext): string {
  const cause =
    rerunContext?.cause === "referenced_message_edited"
      ? "a follow-up (referenced) message was edited"
      : "the invoking message was edited"
  const editedBefore = rerunContext?.editedMessageBefore?.trim()
  const editedAfter = rerunContext?.editedMessageAfter?.trim()

  const changeBlock = [
    `Rerun cause: ${cause}.`,
    `Edited message ID: ${rerunContext?.editedMessageId ?? "unknown"}.`,
    editedBefore ? `Before edit: "${editedBefore}"` : null,
    editedAfter ? `After edit: "${editedAfter}"` : null,
    rerunContext?.editedMessageRevision ? `Edited message revision: ${rerunContext.editedMessageRevision}.` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n")

  return `${basePrompt}

## Superseded Session Reconciliation

This run supersedes a previous completed session because conversation context changed after completion.
${changeBlock}

For the final outcome:
- Compare the previous response(s) against the edited context and current conversation state.
- Treat the edited message text as the authoritative user intent. The prior wording is obsolete.
- If any previous response is now incorrect, contradictory, or misses a new constraint, call \`send_message\` with the revised response.
- When updating, answer the edited request directly with concrete help. Do not ask the user to reconfirm the edited intent unless the edited prompt is genuinely ambiguous or missing required constraints.
- For "best" or singular requests, provide one clear recommendation first (with practical details), then optional alternatives.
- If the edited request is concrete (for example noun/topic substitutions), do not reply with only a clarification question.
- Avoid meta narration about the edit itself (for example "I see your message was edited") unless the user explicitly asks about that process.
- If the previous response should stay exactly as-is, call \`keep_response\` with a specific reason that references what changed and why no update is needed.
- Never use both \`keep_response\` and \`send_message\` for the same final decision.
- Do not end your turn without calling exactly one of \`keep_response\` or \`send_message\`.`
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
