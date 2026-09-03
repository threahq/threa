import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import { AgentSessionStatuses, AgentStepTypes } from "@threa/types"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"
import { E2eStreamsRepository } from "../e2e-streams"
import { BotRepository } from "./bot-repository"
import * as dbModule from "../../db"
import { AgentSessionRepository } from "../agents"
import { UserRepository } from "../workspaces"
import { StreamEventRepository } from "../streams"
import * as streamsModule from "../streams"
import { OutboxRepository } from "../../lib/outbox"
import { MessageRepository, type EventService } from "../messaging"

// The synthesized-trace floor (N-6): a reply-only bot that never POSTed /steps
// completes with a reconstructed context_received → message_sent trace, written
// in the completion transaction so the completed event's stepCount matches the
// rows, with the step frames emitted before the terminal status.

function createResponse(): Response {
  const res = {} as Response
  res.status = mock(() => res) as unknown as Response["status"]
  res.json = mock(() => res) as unknown as Response["json"]
  return res
}

function arrangeCompletion(params: { existingSteps: unknown[]; manifest?: unknown; sessionStatus?: string }) {
  spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({} as never)
  spyOn(streamsModule, "resolveLockedStreamAuthorities").mockResolvedValue([
    { state: { readOnly: false, readOnlyReason: null } },
  ] as never)
  spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
  spyOn(BotRepository, "findById").mockResolvedValue({ id: "bot_1", name: "Pi", archivedAt: null } as never)
  spyOn(dbModule, "withTransaction").mockImplementation(((_pool: unknown, fn: (c: unknown) => unknown) =>
    fn({})) as never)

  spyOn(AgentSessionRepository, "findById").mockResolvedValue({
    id: "binv_1",
    status: params.sessionStatus ?? AgentSessionStatuses.RUNNING,
  } as never)
  const completeSession = spyOn(AgentSessionRepository, "completeSession").mockResolvedValue({
    id: "binv_1",
    createdAt: new Date("2026-06-11T09:00:00.000Z"),
    completedAt: new Date("2026-06-11T09:00:05.000Z"),
  } as never)
  spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue(params.existingSteps as never)
  let stepNumber = 0
  const appendStep = spyOn(AgentSessionRepository, "appendStep").mockImplementation((async (
    _db: unknown,
    p: { id: string; sessionId: string; stepType: string; content: string; messageId?: string }
  ) => ({
    id: p.id,
    sessionId: p.sessionId,
    stepNumber: ++stepNumber,
    stepType: p.stepType,
    content: p.content,
    sources: null,
    messageId: p.messageId ?? null,
    tokensUsed: null,
    startedAt: new Date("2026-06-11T09:00:04.000Z"),
    completedAt: new Date("2026-06-11T09:00:04.000Z"),
    contentCiphertext: null,
    contentEnvelope: null,
  })) as never)
  spyOn(UserRepository, "findById").mockResolvedValue({ id: "usr_1", name: "Kris" } as never)
  const insertEvent = spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
  spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

  const emitted: Array<{ room: string; event: string; payload: unknown }> = []
  const io = {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => void emitted.push({ room, event, payload }),
    }),
  } as unknown as PublicApiDeps["io"]

  const message = {
    id: "msg_reply",
    streamId: "stream_1",
    sequence: 7n,
    authorId: "bot_1",
    authorType: "bot",
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "High tide is at 14:32.",
    reactions: {},
    metadata: {},
    editedAt: null,
    createdAt: new Date("2026-06-11T09:00:04.000Z"),
  }
  const createMessageInTransaction = mock((_client: unknown, _principal: unknown, _params: Record<string, unknown>) =>
    Promise.resolve({ message })
  )
  const eventService = {
    createMessageForPrincipalInTransaction: createMessageInTransaction,
    getLatestSequence: mock(() => Promise.resolve(7n)),
  } as unknown as EventService
  const activeClaim = { id: "binv_1", responseStreamId: "stream_1", status: "claimed" }
  const validateClaimSourceForCompletion = mock(() => Promise.resolve(true))
  const botRuntimeService = {
    validateClaimSourceForCompletion,
    findInvocationForCallback: mock(() => Promise.resolve(activeClaim)),
    findCompletedInvocationForReplay: mock(() => Promise.resolve(null)),
    findActiveClaimForUpdate: mock(() => Promise.resolve(activeClaim)),
    findPresenceByInstance: mock(() => Promise.resolve({ manifest: params.manifest ?? null })),
    completeInvocationInTransaction: mock(() =>
      Promise.resolve({
        id: "binv_1",
        responseStreamId: "stream_1",
        sourceMessageId: "msg_trigger",
        promptMarkdown: "@pi what's the tide tomorrow?",
        authorUserId: "usr_1",
        createdAt: new Date("2026-06-11T09:00:00.000Z"),
        metadata: {},
      })
    ),
  }
  const botChannelService = {
    isStreamAccessibleForBot: mock(() => Promise.resolve(true)),
  } as unknown as PublicApiDeps["botChannelService"]

  const handlers = createPublicApiHandlers({
    eventService,
    streamService: {} as PublicApiDeps["streamService"],
    searchService: {} as PublicApiDeps["searchService"],
    memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
    attachmentService: {} as PublicApiDeps["attachmentService"],
    botChannelService,
    botRuntimeService: botRuntimeService as unknown as PublicApiDeps["botRuntimeService"],
    labelService: {} as PublicApiDeps["labelService"],
    labelAssignmentService: {} as PublicApiDeps["labelAssignmentService"],
    pool: {} as PublicApiDeps["pool"],
    io,
  })

  const req = {
    workspaceId: "ws_1",
    params: { invocationId: "binv_1" },
    botApiKey: { botId: "bot_1" },
    body: { instanceId: "inst_1", claimToken: "tok_1", finalMessageMarkdown: "High tide is at 14:32." },
  } as unknown as Request

  return {
    handlers,
    req,
    emitted,
    appendStep,
    insertEvent,
    createMessageInTransaction,
    completeSession,
    botRuntimeService,
    validateClaimSourceForCompletion,
  }
}

describe("completeBotInvocation synthesized-trace floor", () => {
  afterEach(() => {
    mock.restore()
  })

  it("reconstructs the trace for a reply-only completion and counts it in the completed event", async () => {
    const { handlers, req, emitted, appendStep, insertEvent } = arrangeCompletion({ existingSteps: [] })

    await handlers.completeBotInvocation(req, createResponse())

    expect(appendStep).toHaveBeenCalledTimes(2)
    const contextContent = JSON.parse(
      (appendStep.mock.calls[0]?.[1] as unknown as { content: string }).content
    ) as Record<string, unknown>
    expect(contextContent.synthesized).toBe(true)
    expect(contextContent.messages).toEqual([
      {
        messageId: "msg_trigger",
        authorName: "Kris",
        authorType: "user",
        createdAt: "2026-06-11T09:00:00.000Z",
        content: "@pi what's the tide tomorrow?",
        isTrigger: true,
      },
    ])

    // The completed stream event counts the reconstructed rows (written in the
    // same transaction).
    const completedEvent = insertEvent.mock.calls[0]?.[1] as unknown as { payload: Record<string, unknown> }
    expect(completedEvent.payload).toMatchObject({ sessionId: "binv_1", stepCount: 2, messageCount: 1 })

    // Step frames land on the session room before the terminal status.
    const sessionRoomEvents = emitted.filter((e) => e.room === "ws:ws_1:agent_session:binv_1").map((e) => e.event)
    expect(sessionRoomEvents).toEqual([
      "agent_session:step:completed",
      "agent_session:step:completed",
      "agent_session:completed",
    ])
    const stepFrames = emitted
      .filter((e) => e.event === "agent_session:step:completed")
      .map((e) => (e.payload as { step: { stepType: string } }).step.stepType)
    expect(stepFrames).toEqual([AgentStepTypes.CONTEXT_RECEIVED, AgentStepTypes.MESSAGE_SENT])
  })

  it("leaves a reported trace alone (no reconstruction when steps exist)", async () => {
    const { handlers, req, emitted, appendStep, insertEvent } = arrangeCompletion({
      existingSteps: [{ id: "step_1", stepType: AgentStepTypes.TOOL_CALL }],
    })

    await handlers.completeBotInvocation(req, createResponse())

    expect(appendStep).not.toHaveBeenCalled()
    const completedEvent = insertEvent.mock.calls[0]?.[1] as unknown as { payload: Record<string, unknown> }
    expect(completedEvent.payload).toMatchObject({ stepCount: 1 })
    expect(emitted.filter((e) => e.event === "agent_session:step:completed")).toHaveLength(0)
  })

  it("writes no reply or synthesized trace when canonical input is stale", async () => {
    const arranged = arrangeCompletion({ existingSteps: [] })
    arranged.validateClaimSourceForCompletion.mockResolvedValue(false)

    await expect(arranged.handlers.completeBotInvocation(arranged.req, createResponse())).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    })

    expect({
      messages: arranged.createMessageInTransaction.mock.calls.length,
      synthesizedSteps: arranged.appendStep.mock.calls.length,
      completedSessions: arranged.completeSession.mock.calls.length,
      lifecycleEvents: arranged.insertEvent.mock.calls.length,
    }).toEqual({ messages: 0, synthesizedSteps: 0, completedSessions: 0, lifecycleEvents: 0 })
  })
})

describe("completeBotInvocation raced replay", () => {
  afterEach(() => {
    mock.restore()
  })

  it("returns the committed winner when archive lands after its stale claimed snapshot", async () => {
    const { handlers, req, createMessageInTransaction, botRuntimeService } = arrangeCompletion({ existingSteps: [] })
    spyOn(streamsModule, "resolveLockedStreamAuthorities").mockResolvedValue([
      { state: { readOnly: true, readOnlyReason: "archived" } },
    ] as never)
    botRuntimeService.findCompletedInvocationForReplay.mockResolvedValue({
      id: "binv_1",
      responseStreamId: "stream_1",
    } as never)
    spyOn(AgentSessionRepository, "findById").mockResolvedValue({
      id: "binv_1",
      status: AgentSessionStatuses.COMPLETED,
      personaId: "bot_1",
      streamId: "stream_1",
      callbackTokenHash: null,
      responseMessageId: "msg_reply",
    } as never)
    spyOn(MessageRepository, "findById").mockResolvedValue({
      id: "msg_reply",
      streamId: "stream_1",
      sequence: 7n,
      authorId: "bot_1",
      authorType: "bot",
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "High tide is at 14:32.",
      reactions: {},
      metadata: {},
      editedAt: null,
      createdAt: new Date("2026-06-11T09:00:04.000Z"),
    } as never)

    await expect(handlers.completeBotInvocation(req, createResponse())).resolves.toBeUndefined()

    expect(botRuntimeService.findActiveClaimForUpdate).not.toHaveBeenCalled()
    expect(createMessageInTransaction).not.toHaveBeenCalled()
  })
})

describe("completeBotInvocation orphan recovery", () => {
  afterEach(() => {
    mock.restore()
  })

  // A long-running turn can be marked FAILED by orphan-session-cleanup's
  // stale-heartbeat scan while it is in fact alive (the claim is still being
  // renewed). When it later completes successfully its trace must end COMPLETED,
  // not stay stuck red — completion recovers the orphan false-positive.
  it("recovers a FAILED (orphaned) session to completed when the turn finishes", async () => {
    const { handlers, req, emitted, completeSession } = arrangeCompletion({
      existingSteps: [{ id: "step_1", stepType: AgentStepTypes.TOOL_CALL }],
      sessionStatus: AgentSessionStatuses.FAILED,
    })

    await handlers.completeBotInvocation(req, createResponse())

    expect(completeSession).toHaveBeenCalledTimes(1)
    expect(completeSession.mock.calls[0]?.[2]).toMatchObject({ recoverFromFailed: true })
    expect(emitted.some((e) => e.event === "agent_session:completed")).toBe(true)
  })
})

describe("completeBotInvocation sources", () => {
  afterEach(() => {
    mock.restore()
  })

  it("threads completion sources onto the committed bot reply so citations aren't dropped", async () => {
    const { handlers, req, createMessageInTransaction } = arrangeCompletion({ existingSteps: [] })
    const sources = [
      { type: "web", title: "Tide tables", url: "https://tides.example/today", snippet: "High tide 14:32" },
    ]
    req.body = { ...(req.body as Record<string, unknown>), sources }

    await handlers.completeBotInvocation(req, createResponse())

    expect(createMessageInTransaction).toHaveBeenCalledTimes(1)
    expect(createMessageInTransaction.mock.calls[0]?.[2]).toMatchObject({ sources })
  })

  it("commits no sources field when the completion declares none", async () => {
    const { handlers, req, createMessageInTransaction } = arrangeCompletion({ existingSteps: [] })

    await handlers.completeBotInvocation(req, createResponse())

    expect((createMessageInTransaction.mock.calls[0]?.[2] as Record<string, unknown>).sources).toBeUndefined()
  })
})

describe("completeBotInvocation manifest enforcement", () => {
  afterEach(() => {
    mock.restore()
  })

  const sources = [{ type: "web", title: "Tide tables", url: "https://tides.example/today" }]

  it("rejects sources a declared manifest did not allow (INV-11)", async () => {
    const { handlers, req } = arrangeCompletion({
      existingSteps: [],
      manifest: { output: { reply: true, trace: true, sources: false } },
    })
    req.body = { ...(req.body as Record<string, unknown>), sources }

    await expect(handlers.completeBotInvocation(req, createResponse())).rejects.toMatchObject({
      status: 400,
      code: "CAPABILITY_NOT_DECLARED",
    })
  })

  it("allows sources when the declared manifest permits them", async () => {
    const { handlers, req, createMessageInTransaction } = arrangeCompletion({
      existingSteps: [],
      manifest: { output: { reply: true, trace: true, sources: true } },
    })
    req.body = { ...(req.body as Record<string, unknown>), sources }

    await handlers.completeBotInvocation(req, createResponse())

    expect(createMessageInTransaction.mock.calls[0]?.[2]).toMatchObject({ sources })
  })

  it("rejects a reply a declared manifest did not allow", async () => {
    const { handlers, req } = arrangeCompletion({
      existingSteps: [],
      manifest: { output: { reply: false, trace: true, sources: false } },
    })

    await expect(handlers.completeBotInvocation(req, createResponse())).rejects.toMatchObject({
      status: 400,
      code: "CAPABILITY_NOT_DECLARED",
    })
  })

  it("leaves a legacy null-manifest completion unenforced", async () => {
    const { handlers, req, createMessageInTransaction } = arrangeCompletion({ existingSteps: [], manifest: null })
    req.body = { ...(req.body as Record<string, unknown>), sources }

    await handlers.completeBotInvocation(req, createResponse())

    expect(createMessageInTransaction.mock.calls[0]?.[2]).toMatchObject({ sources })
  })
})
