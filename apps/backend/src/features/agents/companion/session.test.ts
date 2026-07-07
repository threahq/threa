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
    abortRequestedAt: null,
    responseMessageId: null,
    error: null,
    lastSeenSequence: 10n,
    sentMessageIds: [],
    contextMessageIds: [],
    episodeSummary: null,
    responseValidationFailed: false,
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
      episodeSummary: null,
      responseValidationFailed: false,
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

  async function runFailingSession(retryAccounting?: { attempt: number; maxAttempts: number }) {
    const session = makeRunningSession()
    mockTransactions()
    spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue(null)
    spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue(session)
    // The catch checks the latest status (not DELETED/SUPERSEDED) before failing.
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(session)
    spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue(
      makeRunningSession({ status: SessionStatuses.FAILED })
    )
    spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([])
    const insertEventSpy = spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_fail" } as any)
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
        ...retryAccounting,
      },
      async () => {
        throw new Error("boom")
      }
    )
    return { result, insertEventSpy, insertOutboxSpy }
  }

  it("emits a non-terminal agent_session:interrupted on a retryable failure", async () => {
    const { result, insertEventSpy, insertOutboxSpy } = await runFailingSession({ attempt: 0, maxAttempts: 5 })

    expect(result).toEqual({ status: "failed", sessionId: "session_1", willRetry: true })
    expect(insertEventSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "agent_session:interrupted",
        payload: expect.objectContaining({ sessionId: "session_1", attempt: 0, maxAttempts: 5, error: "Error: boom" }),
      })
    )
    expect(insertOutboxSpy).toHaveBeenCalledWith(expect.anything(), "agent_session:interrupted", expect.anything())
  })

  it("emits terminal agent_session:failed on the last attempt", async () => {
    const { result, insertEventSpy, insertOutboxSpy } = await runFailingSession({ attempt: 4, maxAttempts: 5 })

    expect(result).toEqual({ status: "failed", sessionId: "session_1", willRetry: false })
    expect(insertEventSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "agent_session:failed" })
    )
    expect(insertOutboxSpy).toHaveBeenCalledWith(expect.anything(), "agent_session:failed", expect.anything())
  })

  it("treats a failure as terminal when retry accounting is absent (non-queue callers)", async () => {
    const { result, insertEventSpy } = await runFailingSession()

    expect(result).toEqual({ status: "failed", sessionId: "session_1", willRetry: false })
    expect(insertEventSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "agent_session:failed" })
    )
  })
})

// The running-session slot is the partial unique index on
// agent_sessions(stream_id) WHERE status='running'
// (20260109155152_agent_session_one_running.sql, INV-20). withCompanionSession
// keys the session on the *addressed* stream id it is handed — persona-agent
// passes the thread's own id (or, for a channel mention, the freshly created
// thread's id), never a re-resolved root. So a channel/scratchpad and a thread
// beneath it hold distinct slots and run concurrently, while two turns targeting
// the same thread collide on the index and the second serializes to a no-op.
describe("per-stream session concurrency (roadmap 3.2)", () => {
  afterEach(() => {
    mock.restore()
  })

  it("keys each session on its addressed stream id, so a channel and its thread occupy distinct slots and both run", async () => {
    mockTransactions()
    spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue(null)
    const insertSpy = spyOn(AgentSessionRepository, "insertRunningOrSkip").mockImplementation(async (_db, params) =>
      makeRunningSession({ id: `session_${params.streamId}`, streamId: params.streamId })
    )
    spyOn(AgentSessionRepository, "completeSession").mockImplementation(async (_db, id) =>
      makeRunningSession({ id, status: SessionStatuses.COMPLETED, completedAt: new Date("2026-02-19T12:01:00.000Z") })
    )
    spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([])
    spyOn(StreamEventRepository, "insert").mockResolvedValue({} as any)
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const base = {
      pool: {} as any,
      personaId: "persona_1",
      personaName: "Ariadne",
      workspaceId: "ws_1",
      serverId: "server_1",
      initialSequence: 10n,
    }
    const work = async () => ({ messagesSent: 1, sentMessageIds: ["msg_agent_1"], lastSeenSequence: 11n })

    const channelResult = await withCompanionSession(
      { ...base, triggerMessageId: "msg_channel", streamId: "stream_channel" },
      work
    )
    const threadResult = await withCompanionSession(
      { ...base, triggerMessageId: "msg_thread", streamId: "stream_thread_under_channel" },
      work
    )

    expect(channelResult.status).toBe("completed")
    expect(threadResult.status).toBe("completed")
    expect(insertSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ streamId: "stream_channel" }))
    expect(insertSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ streamId: "stream_thread_under_channel" })
    )
  })

  it("serializes a second turn in the same stream: the running-index conflict (null insert) skips instead of running a duplicate", async () => {
    mockTransactions()
    // No prior session for this trigger message, but a concurrent turn already
    // holds the thread's running slot, so INSERT ... ON CONFLICT DO NOTHING
    // returns no row.
    spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue(null)
    spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue(null)
    const eventSpy = spyOn(StreamEventRepository, "insert").mockResolvedValue({} as any)
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await withCompanionSession(
      {
        pool: {} as any,
        triggerMessageId: "msg_second_in_thread",
        streamId: "stream_thread",
        personaId: "persona_1",
        personaName: "Ariadne",
        workspaceId: "ws_1",
        serverId: "server_1",
        initialSequence: 10n,
      },
      async () => ({ messagesSent: 1, sentMessageIds: ["msg_agent_1"], lastSeenSequence: 11n })
    )

    expect(result).toEqual({
      status: "skipped",
      sessionId: null,
      reason: "agent already running for stream",
    })
    expect(eventSpy).not.toHaveBeenCalled()
    expect(outboxSpy).not.toHaveBeenCalled()
  })
})
