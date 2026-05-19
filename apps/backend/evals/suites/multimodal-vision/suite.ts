/**
 * Multimodal Vision Evaluation Suite
 *
 * Tests the agent's ability to see and understand images when using vision-capable models.
 * Uses the PRODUCTION PersonaAgent.run() directly - no duplicated prompts or graphs.
 *
 * ## Usage
 *
 *   # Run all vision tests
 *   bun run eval -- -s multimodal-vision
 *
 *   # Run specific cases
 *   bun run eval -- -s multimodal-vision -c vision-red-square-001
 *
 *   # Compare vision models
 *   bun run eval -- -s multimodal-vision -m openrouter:anthropic/claude-sonnet-4.5,openrouter:google/gemini-2.5-flash
 *
 * ## Case ID Format
 *
 * Case IDs follow the pattern: vision-{description}-{number}
 * Examples:
 *   - vision-red-square-001
 *   - vision-describe-image-001
 */

import type { EvalSuite, EvalContext } from "../../framework/types"
import { multimodalVisionCases, type MultimodalVisionInput, type MultimodalVisionExpected } from "./cases"
import type { MultimodalVisionOutput, VisionMessage } from "./types"
import {
  respondedEvaluator,
  contentMentionsEvaluator,
  noHallucinationEvaluator,
  createImageUnderstandingEvaluator,
  visionAccuracyEvaluator,
  averageUnderstandingEvaluator,
  hallucinationRateEvaluator,
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
} from "../../../src/features/agents"
import { SearchService } from "../../../src/features/search"
import { UserPreferencesService } from "../../../src/features/user-preferences"
import { EmbeddingService, MemoExplorerService, MemoReranker } from "../../../src/features/memos"
import { StreamRepository, StreamMemberRepository } from "../../../src/features/streams"
import { MessageRepository, EventService } from "../../../src/features/messaging"
import {
  AttachmentRepository,
  AttachmentExtractionRepository,
  AttachmentService,
  createMalwareScanner,
} from "../../../src/features/attachments"
import { createModelRegistry, type ModelRegistry } from "../../../src/lib/ai/model-registry"
import type { StorageProvider } from "../../../src/lib/storage/s3-client"
import type { Server } from "socket.io"
import { parseMarkdown } from "@threa/prosemirror"
import { AuthorTypes, StreamTypes, ExtractionContentTypes, ProcessingStatuses } from "@threa/types"
import { ulid } from "ulid"
import {
  personaId as generatePersonaId,
  streamId as generateStreamId,
  attachmentId as generateAttachmentId,
  extractionId as generateExtractionId,
} from "../../../src/lib/id"

/** Default vision model for eval (must support image input) */
const VISION_MODEL_ID = "openrouter:anthropic/claude-sonnet-4.5"

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

/**
 * Create a mock storage provider that returns images from a map.
 * Used for eval to avoid needing real S3/MinIO.
 */
function createMockStorage(images: Map<string, Buffer>): StorageProvider {
  return {
    async getObjectSize(key: string): Promise<number> {
      const buffer = images.get(key)
      if (!buffer) {
        throw new Error(`Mock storage: key not found: ${key}`)
      }
      return buffer.length
    },
    async getSignedDownloadUrl(key: string): Promise<string> {
      return `mock://storage/${key}`
    },
    async getObject(key: string): Promise<Buffer> {
      const buffer = images.get(key)
      if (!buffer) {
        throw new Error(`Mock storage: key not found: ${key}`)
      }
      return buffer
    },
    async getObjectRange(key: string, start: number, end: number): Promise<Buffer> {
      const buffer = images.get(key)
      if (!buffer) {
        throw new Error(`Mock storage: key not found: ${key}`)
      }
      return buffer.subarray(start, end + 1)
    },
    async getObjectStream(): Promise<never> {
      throw new Error("Not implemented in mock")
    },
    async putObject(): Promise<void> {
      // No-op for mock
    },
    async delete(): Promise<void> {
      // No-op for mock
    },
  }
}

/**
 * Set up test data for a multimodal vision eval case.
 * Creates eval persona row, stream, trigger message with image attachment, and populates mock storage.
 * Template config comes from built-in Ariadne (`built-in-agents.ts`) plus workspace overrides.
 */
async function setupTestData(
  input: MultimodalVisionInput,
  ctx: EvalContext,
  mockImages: Map<string, Buffer>
): Promise<{
  personaId: string
  streamId: string
  messageId: string
}> {
  const pool = ctx.pool
  const modelConfig = getModelConfig(ctx)

  const templatePersona = await PersonaRepository.findById(pool, ARIADNE_AGENT_ID, ctx.workspaceId)
  if (!templatePersona) {
    throw new Error(`Could not resolve built-in companion persona ${ARIADNE_AGENT_ID} (see built-in-agents.ts)`)
  }
  if (!templatePersona.systemPrompt) {
    throw new Error(`Built-in companion persona ${ARIADNE_AGENT_ID} has no system prompt`)
  }

  // Copy resolved config into a throwaway row with the eval permutation model (vision-capable).
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
      `eval-vision-${ulid().toLowerCase().slice(0, 8)}`,
      "Ariadne (Vision Eval)",
      templatePersona.description,
      templatePersona.avatarEmoji,
      templatePersona.systemPrompt,
      modelConfig.model,
      templatePersona.enabledTools ?? ["send_message"],
    ]
  )

  // Create a scratchpad stream (simplest context for vision testing)
  const testStreamId = generateStreamId()
  await StreamRepository.insert(pool, {
    id: testStreamId,
    workspaceId: ctx.workspaceId,
    type: StreamTypes.SCRATCHPAD,
    displayName: `Vision Eval ${ulid().toLowerCase().slice(0, 8)}`,
    visibility: "private",
    companionMode: "on",
    companionPersonaId: testPersonaId,
    createdBy: ctx.userId,
  })

  // Add user as stream member
  await StreamMemberRepository.insert(pool, testStreamId, ctx.userId)

  // Create event service for message creation
  const eventService = new EventService(pool)

  // Create the trigger message
  const triggerMessage = await eventService.createMessage({
    workspaceId: ctx.workspaceId,
    streamId: testStreamId,
    authorId: ctx.userId,
    authorType: AuthorTypes.USER,
    contentJson: parseMarkdown(input.message),
    contentMarkdown: input.message,
  })

  // Create attachment record for the image
  const testAttachmentId = generateAttachmentId()
  const storagePath = `eval/${testAttachmentId}/${input.imageFilename}`

  // Decode base64 and store in mock storage
  const imageBuffer = Buffer.from(input.imageBase64, "base64")
  mockImages.set(storagePath, imageBuffer)

  // Insert attachment record
  await AttachmentRepository.insert(pool, {
    id: testAttachmentId,
    workspaceId: ctx.workspaceId,
    streamId: testStreamId,
    uploadedBy: ctx.userId,
    filename: input.imageFilename,
    mimeType: input.imageMimeType,
    sizeBytes: imageBuffer.length,
    storagePath,
    storageProvider: "s3",
  })

  // Attach to message
  await AttachmentRepository.attachToMessage(pool, [testAttachmentId], triggerMessage.id, testStreamId)

  // Mark as processed (so it's ready for agent)
  await AttachmentRepository.updateProcessingStatus(pool, testAttachmentId, ProcessingStatuses.COMPLETED)

  // Create an extraction record with image caption (simulating what the image processing pipeline would create)
  await AttachmentExtractionRepository.insert(pool, {
    id: generateExtractionId(),
    attachmentId: testAttachmentId,
    workspaceId: ctx.workspaceId,
    contentType: ExtractionContentTypes.PHOTO,
    summary: input.imageDescription,
    fullText: null,
  })

  return {
    personaId: testPersonaId,
    streamId: testStreamId,
    messageId: triggerMessage.id,
  }
}

/**
 * Task function that runs the persona agent using production code paths.
 *
 * Uses PersonaAgent.run() directly - the same code path as production (INV-45).
 * No duplicated prompts, no manual graph creation.
 */
async function runVisionTask(input: MultimodalVisionInput, ctx: EvalContext): Promise<MultimodalVisionOutput> {
  if (!input.message.trim()) {
    return {
      input,
      messages: [],
      responded: false,
      error: "Empty message",
    }
  }

  // Mock storage for this case's images
  const mockImages = new Map<string, Buffer>()

  try {
    // Set up test data in the database
    const { personaId, streamId, messageId } = await setupTestData(input, ctx, mockImages)

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

    // Mock storage provider that returns our test images
    const mockStorage = createMockStorage(mockImages)
    const attachmentService = new AttachmentService(
      ctx.pool,
      mockStorage,
      createMalwareScanner(mockStorage, { malwareScanEnabled: false })
    )

    // Model registry for vision capability checks
    const modelRegistry = createModelRegistry()

    // Stub Socket.io server for tracing
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
      return { id: threadId }
    }

    // Create PersonaAgent with real dependencies including vision support
    const conversationSummaryService = new ConversationSummaryService({
      ai: ctx.ai,
      modelId: COMPANION_SUMMARY_MODEL_ID,
      temperature: COMPANION_SUMMARY_TEMPERATURE,
    })
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
      storage: mockStorage,
      modelRegistry,
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
      trigger: undefined, // Companion mode
    }

    // Run the agent!
    await personaAgent.run(agentInput)

    // Read back messages sent by the agent
    const allMessages = await MessageRepository.list(ctx.pool, streamId, { limit: 100 })
    const agentMessages = allMessages.filter((m) => m.authorId === personaId)

    const messages: VisionMessage[] = agentMessages.map((m) => ({
      content: m.contentMarkdown,
    }))

    return {
      input,
      messages,
      responded: messages.length > 0,
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
 * Multimodal Vision Evaluation Suite
 */
export const multimodalVisionSuite: EvalSuite<MultimodalVisionInput, MultimodalVisionOutput, MultimodalVisionExpected> =
  {
    name: "multimodal-vision",
    description: "Evaluates agent ability to see and understand images with vision-capable models",

    cases: multimodalVisionCases,

    task: runVisionTask,

    evaluators: [
      respondedEvaluator,
      contentMentionsEvaluator,
      noHallucinationEvaluator,
      createImageUnderstandingEvaluator(),
    ],

    runEvaluators: [visionAccuracyEvaluator, averageUnderstandingEvaluator, hallucinationRateEvaluator],

    defaultPermutations: [
      {
        model: VISION_MODEL_ID,
        temperature: COMPANION_TEMPERATURE,
      },
    ],
  }

export default multimodalVisionSuite
