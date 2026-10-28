/**
 * Doc Edit Evaluation Suite
 *
 * Measures whether Ariadne, asked in a scratchpad that hosts a doc, edits that
 * doc through the production doc tools: one scoped write when asked for a
 * change, none on chitchat or a read-only question. Runs the PRODUCTION
 * PersonaAgent.run() with `docAgent` wired to the production DocAgentService
 * (INV-45), then reads the doc's sections, update log and edit events back
 * from the database to grade the outcome.
 *
 * ## Usage
 *
 *   bun run eval -- -s doc-edit
 *   bun run eval -- -s doc-edit -c check-aws-task-001
 *
 * ## Gates
 *
 * - accuracy (run-level): >=80% of all cases pass every evaluator.
 */

import { DisabledAnalyticsReporter } from "@threahq/backend-common"
import { ulid } from "ulid"
import * as Y from "yjs"
import type { EvalSuite, EvalContext } from "../../framework/types"
import { DOC_BODY, DOC_TITLE, docEditCases } from "./cases"
import type { DocEditInput, DocEditOutput, DocEditExpected } from "./types"
import {
  diffSections,
  writeDecisionEvaluator,
  singleWriteEvaluator,
  scopedChangeEvaluator,
  reasonPresentEvaluator,
  accuracyEvaluator,
} from "./evaluators"
import { COMPANION_MODEL_ID, COMPANION_TEMPERATURE } from "./config"
import {
  AgentSessionRepository,
  ARIADNE_AGENT_ID,
  COMPANION_SUMMARY_MODEL_ID,
  COMPANION_SUMMARY_TEMPERATURE,
  PersonaAgent,
  type PersonaAgentInput,
  type PersonaAgentDeps,
  WorkspaceAgent,
  PeopleResolver,
  GeneralResearcher,
  PersonaRepository,
  TraceEmitter,
  SessionAbortRegistry,
  ConversationSummaryService,
  PreparedRecall,
  PREPARED_RECALL_QUESTION,
  buildAgentMessageContent,
} from "../../../src/features/agents"
import { AttachmentService, createMalwareScanner } from "../../../src/features/attachments"
import { SearchService, SearchQueryExpander, SearchRefiner } from "../../../src/features/search"
import { UserPreferencesService } from "../../../src/features/user-preferences"
import { DecisionsRelevanceScorer, EmbeddingService, MemoExplorerService, Reranker } from "../../../src/features/memos"
import {
  StreamRepository,
  StreamEventRepository,
  StreamMemberRepository,
  StreamBriefService,
  StreamService,
} from "../../../src/features/streams"
import { BotChannelService } from "../../../src/features/api-keys"
import {
  DocAgentService,
  DocRepository,
  DocService,
  encodeUpdateBase64,
  writeContentJson,
} from "../../../src/features/docs"
import { EventService } from "../../../src/features/messaging"
import { storeDevice, UserDeviceContextRepository } from "../../../src/features/device-context"
import { createModelRegistry, DecisionsAvailability } from "@threahq/agent-runtime"
import { WorkspaceAIResidencyPolicy } from "../../../src/features/ai-usage"
import type { StorageProvider } from "../../../src/lib/storage/s3-client"
import type { Server } from "socket.io"
import { parseMarkdown } from "@threahq/prosemirror"
import { AuthorTypes, StreamTypes, type DocEditedEventPayload } from "@threahq/types"
import { streamId as generateStreamId } from "../../../src/lib/id"
import { insertEvalPersona } from "../../framework/eval-persona"

/** Fixed clock for the agent's temporal grounding so a run is reproducible. */
const EVAL_CLOCK = new Date("2026-07-01T12:00:00Z")

interface SeededCase {
  personaId: string
  streamId: string
  docId: string
  decoyDocId: string | null
  messageId: string
  baseline: Map<string, string>
  decoyBaseline: Map<string, string>
}

interface SeedServices {
  docService: DocService
  streamService: StreamService
  userPreferencesService: UserPreferencesService
}

/** Host a titled doc on the scratchpad with its body written as a member's client update. */
async function hostDoc(
  ctx: EvalContext,
  services: Pick<SeedServices, "docService" | "streamService">,
  hostStreamId: string,
  title: string,
  markdown: string
): Promise<string> {
  const doc = await services.streamService.create({
    workspaceId: ctx.workspaceId,
    type: StreamTypes.DOC,
    parentStreamId: hostStreamId,
    createdBy: ctx.userId,
  })
  await services.streamService.updateStream(
    doc.id,
    { displayName: title },
    { workspaceId: ctx.workspaceId, principal: { kind: "user", userId: ctx.userId } }
  )
  const body = writeContentJson(new Y.Doc(), { type: "doc", content: parseMarkdown(markdown).content })
  await services.docService.postUpdate({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    docId: doc.id,
    update: encodeUpdateBase64(body),
  })
  return doc.id
}

async function sectionsByBlockId(ctx: EvalContext, docId: string): Promise<Map<string, string>> {
  const sections = await DocRepository.listSections(ctx.pool, ctx.workspaceId, docId)
  return new Map(sections.map((section) => [section.blockId, section.markdown]))
}

/**
 * Seed a private scratchpad with companion mode on and the eval Ariadne
 * persona (as brief-correction does), host the "Rotation tracker" doc and any
 * decoy doc on it, report the user's open docs, then post the history and the
 * trigger message.
 */
async function setupTestData(input: DocEditInput, ctx: EvalContext, services: SeedServices): Promise<SeededCase> {
  const pool = ctx.pool

  const templatePersona = await PersonaRepository.findById(pool, ctx.workspaceId, ARIADNE_AGENT_ID)
  if (!templatePersona?.systemPrompt) {
    throw new Error(`Could not resolve built-in companion persona ${ARIADNE_AGENT_ID} (see built-in-agents.ts)`)
  }

  const testPersonaId = await insertEvalPersona(pool, {
    template: templatePersona,
    model: ctx.componentOverrides?.companion?.model ?? ctx.permutation.model,
    slugPrefix: "eval-ariadne",
    name: "Ariadne (Eval)",
  })

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
  await StreamMemberRepository.insert(pool, ctx.workspaceId, testStreamId, ctx.userId)

  await services.userPreferencesService.updatePreferences(ctx.workspaceId, ctx.userId, { timezone: "UTC" })

  const docId = await hostDoc(ctx, services, testStreamId, DOC_TITLE, DOC_BODY)
  const decoyDocId = input.decoyDoc
    ? await hostDoc(ctx, services, testStreamId, input.decoyDoc.title, input.decoyDoc.body)
    : null
  const baseline = await sectionsByBlockId(ctx, docId)
  const decoyBaseline = decoyDocId ? await sectionsByBlockId(ctx, decoyDocId) : new Map<string, string>()

  // Cases share one fixture user, so a case without an open doc clears the previous case's report.
  if (input.openDoc) {
    const openDocId = input.openDoc === "seeded" ? docId : decoyDocId
    if (!openDocId) throw new Error('openDoc: "decoy" needs a decoyDoc')
    await storeDevice(pool, [{ workspaceId: ctx.workspaceId, userId: ctx.userId }], {
      layout: "desktop",
      os: "linux",
      installed: false,
      openDocIds: [openDocId],
    })
  } else {
    await UserDeviceContextRepository.delete(pool, ctx.workspaceId, ctx.userId)
  }

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

  const triggerMessage = await eventService.createMessage({
    workspaceId: ctx.workspaceId,
    streamId: testStreamId,
    authorId: ctx.userId,
    authorType: AuthorTypes.USER,
    contentJson: parseMarkdown(input.message),
    contentMarkdown: input.message,
  })

  return {
    personaId: testPersonaId,
    streamId: testStreamId,
    docId,
    decoyDocId,
    messageId: triggerMessage.id,
    baseline,
    decoyBaseline,
  }
}

async function readBack(
  ctx: EvalContext,
  seeded: Pick<SeededCase, "streamId" | "docId" | "decoyDocId" | "baseline" | "decoyBaseline">
): Promise<Omit<DocEditOutput, "input" | "error">> {
  const { streamId, docId, decoyDocId, baseline, decoyBaseline } = seeded
  const [after, decoyAfter, updates, decoyUpdates, edits, decoyEdits, childDocs, doc] = await Promise.all([
    sectionsByBlockId(ctx, docId),
    decoyDocId ? sectionsByBlockId(ctx, decoyDocId) : new Map<string, string>(),
    DocRepository.listUpdatesAfter(ctx.pool, ctx.workspaceId, docId, 0),
    decoyDocId ? DocRepository.listUpdatesAfter(ctx.pool, ctx.workspaceId, decoyDocId, 0) : [],
    StreamEventRepository.list(ctx.pool, ctx.workspaceId, docId, { types: ["doc:edited"] }),
    decoyDocId ? StreamEventRepository.list(ctx.pool, ctx.workspaceId, decoyDocId, { types: ["doc:edited"] }) : [],
    StreamRepository.list(ctx.pool, ctx.workspaceId, {
      types: [StreamTypes.DOC],
      parentStreamId: streamId,
      archiveStatus: ["active", "archived"],
    }),
    StreamRepository.findById(ctx.pool, ctx.workspaceId, docId),
  ])

  const personaUpdateCount = updates.filter((update) => update.actorType === AuthorTypes.PERSONA).length
  const decoyPersonaUpdateCount = decoyUpdates.filter((update) => update.actorType === AuthorTypes.PERSONA).length
  const createdDocCount = childDocs.filter((child) => child.id !== docId && child.id !== decoyDocId).length
  const titleChanged = doc?.displayName !== DOC_TITLE
  const writeCount = personaUpdateCount + decoyPersonaUpdateCount + createdDocCount + (titleChanged ? 1 : 0)

  return {
    wrote: writeCount > 0,
    writeCount,
    personaUpdateCount,
    decoyPersonaUpdateCount,
    decoyTouchedSections: diffSections(decoyBaseline, decoyAfter).touchedSections,
    createdDocCount,
    titleChanged,
    ...diffSections(baseline, after),
    reasons: [...edits, ...decoyEdits]
      .filter((event) => event.actorType === AuthorTypes.PERSONA)
      .map((event) => (event.payload as DocEditedEventPayload).reason ?? ""),
  }
}

async function runDocEditTask(input: DocEditInput, ctx: EvalContext): Promise<DocEditOutput> {
  try {
    const docService = new DocService({ pool: ctx.pool })
    const streamService = new StreamService(ctx.pool)
    const userPreferencesService = new UserPreferencesService(ctx.pool)
    const seeded = await setupTestData(input, ctx, {
      docService,
      streamService,
      userPreferencesService,
    })
    const { personaId, streamId, messageId } = seeded

    const embeddingService = new EmbeddingService({ ai: ctx.ai })
    const workspaceAgent = new WorkspaceAgent({
      pool: ctx.pool,
      ai: ctx.ai,
      configResolver: ctx.configResolver,
      embeddingService,
      peopleResolver: new PeopleResolver({
        ai: ctx.ai,
        residency: new WorkspaceAIResidencyPolicy({ pool: ctx.pool }),
        availability: new DecisionsAvailability(),
      }),
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
      relevanceScorer: new DecisionsRelevanceScorer({
        ai: ctx.ai,
        subject: "chat messages",
        functionId: "search-score",
      }),
      memoSearch: memoExplorerService,
      refiner: new SearchRefiner({ ai: ctx.ai }),
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
        ...(await buildAgentMessageContent({ pool: ctx.pool, ...params })),
        sources: params.sources,
        accessibleStreamIds: params.accessibleStreamIds,
      })
      return { id: message.id }
    }

    const briefService = new StreamBriefService({ pool: ctx.pool })
    const updateBrief: PersonaAgentDeps["updateBrief"] = async ({ content, reason, expectedVersion }) => {
      const result = await briefService.updateInternal({
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
      configResolver: ctx.configResolver,
      aiResidency: new WorkspaceAIResidencyPolicy({ pool: ctx.pool }),
      decisionsAvailability: new DecisionsAvailability(),
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
      preparedRecall: new PreparedRecall({
        analyticsReporter: new DisabledAnalyticsReporter(),
        memoExplorerService,
        scorer: new DecisionsRelevanceScorer({
          ai: ctx.ai,
          subject: "knowledge memos",
          question: PREPARED_RECALL_QUESTION,
          functionId: "prepared-recall-score",
        }),
      }),
      storage: stubStorage,
      modelRegistry: createModelRegistry(),
      webSearchEngines: ctx.credentials.webSearchEngines,
      createMessage,
      editMessage,
      deleteMessage,
      addReaction: async () => null,
      removeReaction: async () => null,
      createThread: async () => {
        throw new Error("createThread is not expected in doc-edit evals")
      },
      updateBrief,
      docAgent: new DocAgentService({
        pool: ctx.pool,
        docService,
        streamService,
        botChannelService: new BotChannelService({ pool: ctx.pool }),
      }),
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
    const run = await personaAgent.run(agentInput)
    let error: string | undefined
    if (run.status === "failed") {
      const session = run.sessionId
        ? await AgentSessionRepository.findById(ctx.pool, ctx.workspaceId, run.sessionId)
        : null
      error = `agent session failed: ${session?.error ?? "no error recorded"}`
    } else if (run.status === "skipped") {
      error = `agent session skipped: ${run.skipReason ?? "no reason recorded"}`
    }

    const readback = await readBack(ctx, seeded)
    return { input, ...readback, error }
  } catch (error) {
    return {
      input,
      wrote: false,
      writeCount: 0,
      personaUpdateCount: 0,
      decoyPersonaUpdateCount: 0,
      decoyTouchedSections: [],
      createdDocCount: 0,
      titleChanged: false,
      touchedSections: [],
      removedBlockIds: [],
      reasons: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export const docEditSuite: EvalSuite<DocEditInput, DocEditOutput, DocEditExpected> = {
  name: "doc-edit",
  description: "Tests companion doc edits: one scoped write when asked, none on chitchat or questions",

  cases: docEditCases,

  task: runDocEditTask,

  evaluators: [writeDecisionEvaluator, singleWriteEvaluator, scopedChangeEvaluator, reasonPresentEvaluator],

  runEvaluators: [accuracyEvaluator],

  defaultPermutations: [
    {
      model: COMPANION_MODEL_ID,
      temperature: COMPANION_TEMPERATURE,
    },
  ],
}

export default docEditSuite
