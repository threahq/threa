import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { StreamTypes } from "@threa/types"
import * as dbModule from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { MessageVersionRepository } from "../messaging"
import { StreamPoliciesRepository, StreamRepository, StreamEventRepository } from "../streams"
import { PersonaAgent, type PersonaAgentDeps } from "./persona-agent"
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
async function runSupersedeRerun(params: { supersededFailedValidation: boolean }) {
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
  spyOn(StreamRepository, "findById").mockResolvedValue(stream)
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

  const capturedModelStrings: string[] = []
  const ai = {
    getLanguageModel: (id: string) => ({ id }),
    parseModel: (id: string) => ({ modelId: id, modelProvider: "openrouter", modelName: id }),
    generateTextWithTools: async (opts: { modelString?: string }) => {
      capturedModelStrings.push(opts.modelString ?? "unknown")
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

  const deps = {
    pool: emptyDb,
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
    createThread: async () => ({ id: "thread_1" }),
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
    purpose: {
      kind: "supersede_rerun",
      supersedesSessionId: SUPERSEDED_SESSION_ID,
      rerunContext: { cause: "invoking_message_edited", editedMessageId: TRIGGER_MESSAGE_ID },
    },
  })

  const escalationSteps = upsertStep.mock.calls.filter(([, input]: any[]) => input.stepType === "model_escalated")
  return { result, capturedModelStrings, escalationSteps, markResponseValidationFailed, createMessage }
}

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
})
