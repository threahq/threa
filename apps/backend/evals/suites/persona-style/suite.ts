/**
 * Persona-Style Evaluation Suite (roadmap 7.1)
 *
 * Proves each authored Tone/Brevity slot fragment actually shifts the companion's
 * output. Each case seeds a private scratchpad whose companion persona carries the
 * fragment text in its style slots, then runs the PRODUCTION PersonaAgent.run() —
 * the same path a live turn takes, so the reply flows through the real
 * `resolvePersonaStyleSlots` → `buildResponseStyleSection` → `buildSystemPrompt`
 * assembly (INV-45). No web tools are enabled (send_message only), so there is no
 * Tavily dependency.
 *
 * The persona's slots are seeded as free-text (`tone_prompt`/`brevity_prompt`)
 * materialized from the preset fragment maps in `companion/config.ts` — the exact
 * text a forked custom persona would carry, and the exact text a built-in's preset
 * resolves to. Fragments are imported from that one source (INV-44), never
 * re-authored.
 *
 * ## Usage
 *
 *   bun run eval -- -s persona-style
 *   bun run eval -- -s persona-style -c tone-warm-001
 */

import { ulid } from "ulid"
import type { EvalSuite, EvalContext } from "../../framework/types"
import { personaStyleCases } from "./cases"
import type { PersonaStyleInput, PersonaStyleOutput, PersonaStyleExpected } from "./types"
import {
  shouldRespondEvaluator,
  brevityBandEvaluator,
  createToneAdherenceEvaluator,
  brevityOrderingEvaluator,
  styleAccuracyEvaluator,
} from "./evaluators"
import { PERSONA_STYLE_MODEL_ID, PERSONA_STYLE_TEMPERATURE } from "./config"
import {
  ARIADNE_AGENT_ID,
  COMPANION_SUMMARY_MODEL_ID,
  COMPANION_SUMMARY_TEMPERATURE,
  TONE_PRESET_FRAGMENTS,
  BREVITY_PRESET_FRAGMENTS,
  PersonaAgent,
  type PersonaAgentInput,
  type PersonaAgentDeps,
  WorkspaceAgent,
  GeneralResearcher,
  PersonaRepository,
  TraceEmitter,
  SessionAbortRegistry,
  ConversationSummaryService,
} from "../../../src/features/agents"
import { AttachmentService, createMalwareScanner } from "../../../src/features/attachments"
import { SearchService, SearchQueryExpander, SearchSteerer } from "../../../src/features/search"
import { UserPreferencesService } from "../../../src/features/user-preferences"
import { EmbeddingService, MemoExplorerService, Reranker } from "../../../src/features/memos"
import { StreamRepository, StreamMemberRepository } from "../../../src/features/streams"
import { EventService, MessageRepository } from "../../../src/features/messaging"
import { createModelRegistry } from "@threa/agent-runtime"
import type { StorageProvider } from "../../../src/lib/storage/s3-client"
import type { Server } from "socket.io"
import { parseMarkdown } from "@threa/prosemirror"
import { AuthorTypes, StreamTypes } from "@threa/types"
import { personaId as generatePersonaId, streamId as generateStreamId } from "../../../src/lib/id"

/** Fixed clock so the agent's temporal grounding is reproducible. */
const EVAL_CLOCK = new Date("2026-07-01T12:00:00Z")

function getModelConfig(ctx: EvalContext): { model: string; temperature: number } {
  const override = ctx.componentOverrides?.["companion"]
  return {
    model: override?.model ?? ctx.permutation.model,
    temperature: override?.temperature ?? ctx.permutation.temperature ?? PERSONA_STYLE_TEMPERATURE,
  }
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length
}

/**
 * Seed a private scratchpad whose companion persona carries the case's style
 * slots. The persona reuses Ariadne's resolved system prompt (so the assembly is
 * realistic) but only the send_message tool (no web tools → no Tavily). Tone and
 * brevity slots are materialized from the preset fragment maps.
 */
async function setupTestData(
  input: PersonaStyleInput,
  ctx: EvalContext
): Promise<{ personaId: string; streamId: string; messageId: string }> {
  const pool = ctx.pool
  const modelConfig = getModelConfig(ctx)

  const templatePersona = await PersonaRepository.findById(pool, ARIADNE_AGENT_ID, ctx.workspaceId)
  if (!templatePersona?.systemPrompt) {
    throw new Error(`Could not resolve built-in companion persona ${ARIADNE_AGENT_ID} (see built-in-agents.ts)`)
  }

  const tonePrompt = input.tonePreset ? TONE_PRESET_FRAGMENTS[input.tonePreset] : null
  const brevityPrompt = input.brevityPreset ? BREVITY_PRESET_FRAGMENTS[input.brevityPreset] : null

  const testPersonaId = generatePersonaId()
  await pool.query(
    `
    INSERT INTO personas (
      id, workspace_id, slug, name, description, avatar_emoji, system_prompt, model,
      enabled_tools, tone_prompt, brevity_prompt, managed_by, status
    )
    VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'system', 'active')
  `,
    [
      testPersonaId,
      `eval-style-${ulid().toLowerCase().slice(0, 8)}`,
      "Ariadne (Style Eval)",
      templatePersona.description,
      templatePersona.avatarEmoji,
      templatePersona.systemPrompt,
      modelConfig.model,
      ["send_message"],
      tonePrompt,
      brevityPrompt,
    ]
  )

  const testStreamId = generateStreamId()
  await StreamRepository.insert(pool, {
    id: testStreamId,
    workspaceId: ctx.workspaceId,
    type: StreamTypes.SCRATCHPAD,
    displayName: "Eval scratchpad",
    visibility: "private",
    companionMode: "on",
    companionPersonaId: testPersonaId,
    createdBy: ctx.userId,
  })
  await StreamMemberRepository.insert(pool, testStreamId, ctx.userId)

  const userPreferencesService = new UserPreferencesService(pool)
  await userPreferencesService.updatePreferences(ctx.workspaceId, ctx.userId, { timezone: "UTC" })

  const eventService = new EventService(pool)
  const triggerMessage = await eventService.createMessage({
    workspaceId: ctx.workspaceId,
    streamId: testStreamId,
    authorId: ctx.userId,
    authorType: AuthorTypes.USER,
    contentJson: parseMarkdown(input.message),
    contentMarkdown: input.message,
  })

  return { personaId: testPersonaId, streamId: testStreamId, messageId: triggerMessage.id }
}

async function runPersonaStyleTask(input: PersonaStyleInput, ctx: EvalContext): Promise<PersonaStyleOutput> {
  try {
    const { personaId, streamId, messageId } = await setupTestData(input, ctx)

    const embeddingService = new EmbeddingService({ ai: ctx.ai })
    const userPreferencesService = new UserPreferencesService(ctx.pool)
    const workspaceAgent = new WorkspaceAgent({
      pool: ctx.pool,
      ai: ctx.ai,
      configResolver: ctx.configResolver,
      embeddingService,
    })
    const generalResearcher = new GeneralResearcher({ ai: ctx.ai, configResolver: ctx.configResolver })
    const memoExplorerService = new MemoExplorerService({
      pool: ctx.pool,
      embeddingService,
      reranker: new Reranker({ ai: ctx.ai, subject: "knowledge memos", functionId: "memo-rerank" }),
    })
    const searchService = new SearchService({
      pool: ctx.pool,
      embeddingService,
      queryExpander: new SearchQueryExpander({ ai: ctx.ai }),
      reranker: new Reranker({ ai: ctx.ai, subject: "chat messages", functionId: "search-rerank" }),
      memoSearch: memoExplorerService,
      steerer: new SearchSteerer({ ai: ctx.ai }),
    })
    const conversationSummaryService = new ConversationSummaryService({
      ai: ctx.ai,
      modelId: COMPANION_SUMMARY_MODEL_ID,
      temperature: COMPANION_SUMMARY_TEMPERATURE,
    })

    const stubIo = { to: () => ({ to: () => ({ emit: () => {} }), emit: () => {} }) } as unknown as Server
    const traceEmitter = new TraceEmitter({ io: stubIo, pool: ctx.pool })

    const stubStorage: StorageProvider = {
      getObjectSize: async () => 0,
      getObjectStat: async () => ({ sizeBytes: 0, etag: "stub-etag" }),
      getSignedDownloadUrl: async () => "",
      getObject: async () => Buffer.alloc(0),
      getObjectRange: async () => Buffer.alloc(0),
      getObjectStream: async () => {
        throw new Error("Not implemented in stub")
      },
      getObjectContent: async () => {
        throw new Error("Not implemented in stub")
      },
      putObject: async () => {},
      delete: async () => {},
      copyObject: async () => {},
    }
    const attachmentService = new AttachmentService(
      ctx.pool,
      stubStorage,
      createMalwareScanner(stubStorage, { malwareScanEnabled: false })
    )

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

    const personaAgent = new PersonaAgent({
      configResolver: ctx.configResolver,
      pool: ctx.pool,
      ai: ctx.ai,
      traceEmitter,
      sessionAbortRegistry: new SessionAbortRegistry(),
      userPreferencesService,
      workspaceAgent,
      generalResearcher,
      searchService,
      resolveSearchFlag: async () => "on",
      conversationSummaryService,
      attachmentService,
      memoExplorerService,
      storage: stubStorage,
      modelRegistry: createModelRegistry(),
      tavilyApiKey: ctx.credentials.tavilyApiKey,
      createMessage,
      editMessage: async () => null,
      deleteMessage: async () => null,
      addReaction: async () => null,
      removeReaction: async () => null,
      createThread: async () => {
        throw new Error("createThread is not expected in persona-style evals")
      },
    })

    const agentInput: PersonaAgentInput = {
      workspaceId: ctx.workspaceId,
      streamId,
      messageId,
      personaId,
      serverId: `eval-server-${ulid()}`,
      initiatingUserId: ctx.userId,
      purpose: { kind: "catch_up" },
      currentTime: EVAL_CLOCK,
    }
    await personaAgent.run(agentInput)

    const allMessages = await MessageRepository.list(ctx.pool, streamId, { limit: 100 })
    const reply = allMessages
      .filter((m) => m.authorId === personaId)
      .map((m) => m.contentMarkdown)
      .join("\n")
      .trim()

    return {
      input,
      reply,
      responded: reply.length > 0,
      wordCount: countWords(reply),
      charCount: reply.length,
    }
  } catch (error) {
    return {
      input,
      reply: "",
      responded: false,
      wordCount: 0,
      charCount: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export const personaStyleSuite: EvalSuite<PersonaStyleInput, PersonaStyleOutput, PersonaStyleExpected> = {
  name: "persona-style",
  description: "Proves each Tone/Brevity slot fragment shifts companion output style",

  cases: personaStyleCases,

  task: runPersonaStyleTask,

  evaluators: [shouldRespondEvaluator, brevityBandEvaluator, createToneAdherenceEvaluator()],

  runEvaluators: [brevityOrderingEvaluator, styleAccuracyEvaluator],

  defaultPermutations: [
    {
      model: PERSONA_STYLE_MODEL_ID,
      temperature: PERSONA_STYLE_TEMPERATURE,
    },
  ],
}

export default personaStyleSuite
