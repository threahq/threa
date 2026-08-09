import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import type { Message } from "../messaging"
import { MessageRepository } from "../messaging"
import type { MemoServiceLike, CaptureSessionReflectionResult } from "../memos"
import { AgentSessionRepository, SessionStatuses, type AgentSession, type AgentSessionStep } from "./session-repository"
import { ReflectiveCaptureService } from "./reflective-capture-service"

function makeSession(overrides?: Partial<AgentSession>): AgentSession {
  return {
    id: "session_1",
    streamId: "stream_1",
    personaId: "persona_1",
    triggerMessageId: "msg_trigger_1",
    triggerMessageRevision: null,
    supersedesSessionId: null,
    status: SessionStatuses.COMPLETED,
    currentStep: 0,
    currentStepType: null,
    serverId: null,
    callbackTokenHash: null,
    replyKeyGeneration: null,
    heartbeatAt: null,
    abortRequestedAt: null,
    responseMessageId: "msg_agent_1",
    error: null,
    lastSeenSequence: 10n,
    sentMessageIds: ["msg_agent_1"],
    contextMessageIds: [],
    episodeSummary: null,
    responseValidationFailed: false,
    reflectiveCapturedAt: null,
    createdAt: new Date("2026-06-10T09:00:00.000Z"),
    completedAt: new Date("2026-06-10T09:05:00.000Z"),
    ...overrides,
  }
}

function makeMessage(id: string, content: string): Message {
  return {
    id,
    streamId: "stream_1",
    sequence: 1n,
    authorId: "usr_1",
    authorType: "user",
    contentJson: { type: "doc", content: [] },
    contentMarkdown: content,
    replyCount: 0,
    reactions: {},
    metadata: {},
    conversationIntent: null,
    clientMessageId: null,
    sentVia: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date("2026-06-10T09:00:00.000Z"),
    ciphertext: null,
    envelope: null,
    e2eVersion: null,
  }
}

/** A turn_digest step carrying research findings — the reflective-capture gate. */
function digestStep(findings: string): AgentSessionStep {
  return {
    id: "step_1",
    sessionId: "session_1",
    stepNumber: 1,
    stepType: "turn_digest",
    content: { findings },
    contentCiphertext: null,
    contentEnvelope: null,
    sources: null,
    messageId: null,
    tokensUsed: null,
    startedAt: new Date("2026-06-10T09:01:00.000Z"),
    completedAt: new Date("2026-06-10T09:02:00.000Z"),
  }
}

function makeMemoService(result: CaptureSessionReflectionResult) {
  const captureSessionReflection = mock(async () => result)
  const service = {
    processBatch: async () => ({ processed: 0, memosCreated: 0 }),
    saveMemo: async () => ({ ok: false as const, reason: "no_source_messages" as const }),
    saveMemoGenerated: async () => ({ ok: false as const, reason: "no_source_messages" as const }),
    captureSessionReflection,
  } satisfies MemoServiceLike
  return { service, captureSessionReflection }
}

describe("ReflectiveCaptureService", () => {
  afterEach(() => mock.restore())

  function service(memoService: MemoServiceLike) {
    return new ReflectiveCaptureService({ pool: {} as Pool, memoService })
  }

  test("captures a research session: claims the marker then delegates to the memo pipeline", async () => {
    const { service: memoService, captureSessionReflection } = makeMemoService({
      classified: true,
      captured: 1,
      deduped: 0,
    })
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(makeSession())
    spyOn(MessageRepository, "findById").mockResolvedValue(makeMessage("msg_trigger_1", "how do we deploy?"))
    spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([
      digestStep("Deploys run Fridays after the smoke suite."),
    ])
    spyOn(MessageRepository, "findByIds").mockResolvedValue(
      new Map([["msg_agent_1", makeMessage("msg_agent_1", "We deploy on Fridays only.")]])
    )
    const claim = spyOn(AgentSessionRepository, "setReflectiveCaptured").mockResolvedValue(true)

    const result = await service(memoService).capture({ workspaceId: "ws_1", sessionId: "session_1" })

    expect(result).toEqual({ captured: 1 })
    expect(claim).toHaveBeenCalledTimes(1)
    // Anchored to the real trigger message, participants resolved from it.
    expect(captureSessionReflection).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_1",
        streamId: "stream_1",
        sessionId: "session_1",
        anchorMessageId: "msg_trigger_1",
        participantIds: ["usr_1"],
      })
    )
  })

  test("no-ops without claiming when the session is not completed", async () => {
    const { service: memoService, captureSessionReflection } = makeMemoService({
      classified: false,
      captured: 0,
      deduped: 0,
    })
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(makeSession({ status: SessionStatuses.RUNNING }))
    const claim = spyOn(AgentSessionRepository, "setReflectiveCaptured").mockResolvedValue(true)

    const result = await service(memoService).capture({ workspaceId: "ws_1", sessionId: "session_1" })

    expect(result).toEqual({ captured: 0 })
    expect(claim).not.toHaveBeenCalled()
    expect(captureSessionReflection).not.toHaveBeenCalled()
  })

  test("no-ops when the session was already captured (idempotent)", async () => {
    const { service: memoService, captureSessionReflection } = makeMemoService({
      classified: false,
      captured: 0,
      deduped: 0,
    })
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(
      makeSession({ reflectiveCapturedAt: new Date("2026-06-10T09:06:00.000Z") })
    )
    const claim = spyOn(AgentSessionRepository, "setReflectiveCaptured").mockResolvedValue(true)

    const result = await service(memoService).capture({ workspaceId: "ws_1", sessionId: "session_1" })

    expect(result).toEqual({ captured: 0 })
    expect(claim).not.toHaveBeenCalled()
    expect(captureSessionReflection).not.toHaveBeenCalled()
  })

  test("claims but does not capture a session with no research residue", async () => {
    const { service: memoService, captureSessionReflection } = makeMemoService({
      classified: false,
      captured: 0,
      deduped: 0,
    })
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(makeSession())
    spyOn(MessageRepository, "findById").mockResolvedValue(makeMessage("msg_trigger_1", "hi"))
    // No turn_digest steps → no research → skip, but claim so we don't re-evaluate.
    spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([])
    spyOn(MessageRepository, "findByIds").mockResolvedValue(
      new Map([["msg_agent_1", makeMessage("msg_agent_1", "hello")]])
    )
    const claim = spyOn(AgentSessionRepository, "setReflectiveCaptured").mockResolvedValue(true)

    const result = await service(memoService).capture({ workspaceId: "ws_1", sessionId: "session_1" })

    expect(result).toEqual({ captured: 0 })
    expect(claim).toHaveBeenCalledTimes(1)
    expect(captureSessionReflection).not.toHaveBeenCalled()
  })

  test("releases the claim when the capture work throws, so a retry can recover", async () => {
    const captureSessionReflection = mock(async () => {
      throw new Error("embed provider timeout")
    })
    const memoService = {
      processBatch: async () => ({ processed: 0, memosCreated: 0 }),
      saveMemo: async () => ({ ok: false as const, reason: "no_source_messages" as const }),
      saveMemoGenerated: async () => ({ ok: false as const, reason: "no_source_messages" as const }),
      captureSessionReflection,
    } satisfies MemoServiceLike
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(makeSession())
    spyOn(MessageRepository, "findById").mockResolvedValue(makeMessage("msg_trigger_1", "how do we deploy?"))
    spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([digestStep("Deploys run Fridays.")])
    spyOn(MessageRepository, "findByIds").mockResolvedValue(
      new Map([["msg_agent_1", makeMessage("msg_agent_1", "We deploy Fridays.")]])
    )
    spyOn(AgentSessionRepository, "setReflectiveCaptured").mockResolvedValue(true)
    const release = spyOn(AgentSessionRepository, "clearReflectiveCaptured").mockResolvedValue(undefined)

    // The error propagates (so the job retries), and the claim is released first.
    await expect(service(memoService).capture({ workspaceId: "ws_1", sessionId: "session_1" })).rejects.toThrow(
      "embed provider timeout"
    )
    expect(release).toHaveBeenCalledWith(expect.anything(), "session_1")
  })

  test("no-ops when it loses the claim race to a concurrent delivery", async () => {
    const { service: memoService, captureSessionReflection } = makeMemoService({
      classified: false,
      captured: 0,
      deduped: 0,
    })
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(makeSession())
    spyOn(MessageRepository, "findById").mockResolvedValue(makeMessage("msg_trigger_1", "how do we deploy?"))
    spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([digestStep("Deploys run Fridays.")])
    spyOn(MessageRepository, "findByIds").mockResolvedValue(new Map())
    // CAS lost — another delivery already claimed it.
    spyOn(AgentSessionRepository, "setReflectiveCaptured").mockResolvedValue(false)

    const result = await service(memoService).capture({ workspaceId: "ws_1", sessionId: "session_1" })

    expect(result).toEqual({ captured: 0 })
    expect(captureSessionReflection).not.toHaveBeenCalled()
  })
})
