import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as dbModule from "../../../db"
import { OutboxRepository } from "../../../lib/outbox"
import { StreamEventRepository } from "../../streams"
import { withCompanionSession } from "./session"
import { AgentSessionRepository, SessionStatuses, type AgentSession } from "../session-repository"

function makeRunningSession(overrides?: Partial<AgentSession>): AgentSession {
  return {
    id: "session_1",
    streamId: "stream_1",
    personaId: "persona_1",
    triggerMessageId: "msg_trigger_1",
    triggerMessageRevision: 2,
    supersedesSessionId: null,
    status: SessionStatuses.RUNNING,
    currentStep: 0,
    currentStepType: null,
    serverId: "server_1",
    callbackTokenHash: null,
    replyKeyGeneration: null,
    heartbeatAt: new Date("2026-02-19T12:00:00.000Z"),
    responseMessageId: null,
    error: null,
    lastSeenSequence: 10n,
    sentMessageIds: [],
    contextMessageIds: [],
    createdAt: new Date("2026-02-19T12:00:00.000Z"),
    completedAt: null,
    ...overrides,
  }
}

function mockTransactions(): void {
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool, callback) => callback({} as any))
}

describe("withCompanionSession", () => {
  afterEach(() => {
    mock.restore()
  })

  it("returns completed when completion commit succeeds even if session is superseded afterwards", async () => {
    const session = makeRunningSession()
    const completedSession = makeRunningSession({
      status: SessionStatuses.COMPLETED,
      sentMessageIds: ["msg_agent_1"],
      contextMessageIds: [],
      responseMessageId: "msg_agent_1",
      lastSeenSequence: 11n,
      completedAt: new Date("2026-02-19T12:01:00.000Z"),
    })

    mockTransactions()
    spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue(null)
    spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue(session)
    spyOn(AgentSessionRepository, "completeSession").mockResolvedValue(completedSession)
    spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([])
    const findByIdSpy = spyOn(AgentSessionRepository, "findById").mockResolvedValue(
      makeRunningSession({
        status: SessionStatuses.SUPERSEDED,
        completedAt: new Date("2026-02-19T12:01:05.000Z"),
      })
    )

    spyOn(StreamEventRepository, "insert").mockResolvedValue({
      id: "evt_1",
      streamId: "stream_1",
      sequence: 1n,
      eventType: "agent_session:started",
      payload: {},
      actorId: "persona_1",
      actorType: "persona",
      createdAt: new Date(),
    } as any)
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await withCompanionSession(
      {
        pool: {} as any,
        triggerMessageId: "msg_trigger_1",
        streamId: "stream_1",
        personaId: "persona_1",
        personaName: "Ariadne",
        workspaceId: "ws_1",
        serverId: "server_1",
        initialSequence: 10n,
      },
      async () => ({
        messagesSent: 1,
        sentMessageIds: ["msg_agent_1"],
        lastSeenSequence: 11n,
      })
    )

    expect(result).toEqual({
      status: "completed",
      sessionId: "session_1",
      messagesSent: 1,
      sentMessageIds: ["msg_agent_1"],
      lastSeenSequence: 11n,
    })
    expect(findByIdSpy).not.toHaveBeenCalled()
  })

  it("returns skipped when session is superseded before completion commit", async () => {
    const session = makeRunningSession()
    const stepsSpy = spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([])

    mockTransactions()
    spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue(null)
    spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue(session)
    spyOn(AgentSessionRepository, "completeSession").mockResolvedValue(null)
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(
      makeRunningSession({
        status: SessionStatuses.SUPERSEDED,
        completedAt: new Date("2026-02-19T12:01:05.000Z"),
      })
    )

    spyOn(StreamEventRepository, "insert").mockResolvedValue({
      id: "evt_1",
      streamId: "stream_1",
      sequence: 1n,
      eventType: "agent_session:started",
      payload: {},
      actorId: "persona_1",
      actorType: "persona",
      createdAt: new Date(),
    } as any)
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await withCompanionSession(
      {
        pool: {} as any,
        triggerMessageId: "msg_trigger_1",
        streamId: "stream_1",
        personaId: "persona_1",
        personaName: "Ariadne",
        workspaceId: "ws_1",
        serverId: "server_1",
        initialSequence: 10n,
      },
      async () => ({
        messagesSent: 0,
        sentMessageIds: [],
        lastSeenSequence: 11n,
      })
    )

    expect(result).toEqual({
      status: "skipped",
      sessionId: "session_1",
      reason: "session superseded before completion",
    })
    expect(stepsSpy).not.toHaveBeenCalled()
  })

  it("does not resume when guarded RUNNING transition loses to terminal status change", async () => {
    mockTransactions()

    spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue(
      makeRunningSession({
        status: SessionStatuses.FAILED,
        completedAt: new Date("2026-02-19T12:01:00.000Z"),
      })
    )
    const updateStatusSpy = spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue(null)
    const insertRunningSpy = spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue(null)
    const insertEventSpy = spyOn(StreamEventRepository, "insert").mockResolvedValue({} as any)
    const insertOutboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await withCompanionSession(
      {
        pool: {} as any,
        triggerMessageId: "msg_trigger_1",
        streamId: "stream_1",
        personaId: "persona_1",
        personaName: "Ariadne",
        workspaceId: "ws_1",
        serverId: "server_1",
        initialSequence: 10n,
      },
      async () => ({
        messagesSent: 1,
        sentMessageIds: ["msg_agent_1"],
        lastSeenSequence: 11n,
      })
    )

    expect(result).toEqual({
      status: "skipped",
      sessionId: null,
      reason: "failed to resume session",
    })
    expect(updateStatusSpy).toHaveBeenCalledWith(
      {},
      "session_1",
      SessionStatuses.RUNNING,
      expect.objectContaining({
        onlyIfStatusIn: [SessionStatuses.RUNNING, SessionStatuses.PENDING, SessionStatuses.FAILED],
      })
    )
    expect(insertRunningSpy).not.toHaveBeenCalled()
    expect(insertEventSpy).not.toHaveBeenCalled()
    expect(insertOutboxSpy).not.toHaveBeenCalled()
  })
})
