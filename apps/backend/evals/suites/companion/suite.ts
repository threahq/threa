/**
 * Companion Agent Evaluation Suite
 *
 * Tests the companion agent's response quality across different contexts.
 * Uses the PRODUCTION PersonaAgent.run() directly - no duplicated prompts or graphs.
 *
 * ## Usage
 *
 *   # Run all companion tests
 *   bun run eval -- -s companion
 *
 *   # Run specific cases
 *   bun run eval -- -s companion -c scratchpad-companion-greeting-001
 *
 *   # Compare models
 *   bun run eval -- -s companion -m openrouter:anthropic/claude-haiku-4.5,openrouter:openai/gpt-5.4-nano
 *
 * ## Case ID Format
 *
 * Case IDs follow the pattern: {stream_type}-{trigger}-{category}-{number}
 * Examples:
 *   - scratchpad-companion-greeting-001
 *   - channel-mention-help-001
 *   - dm-companion-casual-001
 */

import type { EvalSuite, EvalContext } from "../../framework/types"
import { companionCases, type CompanionInput, type CompanionExpected } from "./cases"
import type { CompanionOutput, CompanionMessage } from "./types"
import {
  shouldRespondEvaluator,
  contentContainsEvaluator,
  contentNotContainsEvaluator,
  brevityEvaluator,
  asksQuestionEvaluator,
  webSearchUsageEvaluator,
  webSearchQueryEvaluator,
  createResponseQualityEvaluator,
  createToneEvaluator,
  accuracyEvaluator,
  responseDecisionAccuracyEvaluator,
  averageQualityEvaluator,
} from "./evaluators"
import {
  ARIADNE_AGENT_ID,
  COMPANION_MODEL_ID,
  COMPANION_TEMPERATURE,
  COMPANION_SUMMARY_MODEL_ID,
  COMPANION_SUMMARY_TEMPERATURE,
  PersonaAgent,
  type PersonaAgentInput,
  type PersonaAgentDeps,
  WorkspaceAgent,
  PersonaRepository,
  TraceEmitter,
  SessionAbortRegistry,
  ConversationSummaryService,
  AgentSessionRepository,
} from "../../../src/features/agents"
import { AttachmentService, createMalwareScanner } from "../../../src/features/attachments"
import { SearchService } from "../../../src/features/search"
import { UserPreferencesService } from "../../../src/features/user-preferences"
import { EmbeddingService, MemoExplorerService, MemoReranker } from "../../../src/features/memos"
import { StreamRepository, StreamMemberRepository } from "../../../src/features/streams"
import { MessageRepository } from "../../../src/features/messaging"
import { createModelRegistry } from "../../../src/lib/ai/model-registry"
import type { StorageProvider } from "../../../src/lib/storage/s3-client"
import { EventService } from "../../../src/features/messaging"
import type { Server } from "socket.io"
import { parseMarkdown } from "@threa/prosemirror"
import { AuthorTypes, AgentTriggers, StreamTypes } from "@threa/types"
import { ulid } from "ulid"
import { personaId as generatePersonaId, streamId as generateStreamId } from "../../../src/lib/id"

/**
 * Get model configuration from context.
 * Uses permutation override if provided, otherwise production defaults.
 */
function getModelConfig(ctx: EvalContext): { model: string; temperature: number } {
  const override = ctx.componentOverrides?.["companion"]
  return {
    model: override?.model ?? ctx.permutation.model,
    temperature: override?.temperature ?? ctx.permutation.temperature ?? COMPANION_TEMPERATURE,
  }
}

const STREAM_TYPE_TO_DB_STREAM_TYPE: Record<
  CompanionInput["streamType"],
  (typeof StreamTypes)[keyof typeof StreamTypes]
> = {
  scratchpad: StreamTypes.SCRATCHPAD,
  channel: StreamTypes.CHANNEL,
  thread: StreamTypes.THREAD,
  dm: StreamTypes.DM,
  system: StreamTypes.SYSTEM,
}

function mapStreamTypeToDbStreamType(
  streamType: CompanionInput["streamType"]
): (typeof StreamTypes)[keyof typeof StreamTypes] {
  return STREAM_TYPE_TO_DB_STREAM_TYPE[streamType]
}

/**
 * Set up test data for a companion eval case.
 * Creates a workspace-scoped eval persona row, stream, and trigger message.
 * Prompt text and tools come from the built-in Ariadne config (see `built-in-agents.ts`),
 * merged with any workspace agent overrides — same resolution as production.
 */
async function setupTestData(
  input: CompanionInput,
  ctx: EvalContext
): Promise<{
  personaId: string
  streamId: string
  messageId: string
}> {
  const pool = ctx.pool
  const modelConfig = getModelConfig(ctx)

  // Resolve Ariadne as production does: built-in defaults in code plus optional workspace overrides.
  const templatePersona = await PersonaRepository.findById(pool, ARIADNE_AGENT_ID, ctx.workspaceId)
  if (!templatePersona) {
    throw new Error(`Could not resolve built-in companion persona ${ARIADNE_AGENT_ID} (see built-in-agents.ts)`)
  }
  if (!templatePersona.systemPrompt) {
    throw new Error(`Built-in companion persona ${ARIADNE_AGENT_ID} has no system prompt`)
  }

  // Create a test persona row with the resolved prompt and tools but the eval permutation model.
  const testPersonaId = generatePersonaId()
  await pool.query(
    `
    INSERT INTO personas (id, workspace_id, slug, name, description, avatar_emoji, system_prompt, model, enabled_tools, managed_by, status)
    VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, 'system', 'active')
    ON CONFLICT (slug, workspace_id) WHERE workspace_id IS NULL DO UPDATE SET
      model = EXCLUDED.model,
      system_prompt = EXCLUDED.system_prompt
  `,
    [
      testPersonaId,
      `eval-ariadne-${ulid().toLowerCase().slice(0, 8)}`,
      "Ariadne (Eval)",
      templatePersona.description,
      templatePersona.avatarEmoji,
      templatePersona.systemPrompt,
      modelConfig.model,
      templatePersona.enabledTools ?? ["send_message"],
    ]
  )

  // Map stream type from eval input to database type
  const dbStreamType = mapStreamTypeToDbStreamType(input.streamType)

  // Create the stream
  const testStreamId = generateStreamId()
  await StreamRepository.insert(pool, {
    id: testStreamId,
    workspaceId: ctx.workspaceId,
    type: dbStreamType,
    displayName: input.streamContext?.name ?? `Eval ${input.streamType}`,
    slug: input.streamType === "channel" ? `eval-${ulid().toLowerCase().slice(0, 8)}` : undefined,
    description: input.streamContext?.description,
    visibility: "private",
    companionMode: input.trigger === "companion" ? "on" : "off",
    companionPersonaId: input.trigger === "companion" ? testPersonaId : undefined,
    createdBy: ctx.userId,
  })

  // Add user as stream member
  await StreamMemberRepository.insert(pool, testStreamId, ctx.userId)

  // Create event service for message creation
  const eventService = new EventService(pool)

  const userPreferencesService = new UserPreferencesService(pool)
  await userPreferencesService.updatePreferences(ctx.workspaceId, ctx.userId, { timezone: input.timezone ?? "UTC" })

  const setMessageCreatedAt = async (messageId: string, createdAt: string): Promise<void> => {
    const date = new Date(createdAt)
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid eval message createdAt: ${createdAt}`)
    }
    await pool.query(`UPDATE messages SET created_at = $1 WHERE id = $2`, [date, messageId])
  }

  const seedConversationHistory = async (
    targetStreamId: string,
    history: Array<{ role: "user" | "assistant"; content: string; createdAt?: string }>,
    pinTimeIso?: string
  ): Promise<void> => {
    const pinMs = pinTimeIso ? new Date(pinTimeIso).getTime() : undefined
    if (pinTimeIso && pinMs !== undefined && Number.isNaN(pinMs)) {
      throw new Error(`Invalid eval pin time for seeded history: ${pinTimeIso}`)
    }
    for (let i = 0; i < history.length; i++) {
      const msg = history[i]
      const authorId = msg.role === "user" ? ctx.userId : testPersonaId
      const authorType = msg.role === "user" ? AuthorTypes.USER : AuthorTypes.PERSONA
      const message = await eventService.createMessage({
        workspaceId: ctx.workspaceId,
        streamId: targetStreamId,
        authorId,
        authorType,
        contentJson: parseMarkdown(msg.content),
        contentMarkdown: msg.content,
      })
      const syntheticCreatedAt =
        msg.createdAt ?? (pinMs !== undefined ? new Date(pinMs - (history.length - i) * 1000).toISOString() : undefined)
      if (syntheticCreatedAt) {
        await setMessageCreatedAt(message.id, syntheticCreatedAt)
      }
    }
  }

  // Create conversation history if provided
  if (input.conversationHistory && input.conversationHistory.length > 0) {
    await seedConversationHistory(testStreamId, input.conversationHistory, input.currentTime)
  }

  // Seed additional workspace context in separate streams for cross-stream retrieval tests
  if (input.workspaceContext && input.workspaceContext.length > 0) {
    for (const contextStream of input.workspaceContext) {
      const contextStreamId = generateStreamId()
      await StreamRepository.insert(pool, {
        id: contextStreamId,
        workspaceId: ctx.workspaceId,
        type: mapStreamTypeToDbStreamType(contextStream.streamType ?? "scratchpad"),
        displayName: contextStream.name ?? `Eval Context ${ulid().toLowerCase().slice(0, 6)}`,
        slug: contextStream.streamType === "channel" ? `eval-context-${ulid().toLowerCase().slice(0, 8)}` : undefined,
        description: contextStream.description,
        visibility: "private",
        companionMode: "off",
        createdBy: ctx.userId,
      })

      await StreamMemberRepository.insert(pool, contextStreamId, ctx.userId)
      await seedConversationHistory(contextStreamId, contextStream.conversationHistory, input.currentTime)
    }
  }

  // Create the trigger message
  const triggerMessage = await eventService.createMessage({
    workspaceId: ctx.workspaceId,
    streamId: testStreamId,
    authorId: ctx.userId,
    authorType: AuthorTypes.USER,
    contentJson: parseMarkdown(input.message),
    contentMarkdown: input.message,
  })
  if (input.currentTime) {
    await setMessageCreatedAt(triggerMessage.id, input.currentTime)
  }

  return {
    personaId: testPersonaId,
    streamId: testStreamId,
    messageId: triggerMessage.id,
  }
}

/**
 * Task function that runs the companion agent using production code paths.
 *
 * Uses PersonaAgent.run() directly - the same code path as production.
 * No duplicated prompts, no manual graph creation.
 */
async function runCompanionTask(input: CompanionInput, ctx: EvalContext): Promise<CompanionOutput> {
  // Skip empty messages
  if (!input.message.trim()) {
    return {
      input,
      messages: [],
      responded: false,
    }
  }

  try {
    if (!ctx.credentials.tavilyApiKey) {
      throw new Error("TAVILY_API_KEY is required for companion evals to run with full web_search tool access")
    }

    // Set up test data in the database
    const { personaId, streamId, messageId } = await setupTestData(input, ctx)
    let createdThreadId: string | undefined

    // Create dependencies for PersonaAgent
    const embeddingService = new EmbeddingService({ ai: ctx.ai })
    const userPreferencesService = new UserPreferencesService(ctx.pool)
    const workspaceAgent = new WorkspaceAgent({
      pool: ctx.pool,
      ai: ctx.ai,
      configResolver: ctx.configResolver,
      embeddingService,
    })
    const searchService = new SearchService({
      pool: ctx.pool,
      embeddingService,
    })
    const memoExplorerService = new MemoExplorerService({
      pool: ctx.pool,
      embeddingService,
      reranker: new MemoReranker({ ai: ctx.ai }),
    })

    // Stub Socket.io server for tracing - evals don't need real-time updates
    const stubIo = { to: () => ({ to: () => ({ emit: () => {} }), emit: () => {} }) } as unknown as Server
    const traceEmitter = new TraceEmitter({ io: stubIo, pool: ctx.pool })

    // Create message and thread callbacks using EventService
    const evalEventService = new EventService(ctx.pool)

    const createMessage: PersonaAgentDeps["createMessage"] = async (params) => {
      const message = await evalEventService.createMessage({
        workspaceId: params.workspaceId,
        streamId: params.streamId,
        authorId: params.authorId,
        authorType: params.authorType,
        contentJson: parseMarkdown(params.content),
        contentMarkdown: params.content,
        sources: params.sources,
      })
      return { id: message.id }
    }

    const editMessage: PersonaAgentDeps["editMessage"] = async (params) => {
      const message = await evalEventService.editMessage({
        workspaceId: params.workspaceId,
        streamId: params.streamId,
        messageId: params.messageId,
        contentJson: parseMarkdown(params.content),
        contentMarkdown: params.content,
        actorId: params.actorId,
        actorType: "persona",
      })
      return message ? { id: message.id } : null
    }

    const deleteMessage: PersonaAgentDeps["deleteMessage"] = async (params) => {
      const message = await evalEventService.deleteMessage({
        workspaceId: params.workspaceId,
        streamId: params.streamId,
        messageId: params.messageId,
        actorId: params.actorId,
        actorType: "persona",
      })
      return message ? { id: message.id } : null
    }

    const createThread: PersonaAgentDeps["createThread"] = async (params) => {
      // For evals, we don't actually need threads - return a mock
      const threadId = generateStreamId()
      await StreamRepository.insert(ctx.pool, {
        id: threadId,
        workspaceId: params.workspaceId,
        type: StreamTypes.THREAD,
        visibility: "private",
        companionMode: "off",
        createdBy: params.createdBy,
        parentStreamId: params.parentStreamId,
        parentMessageId: params.parentMessageId,
      })
      createdThreadId = threadId
      return { id: threadId }
    }

    // Stub storage and attachment service — evals don't upload or load attachments from S3
    const stubStorage: StorageProvider = {
      getObjectSize: async () => 0,
      getSignedDownloadUrl: async () => "",
      getObject: async () => Buffer.alloc(0),
      getObjectRange: async () => Buffer.alloc(0),
      getObjectStream: async () => {
        throw new Error("Not implemented in stub")
      },
      putObject: async () => {},
      delete: async () => {},
    }

    // Create PersonaAgent with real dependencies
    const conversationSummaryService = new ConversationSummaryService({
      ai: ctx.ai,
      modelId: COMPANION_SUMMARY_MODEL_ID,
      temperature: COMPANION_SUMMARY_TEMPERATURE,
    })
    const attachmentService = new AttachmentService(
      ctx.pool,
      stubStorage,
      createMalwareScanner(stubStorage, { malwareScanEnabled: false })
    )
    const personaAgent = new PersonaAgent({
      pool: ctx.pool,
      ai: ctx.ai,
      traceEmitter,
      sessionAbortRegistry: new SessionAbortRegistry(),
      userPreferencesService,
      workspaceAgent,
      searchService,
      conversationSummaryService,
      attachmentService,
      memoExplorerService,
      storage: stubStorage,
      modelRegistry: createModelRegistry(),
      tavilyApiKey: ctx.credentials.tavilyApiKey,
      createMessage,
      editMessage,
      deleteMessage,
      createThread,
    })

    // Build PersonaAgentInput
    const agentInput: PersonaAgentInput = {
      workspaceId: ctx.workspaceId,
      streamId,
      messageId,
      personaId,
      serverId: `eval-server-${ulid()}`,
      trigger: input.trigger === "mention" ? AgentTriggers.MENTION : undefined,
      currentTime: input.currentTime ? new Date(input.currentTime) : undefined,
    }

    // Run the agent!
    const runResult = await personaAgent.run(agentInput)

    // Read back messages sent by the agent.
    // Mention-triggered responses are posted in the spawned thread stream.
    const responseStreamId = input.trigger === "mention" && createdThreadId ? createdThreadId : streamId
    const allMessages = await MessageRepository.list(ctx.pool, responseStreamId, { limit: 100 })
    const agentMessages = allMessages.filter((m) => m.authorId === personaId)

    const messages: CompanionMessage[] = agentMessages.map((m) => ({
      content: m.contentMarkdown,
      // Sources are stored in contentJson but we just need content for evals
    }))

    const toolCalls =
      runResult.sessionId == null
        ? []
        : (await AgentSessionRepository.findStepsBySession(ctx.pool, runResult.sessionId))
            .filter((step) => step.stepType === "web_search")
            .map((step) => ({
              name: "web_search",
              args: { query: typeof step.content === "string" ? step.content : undefined },
            }))

    return {
      input,
      messages,
      responded: messages.length > 0,
      toolCalls,
    }
  } catch (error) {
    return {
      input,
      messages: [],
      responded: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Companion Agent Evaluation Suite
 */
export const companionSuite: EvalSuite<CompanionInput, CompanionOutput, CompanionExpected> = {
  name: "companion",
  description: "Evaluates companion agent response quality across different contexts",

  cases: companionCases,

  task: runCompanionTask,

  evaluators: [
    shouldRespondEvaluator,
    contentContainsEvaluator,
    contentNotContainsEvaluator,
    brevityEvaluator,
    asksQuestionEvaluator,
    webSearchUsageEvaluator,
    webSearchQueryEvaluator,
    createResponseQualityEvaluator(),
    createToneEvaluator(),
  ],

  runEvaluators: [accuracyEvaluator, responseDecisionAccuracyEvaluator, averageQualityEvaluator],

  defaultPermutations: [
    {
      model: COMPANION_MODEL_ID,
      temperature: COMPANION_TEMPERATURE,
    },
  ],
}

export default companionSuite
