/**
 * Brief Correction Evaluation Suite
 *
 * Measures whether Ariadne maintains a stream's durable brief correctly across
 * the three arms of the correction loop (roadmap 4.4): she records a stated
 * decision, replaces (not appends) a fact the user reverses, and leaves the
 * brief untouched on chitchat. Runs the PRODUCTION PersonaAgent.run() with the
 * `update_stream_brief` tool wired to the production StreamBriefService (INV-45)
 * — the same path a live companion turn takes — then reads the brief and its
 * revision trail back from the database to grade the outcome.
 *
 * ## Usage
 *
 *   bun run eval -- -s brief-correction
 *   bun run eval -- -s brief-correction -c chitchat-banter-001
 *
 * ## Gates
 *
 * - chitchat-no-write-rate (run-level): ≥90% of chitchat turns leave the brief
 *   untouched — over-eager writes are the failure mode 4.4 targets.
 * - accuracy (run-level): ≥80% of all cases pass every evaluator.
 */

import { ulid } from "ulid"
import type { EvalSuite, EvalContext } from "../../framework/types"
import { briefCorrectionCases } from "./cases"
import type { BriefCorrectionInput, BriefCorrectionOutput, BriefCorrectionExpected } from "./types"
import {
  writeDecisionEvaluator,
  singleRevisionEvaluator,
  briefContentEvaluator,
  accuracyEvaluator,
  chitchatNoWriteRateEvaluator,
} from "./evaluators"
import { COMPANION_MODEL_ID, COMPANION_TEMPERATURE } from "./config"
import {
  ARIADNE_AGENT_ID,
  COMPANION_SUMMARY_MODEL_ID,
  COMPANION_SUMMARY_TEMPERATURE,
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
import { SearchService } from "../../../src/features/search"
import { UserPreferencesService } from "../../../src/features/user-preferences"
import { EmbeddingService, MemoExplorerService, MemoReranker } from "../../../src/features/memos"
import {
  StreamRepository,
  StreamMemberRepository,
  StreamBriefService,
  StreamBriefRepository,
} from "../../../src/features/streams"
import { EventService } from "../../../src/features/messaging"
import { createModelRegistry } from "@threa/agent-runtime"
import type { StorageProvider } from "../../../src/lib/storage/s3-client"
import type { Server } from "socket.io"
import { parseMarkdown } from "@threa/prosemirror"
import { AuthorTypes, StreamTypes } from "@threa/types"
import { personaId as generatePersonaId, streamId as generateStreamId } from "../../../src/lib/id"

function getModelConfig(ctx: EvalContext): { model: string; temperature: number } {
  const override = ctx.componentOverrides?.["companion"]
  return {
    model: override?.model ?? ctx.permutation.model,
    temperature: override?.temperature ?? ctx.permutation.temperature ?? COMPANION_TEMPERATURE,
  }
}

async function countRevisions(ctx: EvalContext, streamId: string): Promise<number> {
  const { rows } = await ctx.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM stream_brief_revisions WHERE stream_id = $1`,
    [streamId]
  )
  return Number(rows[0]?.count ?? "0")
}

/**
 * Seed a private scratchpad with companion mode on, the eval Ariadne persona,
 * optional prior turns and an optional standing brief (as a member edit), then
 * post the trigger message. Mirrors the companion suite's setup, trimmed to the
 * scratchpad-companion path the brief loop lives on.
 */
async function setupTestData(
  input: BriefCorrectionInput,
  ctx: EvalContext
): Promise<{ personaId: string; streamId: string; messageId: string; revisionsBefore: number }> {
  const pool = ctx.pool
  const modelConfig = getModelConfig(ctx)

  const templatePersona = await PersonaRepository.findById(pool, ARIADNE_AGENT_ID, ctx.workspaceId)
  if (!templatePersona?.systemPrompt) {
    throw new Error(`Could not resolve built-in companion persona ${ARIADNE_AGENT_ID} (see built-in-agents.ts)`)
  }

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

  for (const msg of input.conversationHistory ?? []) {
    await eventService.createMessage({
      workspaceId: ctx.workspaceId,
      streamId: testStreamId,
      authorId: msg.role === "user" ? ctx.userId : testPersonaId,
      authorType: msg.role === "user" ? AuthorTypes.USER : AuthorTypes.PERSONA,
      contentJson: parseMarkdown(msg.content),
      contentMarkdown: msg.content,
    })
  }

  // Seed a standing brief as a prior member edit (the contradicts-brief arm).
  if (input.existingBrief) {
    const briefService = new StreamBriefService({ pool })
    const result = await briefService.update({
      workspaceId: ctx.workspaceId,
      streamId: testStreamId,
      content: input.existingBrief,
      expectedVersion: 0,
      updatedByKind: "user",
      updatedById: ctx.userId,
    })
    if (result.outcome !== "updated") {
      throw new Error("Failed to seed the initial brief for a contradicts-brief case")
    }
  }

  const revisionsBefore = await countRevisions(ctx, testStreamId)

  const triggerMessage = await eventService.createMessage({
    workspaceId: ctx.workspaceId,
    streamId: testStreamId,
    authorId: ctx.userId,
    authorType: AuthorTypes.USER,
    contentJson: parseMarkdown(input.message),
    contentMarkdown: input.message,
  })

  return { personaId: testPersonaId, streamId: testStreamId, messageId: triggerMessage.id, revisionsBefore }
}

async function runBriefCorrectionTask(input: BriefCorrectionInput, ctx: EvalContext): Promise<BriefCorrectionOutput> {
  try {
    const { personaId, streamId, messageId, revisionsBefore } = await setupTestData(input, ctx)

    const embeddingService = new EmbeddingService({ ai: ctx.ai })
    const userPreferencesService = new UserPreferencesService(ctx.pool)
    const workspaceAgent = new WorkspaceAgent({
      pool: ctx.pool,
      ai: ctx.ai,
      configResolver: ctx.configResolver,
      embeddingService,
    })
    const generalResearcher = new GeneralResearcher({ ai: ctx.ai, configResolver: ctx.configResolver })
    const searchService = new SearchService({ pool: ctx.pool, embeddingService })
    const memoExplorerService = new MemoExplorerService({
      pool: ctx.pool,
      embeddingService,
      reranker: new MemoReranker({ ai: ctx.ai }),
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

    // The brief tool under test: wired to the production StreamBriefService exactly
    // as server.ts binds it, so the eval exercises the real write path (INV-45).
    const briefService = new StreamBriefService({ pool: ctx.pool })
    const updateBrief: PersonaAgentDeps["updateBrief"] = async ({ content, reason, expectedVersion }) => {
      const result = await briefService.update({
        workspaceId: ctx.workspaceId,
        streamId,
        content,
        expectedVersion,
        updatedByKind: AuthorTypes.PERSONA,
        updatedById: personaId,
        reason,
      })
      return result.outcome === "updated"
        ? { ok: true, version: result.brief.version }
        : {
            ok: false,
            reason: "version_conflict",
            currentContent: result.current?.content ?? null,
            currentVersion: result.current?.version ?? 0,
          }
    }

    const editMessage: PersonaAgentDeps["editMessage"] = async () => null
    const deleteMessage: PersonaAgentDeps["deleteMessage"] = async () => null
    const personaAgent = new PersonaAgent({
      pool: ctx.pool,
      ai: ctx.ai,
      traceEmitter,
      sessionAbortRegistry: new SessionAbortRegistry(),
      userPreferencesService,
      workspaceAgent,
      generalResearcher,
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
      addReaction: async () => null,
      removeReaction: async () => null,
      createThread: async () => {
        throw new Error("createThread is not expected in brief-correction evals")
      },
      updateBrief,
    })

    const agentInput: PersonaAgentInput = {
      workspaceId: ctx.workspaceId,
      streamId,
      messageId,
      personaId,
      serverId: `eval-server-${ulid()}`,
      purpose: { kind: "catch_up" },
    }
    await personaAgent.run(agentInput)

    const brief = await StreamBriefRepository.findByStreamId(ctx.pool, ctx.workspaceId, streamId)
    const revisionCount = await countRevisions(ctx, streamId)

    return {
      input,
      wrote: revisionCount > revisionsBefore,
      briefContent: brief?.content ?? null,
      briefVersion: brief?.version ?? 0,
      revisionCount,
      revisionsBefore,
    }
  } catch (error) {
    return {
      input,
      wrote: false,
      briefContent: null,
      briefVersion: 0,
      revisionCount: 0,
      revisionsBefore: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export const briefCorrectionSuite: EvalSuite<BriefCorrectionInput, BriefCorrectionOutput, BriefCorrectionExpected> = {
  name: "brief-correction",
  description: "Tests companion brief maintenance: record decisions, replace reversals, ignore chitchat",

  cases: briefCorrectionCases,

  task: runBriefCorrectionTask,

  evaluators: [writeDecisionEvaluator, singleRevisionEvaluator, briefContentEvaluator],

  runEvaluators: [accuracyEvaluator, chitchatNoWriteRateEvaluator],

  defaultPermutations: [
    {
      model: COMPANION_MODEL_ID,
      temperature: COMPANION_TEMPERATURE,
    },
  ],
}

export default briefCorrectionSuite
