import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { StreamTypes } from "@threa/types"
import * as dbModule from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { HttpError } from "../../lib/errors"
import { MessageVersionRepository } from "../messaging"
import { StreamPoliciesRepository, StreamRepository, StreamEventRepository } from "../streams"
import { PersonaAgent, type PersonaAgentDeps, type PersonaAgentInput } from "./persona-agent"
import { DraftsRepository, type Draft } from "../drafts"
import { PersonaRepository, type Persona } from "./persona-repository"
import { AgentSessionRepository, SessionStatuses, type AgentSession } from "./session-repository"
import { SessionAbortRegistry } from "./session-abort-registry"
import { TraceEmitter } from "./trace-emitter"

const SONNET = "openrouter:anthropic/claude-sonnet-4.6"
const OPUS = "openrouter:anthropic/claude-opus-4.8"

const WORKSPACE_ID = "ws_1"
const STREAM_ID = "stream_1"
const PERSONA_ID = "persona_1"
const TRIGGER_MESSAGE_ID = "msg_trigger_1"
const SUPERSEDED_SESSION_ID = "agsess_prev"
const RUNNING_SESSION_ID = "agsess_new"

const persona: Persona = {
  id: PERSONA_ID,
  workspaceId: null,
  slug: "ariadne",
  name: "Ariadne",
  description: null,
  avatarEmoji: null,
  avatarUrl: null,
  systemPrompt: "You are a test persona.",
  model: SONNET,
  escalationModel: OPUS,
  temperature: 0,
  maxTokens: null,
  enabledTools: [],
  tonePreset: null,
  brevityPreset: null,
  tonePrompt: null,
  brevityPrompt: null,
  managedBy: "system",
  ownerUserId: null,
  status: "active",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
}

const stream = {
  id: STREAM_ID,
  workspaceId: WORKSPACE_ID,
  type: StreamTypes.SCRATCHPAD,
  rootStreamId: null,
  parentStreamId: null,
  displayName: "Test pad",
  createdBy: "usr_1",
} as any

function makeDraft(overrides?: Partial<Draft>): Draft {
  return {
    id: "draft_1",
    workspaceId: WORKSPACE_ID,
    userId: "usr_owner",
    scope: `aside:${STREAM_ID}:draft_1`,
    rootStreamId: null,
    contentJson: null,
    contentMarkdown: "body",
    attachmentIds: [],
    command: null,
    contextRefs: null,
    ciphertext: null,
    envelope: null,
    e2eVersion: null,
    version: 1,
    lastClientWriteId: null,
    supersededWriteIds: null,
    clientUpdatedAt: new Date("2026-08-24T07:05:00Z"),
    stashedAt: null,
    createdAt: new Date("2026-08-24T07:00:00Z"),
    updatedAt: new Date("2026-08-24T07:05:00Z"),
    deletedAt: null,
    ...overrides,
  } as Draft
}

function makeSession(overrides?: Partial<AgentSession>): AgentSession {
  return {
    id: RUNNING_SESSION_ID,
    streamId: STREAM_ID,
    personaId: PERSONA_ID,
    triggerMessageId: TRIGGER_MESSAGE_ID,
    triggerMessageRevision: 1,
    supersedesSessionId: null,
    status: SessionStatuses.RUNNING,
    currentStep: 0,
    currentStepType: null,
    serverId: "server_1",
    callbackTokenHash: null,
    replyKeyGeneration: null,
    heartbeatAt: null,
    abortRequestedAt: null,
    responseMessageId: null,
    error: null,
    lastSeenSequence: null,
    sentMessageIds: [],
    contextMessageIds: [],
    episodeSummary: null,
    responseValidationFailed: false,
    reflectiveCapturedAt: null,
    createdAt: new Date("2026-02-19T12:00:00Z"),
    completedAt: null,
    ...overrides,
  }
}

/** Every unstubbed repository read hits this and sees an empty database. */
const emptyDb = { query: async () => ({ rows: [], rowCount: 0 }) } as any

function makeFakeIo() {
  const target: any = { emit: () => target, to: () => target }
  return { to: () => target } as any
}

/**
 * Run PersonaAgent.run for a supersede rerun against a stubbed AI, capturing
 * which model the agent loop is invoked with (the "stubbed AI capture" the
 * roadmap 2.3 Done-when asks for).
 */
async function runSupersedeRerun(params: {
  supersededFailedValidation: boolean
  authorityError?: Error
  threadError?: Error
  streamOverride?: Record<string, unknown>
  purpose?: PersonaAgentInput["purpose"]
}) {
  const supersededSession = makeSession({
    id: SUPERSEDED_SESSION_ID,
    status: SessionStatuses.SUPERSEDED,
    responseValidationFailed: params.supersededFailedValidation,
    completedAt: new Date("2026-02-19T11:59:00Z"),
  })
  const runningSession = makeSession({ supersedesSessionId: SUPERSEDED_SESSION_ID })

  spyOn(dbModule, "withClient").mockImplementation(async (_pool, callback: any) => callback(emptyDb))
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool, callback: any) => callback(emptyDb))

  spyOn(PersonaRepository, "findById").mockResolvedValue(persona)
  spyOn(StreamRepository, "findById").mockResolvedValue({ ...stream, ...params.streamOverride })
  spyOn(StreamPoliciesRepository, "getToolPolicy").mockResolvedValue(null)
  spyOn(MessageVersionRepository, "getCurrentRevision").mockResolvedValue(1)
  spyOn(StreamEventRepository, "insert").mockImplementation(
    async (_db, input: any) =>
      ({ ...input, sequence: 1n, createdAt: new Date(), actorId: input.actorId ?? null }) as any
  )
  spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)

  spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue(null)
  spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue(runningSession)
  spyOn(AgentSessionRepository, "findById").mockImplementation(async (_db, id: string) =>
    id === SUPERSEDED_SESSION_ID ? supersededSession : runningSession
  )
  spyOn(AgentSessionRepository, "updateContextMessageIds").mockResolvedValue(undefined as any)
  spyOn(AgentSessionRepository, "completeSession").mockResolvedValue(
    makeSession({ status: SessionStatuses.COMPLETED, completedAt: new Date() })
  )
  const upsertStep = spyOn(AgentSessionRepository, "upsertStep").mockImplementation(
    async (_db, input: any) =>
      ({
        id: input.id,
        sessionId: input.sessionId,
        stepNumber: input.stepNumber,
        stepType: input.stepType,
        content: input.content ?? null,
        contentCiphertext: null,
        contentEnvelope: null,
        sources: null,
        messageId: null,
        tokensUsed: null,
        startedAt: input.startedAt,
        completedAt: null,
      }) as any
  )
  spyOn(AgentSessionRepository, "updateCurrentStepType").mockResolvedValue(undefined as any)
  spyOn(AgentSessionRepository, "updateStep").mockResolvedValue(null as any)
  const markResponseValidationFailed = spyOn(AgentSessionRepository, "markResponseValidationFailed").mockResolvedValue(
    undefined as any
  )
  const updateStatus = spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue(
    makeSession({
      status: SessionStatuses.FAILED,
      error: (params.authorityError ?? params.threadError)?.message ?? null,
    })
  )
  spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([])

  const capturedModelStrings: string[] = []
  const capturedVolatilePrompts: string[] = []
  const capturedStablePrompts: string[] = []
  const ai = {
    getLanguageModel: (id: string) => ({ id }),
    parseModel: (id: string) => ({ modelId: id, modelProvider: "openrouter", modelName: id }),
    generateTextWithTools: async (opts: { modelString?: string; system?: string; volatileSystem?: string }) => {
      capturedModelStrings.push(opts.modelString ?? "unknown")
      capturedVolatilePrompts.push(opts.volatileSystem ?? "")
      capturedStablePrompts.push(opts.system ?? "")
      return {
        text: "Revised final answer.",
        toolCalls: [],
        response: { messages: [{ role: "assistant", content: "Revised final answer." }] },
      }
    },
    // Supersede response validator: accept the revision so the turn commits.
    generateObject: async () => ({ value: { verdict: "accept", reason: "directly answers the edit" } }),
  } as any

  const createMessage = mock(async () => ({ id: "msg_new_1" }))
  const createThread = mock(async () => {
    if (params.threadError) throw params.threadError
    return { id: "thread_1" }
  })

  const assertInitiatorWritable = mock(async () => {
    if (params.authorityError) throw params.authorityError
    return {} as never
  })
  const deps = {
    pool: emptyDb,
    assertInitiatorWritable,
    ai,
    traceEmitter: new TraceEmitter({ io: makeFakeIo(), pool: emptyDb }),
    sessionAbortRegistry: new SessionAbortRegistry(),
    userPreferencesService: { getPreferences: async () => ({}) },
    workspaceAgent: { search: async () => ({}) },
    generalResearcher: { research: async () => ({}) },
    searchService: {},
    conversationSummaryService: { updateForContext: async () => null },
    attachmentService: {},
    memoExplorerService: {},
    storage: {},
    modelRegistry: { supportsVision: () => false },
    createMessage,
    editMessage: async () => null,
    deleteMessage: async () => null,
    addReaction: async () => ({ id: "reaction_1" }),
    removeReaction: async () => null,
    createThread,
    scheduleFollowUp: async () => ({}),
    listFollowUps: async () => [],
    cancelFollowUp: async () => ({}),
    updateFollowUp: async () => ({}),
  } as unknown as PersonaAgentDeps

  const agent = new PersonaAgent(deps)
  const result = await agent.run({
    workspaceId: WORKSPACE_ID,
    streamId: STREAM_ID,
    messageId: TRIGGER_MESSAGE_ID,
    personaId: PERSONA_ID,
    serverId: "server_1",
    initiatingUserId: "usr_1",
    purpose:
      params.purpose ??
      ({
        kind: "supersede_rerun",
        supersedesSessionId: SUPERSEDED_SESSION_ID,
        rerunContext: { cause: "invoking_message_edited", editedMessageId: TRIGGER_MESSAGE_ID },
      } as const),
  })

  const escalationSteps = upsertStep.mock.calls.filter(([, input]: any[]) => input.stepType === "model_escalated")
  return {
    result,
    capturedModelStrings,
    capturedVolatilePrompts,
    capturedStablePrompts,
    escalationSteps,
    markResponseValidationFailed,
    createMessage,
    createThread,
    updateStatus,
    assertInitiatorWritable,
  }
}

describe("PersonaAgent aside drafts in context", () => {
  afterEach(() => {
    mock.restore()
  })

  it("reads the aside's own drafts into the volatile prompt", async () => {
    const listByScopePrefix = spyOn(DraftsRepository, "listByScopePrefix").mockResolvedValue([
      makeDraft({ contentMarkdown: "Half a thought about the rollout window" }),
    ])

    const { capturedVolatilePrompts, capturedStablePrompts } = await runSupersedeRerun({
      supersededFailedValidation: false,
      streamOverride: { type: StreamTypes.ASIDE, createdBy: "usr_owner" },
    })

    expect(listByScopePrefix.mock.calls[0]?.[1]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      userId: "usr_owner",
      scopePrefix: `aside:${STREAM_ID}:`,
    })
    expect(capturedVolatilePrompts[0]).toContain("## Drafts open in this aside")
    expect(capturedVolatilePrompts[0]).toContain("Half a thought about the rollout window")
    // Never the cached half: the body changes as the user types, and a change
    // inside the prefix invalidates the cache for every turn that follows.
    expect(capturedStablePrompts[0]).not.toContain("Drafts open in this aside")
    expect(capturedStablePrompts[0]).not.toContain("Half a thought about the rollout window")
  })

  it("leaves every other stream type's prompt alone", async () => {
    const listByScopePrefix = spyOn(DraftsRepository, "listByScopePrefix").mockResolvedValue([])

    const { capturedVolatilePrompts } = await runSupersedeRerun({ supersededFailedValidation: false })

    expect(listByScopePrefix).not.toHaveBeenCalled()
    expect(capturedVolatilePrompts[0]).not.toContain("Drafts open in this aside")
  })
})

describe("PersonaAgent per-turn model resolution (roadmap 2.3)", () => {
  afterEach(() => {
    mock.restore()
  })

  it("runs the escalation model when the superseded attempt failed response validation", async () => {
    const { result, capturedModelStrings, escalationSteps, markResponseValidationFailed } = await runSupersedeRerun({
      supersededFailedValidation: true,
    })

    expect(result.status).toBe("completed")
    expect(result.messagesSent).toBe(1)
    expect(capturedModelStrings).toEqual([OPUS])
    // The escalation is visible in the trace with its provenance.
    expect(escalationSteps).toHaveLength(1)
    expect(JSON.parse((escalationSteps[0][1] as { content: string }).content)).toEqual({
      fromModel: SONNET,
      toModel: OPUS,
      cause: "previous_attempt_failed_validation",
    })
    // This turn produced a valid revision, so it must not carry the marker forward.
    expect(markResponseValidationFailed).not.toHaveBeenCalled()
  })

  it("runs the persona model when the superseded attempt passed validation", async () => {
    const { result, capturedModelStrings, escalationSteps } = await runSupersedeRerun({
      supersededFailedValidation: false,
    })

    expect(result.status).toBe("completed")
    expect(capturedModelStrings).toEqual([SONNET])
    expect(escalationSteps).toHaveLength(0)
  })

  it("terminalizes a denied channel-mention thread creation on the parent stream", async () => {
    const denial = new HttpError("read only", {
      status: 403,
      code: "STREAM_READ_ONLY",
      details: { reason: "archived" },
    })
    const { result, capturedModelStrings, createMessage, createThread, updateStatus } = await runSupersedeRerun({
      supersededFailedValidation: false,
      threadError: denial,
      streamOverride: { type: StreamTypes.CHANNEL },
      purpose: { kind: "mention" },
    })

    expect(createThread).toHaveBeenCalledTimes(1)
    expect(updateStatus).toHaveBeenCalledTimes(1)
    expect(updateStatus).toHaveBeenCalledWith(expect.anything(), RUNNING_SESSION_ID, SessionStatuses.FAILED, {
      error: "HttpError: read only",
    })
    expect(result).toMatchObject({ status: "failed", retryable: false, messagesSent: 0, sentMessageIds: [] })
    expect(capturedModelStrings).toEqual([])
    expect(createMessage).not.toHaveBeenCalled()
  })

  it("rechecks the initiating user immediately before provider execution and terminalizes denial", async () => {
    const denial = new HttpError("read only", {
      status: 403,
      code: "STREAM_READ_ONLY",
      details: { reason: "archived" },
    })
    const { result, capturedModelStrings, createMessage, assertInitiatorWritable } = await runSupersedeRerun({
      supersededFailedValidation: false,
      authorityError: denial,
    })

    expect(assertInitiatorWritable).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: WORKSPACE_ID,
      streamId: STREAM_ID,
      principal: { kind: "user", userId: "usr_1" },
    })
    expect(result).toMatchObject({ status: "failed", retryable: false, messagesSent: 0, sentMessageIds: [] })
    expect(capturedModelStrings).toEqual([])
    expect(createMessage).not.toHaveBeenCalled()
  })
})
