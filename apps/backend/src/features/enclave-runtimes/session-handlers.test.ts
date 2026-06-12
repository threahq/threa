import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import type { Server } from "socket.io"
import { AuthorTypes, ENCLAVE_CALLBACK_TOKEN_HEADER } from "@threa/types"
import * as db from "../../db"
import { HttpError } from "../../lib/errors"
import { AgentSessionRepository, SessionStatuses } from "../agents"
import { StreamRepository, StreamEventRepository } from "../streams"
import { E2eStreamsRepository } from "../e2e-streams"
import { OutboxRepository } from "../../lib/outbox"
import { MessageRepository, type EventService } from "../messaging"
import type { AICostServiceLike } from "../ai-usage"
import type { QueueManager } from "../../lib/queue"
import { createEnclaveSessionHandlers } from "./session-handlers"
import { hashCallbackToken } from "./callback-token"

const pool = {} as Pool

function fakeRes(): Response & { statusCode: number; jsonBody?: unknown } {
  const res = {
    statusCode: 0,
    jsonBody: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.jsonBody = body
      return this
    },
    end() {
      return this
    },
  }
  return res as unknown as Response & { statusCode: number; jsonBody?: unknown }
}

function req(id: string | undefined, body: unknown, headers: Record<string, string> = {}): Request {
  return {
    params: { id },
    body,
    header: (name: string) => headers[name],
  } as unknown as Request
}

const SESSION = {
  id: "session_1",
  streamId: "stream_1",
  personaId: "persona_ariadne",
  status: SessionStatuses.RUNNING,
  lastSeenSequence: null,
  triggerMessageId: "msg_trigger",
  createdAt: new Date("2026-05-30T00:00:00.000Z"),
} as unknown as Awaited<ReturnType<typeof AgentSessionRepository.findById>>

const MESSAGE_BODY = {
  messageId: "msg_a",
  ciphertext: "Y3Q=",
  envelope: { v: 2, keyGeneration: 0, iv: "aXY=", aad: "YWFk" },
}
const COMPLETE_BODY = { messageIds: ["msg_a", "msg_b"], model: "anthropic/claude-sonnet-4.6" }
const COMPLETE_BODY_WITH_USAGE = {
  ...COMPLETE_BODY,
  usage: { promptTokens: 1200, completionTokens: 340, cost: 0.0123 },
}

const STEP_BODY = {
  stepId: "step_a",
  stepType: "thinking",
  ciphertext: "Y3Q=",
  envelope: { v: 2, keyGeneration: 0, iv: "aXY=", aad: "YWFk" },
  durationMs: 1500,
}

// A tool's step:start — no content yet (the result isn't known), so ciphertext +
// envelope are absent. Only stepType + stepId travel.
const STEP_START_BODY = {
  stepId: "step_b",
  stepType: "web_search",
}

afterEach(() => mock.restore())

// Fake socket server exposing the `emit` spy so step-broadcast assertions can
// observe the relayed payload (io is required — the API process always has it).
function fakeIo() {
  const emit = mock((_event: string, _payload: unknown) => {})
  const io = { to: mock((_room: string) => ({ emit })) } as unknown as Server
  return { io, emit }
}

function fakeJobQueue() {
  const send = mock(async (_queue: string, _data: unknown) => "job_test")
  return { jobQueue: { send } as unknown as QueueManager, send }
}

function fakeCostService() {
  const recordUsage = mock(async (_params: Record<string, unknown>) => {})
  return { costService: { recordUsage } as unknown as AICostServiceLike, recordUsage }
}

function makeHandlers(createMessage = mock(async (_input: Record<string, unknown>) => ({}) as never)) {
  const eventService = { createMessage } as unknown as EventService
  const { io, emit } = fakeIo()
  const { jobQueue, send } = fakeJobQueue()
  const { costService, recordUsage } = fakeCostService()
  return {
    handlers: createEnclaveSessionHandlers({ pool, eventService, io, jobQueue, costService }),
    createMessage,
    io,
    emit,
    send,
    recordUsage,
  }
}

describe("createEnclaveSessionHandlers.message", () => {
  it("404s when the session is gone", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(null)
    const { handlers } = makeHandlers()
    await expect(handlers.message(req("session_1", MESSAGE_BODY), fakeRes())).rejects.toMatchObject({ status: 404 })
  })

  it("409s when the session is no longer running", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue({ ...SESSION!, status: SessionStatuses.FAILED })
    const { handlers } = makeHandlers()
    await expect(handlers.message(req("session_1", MESSAGE_BODY), fakeRes())).rejects.toMatchObject({ status: 409 })
  })

  it("writes the streamed sealed reply and 204s", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
    spyOn(StreamRepository, "findById").mockResolvedValue({ workspaceId: "ws_1" } as never)
    const { handlers, createMessage } = makeHandlers()
    const res = fakeRes()

    await handlers.message(req("session_1", MESSAGE_BODY), res)

    expect(res.statusCode).toBe(204)
    expect(createMessage).toHaveBeenCalledTimes(1)
    expect(createMessage.mock.calls[0]![0]).toMatchObject({
      id: "msg_a",
      workspaceId: "ws_1",
      streamId: "stream_1",
      sessionId: "session_1", // stamped for session→messages reverse lookup / cleanup
      authorId: "persona_ariadne",
      authorType: AuthorTypes.PERSONA,
      e2eVersion: 2,
      accessibleStreamIds: ["stream_1"],
      clientMessageId: "enclave-reply:session_1:msg_a",
    })
  })
})

describe("createEnclaveSessionHandlers.sealedName", () => {
  const NAME_BODY = { ciphertext: "Y3Q=", envelope: { v: 2, keyGeneration: 0, iv: "aXY=", aad: "YWFk" } }

  it("stores the sealed title (first-write-wins) and broadcasts stream:updated", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
    spyOn(StreamRepository, "findById").mockResolvedValue({ id: "stream_1", workspaceId: "ws_1" } as never)
    spyOn(db, "withTransaction").mockImplementation(((_pool: unknown, cb: (c: unknown) => unknown) => cb({})) as never)
    const setName = spyOn(E2eStreamsRepository, "setSealedNameIfAbsent").mockResolvedValue(true)
    const insert = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    const { handlers } = makeHandlers()
    const res = fakeRes()

    await handlers.sealedName(req("session_1", NAME_BODY), res)

    expect(res.statusCode).toBe(204)
    expect(setName).toHaveBeenCalledWith({}, "ws_1", "stream_1", expect.objectContaining({ ciphertext: "Y3Q=" }))
    expect(insert).toHaveBeenCalledWith({}, "stream:updated", expect.objectContaining({ streamId: "stream_1" }))
  })

  it("does not broadcast when the scratchpad is already named (no-op)", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
    spyOn(StreamRepository, "findById").mockResolvedValue({ id: "stream_1", workspaceId: "ws_1" } as never)
    spyOn(db, "withTransaction").mockImplementation(((_pool: unknown, cb: (c: unknown) => unknown) => cb({})) as never)
    spyOn(E2eStreamsRepository, "setSealedNameIfAbsent").mockResolvedValue(false)
    const insert = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    const { handlers } = makeHandlers()
    const res = fakeRes()

    await handlers.sealedName(req("session_1", NAME_BODY), res)

    expect(res.statusCode).toBe(204)
    expect(insert).not.toHaveBeenCalled()
  })

  it("409s when the session is no longer running", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue({ ...SESSION!, status: SessionStatuses.FAILED })
    const { handlers } = makeHandlers()
    await expect(handlers.sealedName(req("session_1", NAME_BODY), fakeRes())).rejects.toMatchObject({ status: 409 })
  })
})

describe("createEnclaveSessionHandlers.complete", () => {
  it("400s an invalid body", async () => {
    const { handlers } = makeHandlers()
    await expect(handlers.complete(req("session_1", { bad: true }), fakeRes())).rejects.toMatchObject({ status: 400 })
  })

  it("404s when the session is gone", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(null)
    const { handlers } = makeHandlers()
    await expect(handlers.complete(req("session_1", COMPLETE_BODY), fakeRes())).rejects.toMatchObject({ status: 404 })
  })

  it("no-ops (200) when the session is already completed", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue({ ...SESSION!, status: SessionStatuses.COMPLETED })
    const { handlers } = makeHandlers()
    const res = fakeRes()
    await handlers.complete(req("session_1", COMPLETE_BODY), res)
    expect(res.statusCode).toBe(200)
  })

  it("409s when the session is no longer running", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue({ ...SESSION!, status: SessionStatuses.FAILED })
    const { handlers } = makeHandlers()
    await expect(handlers.complete(req("session_1", COMPLETE_BODY), fakeRes())).rejects.toMatchObject({ status: 409 })
  })

  it("records the sent ids, completes the session, and emits agent_session:completed", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
    const complete = spyOn(AgentSessionRepository, "completeSession").mockResolvedValue(SESSION)
    spyOn(StreamRepository, "findById").mockResolvedValue({ workspaceId: "ws_1" } as never)
    spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([] as never)
    const tx = {} as never
    spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, fn: (client: never) => unknown) =>
      fn(tx)) as never)
    const insertEvent = spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
    const insertOutbox = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    // No user message arrived during the turn → no follow-up dispatch.
    spyOn(StreamEventRepository, "getMessageSequence").mockResolvedValue(5n)
    spyOn(StreamEventRepository, "getLatestUnseenUserMessage").mockResolvedValue(null)
    const { handlers, createMessage, io, emit, send, recordUsage } = makeHandlers()
    const res = fakeRes()

    await handlers.complete(req("session_1", COMPLETE_BODY), res)

    expect(res.statusCode).toBe(204)
    expect(send).not.toHaveBeenCalled() // nothing unseen → no catch-up turn
    expect(recordUsage).not.toHaveBeenCalled() // no usage in the ack → nothing to record
    expect(createMessage).not.toHaveBeenCalled() // replies were already streamed via /messages
    expect(complete).toHaveBeenCalledTimes(1)
    // Completion + event are one atomic transaction (INV-7): completeSession runs
    // on the tx client, not the bare pool.
    expect(complete.mock.calls[0]![0]).toBe(tx)
    expect(complete.mock.calls[0]![2]).toMatchObject({
      sentMessageIds: ["msg_a", "msg_b"],
      responseMessageId: "msg_a",
    })
    // The completed lifecycle event is what clears the inline stream-view trace
    // (useAgentActivity) — emitted via a stream event + outbox, like in-process.
    expect(insertEvent.mock.calls[0]![1]).toMatchObject({
      streamId: "stream_1",
      eventType: "agent_session:completed",
      payload: { sessionId: "session_1", messageCount: 2 },
    })
    expect(insertOutbox.mock.calls[0]![1]).toBe("agent_session:completed")
    // And a live-open trace dialog (session room) is transitioned to completed.
    expect(io.to).toHaveBeenCalledWith("ws:ws_1:agent_session:session_1")
    expect(emit.mock.calls.some((c) => c[0] === "agent_session:completed")).toBe(true)
  })

  it("records the turn's token + cost usage against the workspace and invoking user", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
    spyOn(AgentSessionRepository, "completeSession").mockResolvedValue(SESSION)
    spyOn(StreamRepository, "findById").mockResolvedValue({ workspaceId: "ws_1" } as never)
    spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([] as never)
    const tx = {} as never
    spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, fn: (client: never) => unknown) =>
      fn(tx)) as never)
    spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    spyOn(StreamEventRepository, "getMessageSequence").mockResolvedValue(5n)
    spyOn(StreamEventRepository, "getLatestUnseenUserMessage").mockResolvedValue(null)
    // The invoking user is the trigger message's author (the session stores only its id).
    spyOn(MessageRepository, "findById").mockResolvedValue({ authorId: "usr_owner" } as never)
    const { handlers, recordUsage } = makeHandlers()
    const res = fakeRes()

    await handlers.complete(req("session_1", COMPLETE_BODY_WITH_USAGE), res)

    expect(res.statusCode).toBe(204)
    expect(recordUsage).toHaveBeenCalledTimes(1)
    // Same recording path companion turns use (#9): attributed to the workspace +
    // invoking user with origin "user". Provider is re-derived from the bare
    // OpenRouter model id; cost is OpenRouter's billed USD — accounting, never
    // content (INV-E7).
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({
      workspaceId: "ws_1",
      userId: "usr_owner",
      sessionId: "session_1",
      functionId: "enclave-agent-loop",
      model: "anthropic/claude-sonnet-4.6",
      provider: "openrouter",
      origin: "user",
      usage: { promptTokens: 1200, completionTokens: 340, totalTokens: 1540, cost: 0.0123 },
    })
  })

  it("does not record usage when the completion lost the RUNNING→COMPLETED race", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
    // Lost the gated transition to a concurrent redelivery.
    spyOn(AgentSessionRepository, "completeSession").mockResolvedValue(null)
    spyOn(StreamRepository, "findById").mockResolvedValue({ workspaceId: "ws_1" } as never)
    const tx = {} as never
    spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, fn: (client: never) => unknown) =>
      fn(tx)) as never)
    const findMessage = spyOn(MessageRepository, "findById")
    const { handlers, recordUsage } = makeHandlers()
    const res = fakeRes()

    await handlers.complete(req("session_1", COMPLETE_BODY_WITH_USAGE), res)

    expect(res.statusCode).toBe(204)
    expect(recordUsage).not.toHaveBeenCalled() // gated on the won transition → no double-charge
    expect(findMessage).not.toHaveBeenCalled()
  })

  it("dispatches a catch-up enclave turn for a user message that arrived mid-turn", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
    spyOn(AgentSessionRepository, "completeSession").mockResolvedValue(SESSION)
    spyOn(StreamRepository, "findById").mockResolvedValue({ workspaceId: "ws_1" } as never)
    spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([] as never)
    const tx = {} as never
    spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, fn: (client: never) => unknown) =>
      fn(tx)) as never)
    spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    // The trigger was at sequence 5; a user message landed at 9 while the turn ran.
    spyOn(StreamEventRepository, "getMessageSequence").mockResolvedValue(5n)
    spyOn(StreamEventRepository, "getLatestUnseenUserMessage").mockResolvedValue({
      messageId: "msg_new",
      authorId: "usr_1",
      sequence: 9n,
    })
    const { handlers, send } = makeHandlers()
    const res = fakeRes()

    await handlers.complete(req("session_1", COMPLETE_BODY), res)

    expect(res.statusCode).toBe(204)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0]).toBe("enclave.invoke")
    expect(send.mock.calls[0]![1]).toMatchObject({
      workspaceId: "ws_1",
      streamId: "stream_1",
      messageId: "msg_new",
      triggeredBy: "usr_1",
    })
  })

  it("does not emit the completed event when the session raced to a terminal state", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
    // Won by another redelivery between assertRunning and the transaction.
    spyOn(AgentSessionRepository, "completeSession").mockResolvedValue(null)
    spyOn(StreamRepository, "findById").mockResolvedValue({ workspaceId: "ws_1" } as never)
    const tx = {} as never
    spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, fn: (client: never) => unknown) =>
      fn(tx)) as never)
    const insertEvent = spyOn(StreamEventRepository, "insert")
    const { handlers, emit } = makeHandlers()
    const res = fakeRes()

    await handlers.complete(req("session_1", COMPLETE_BODY), res)

    expect(res.statusCode).toBe(204)
    expect(insertEvent).not.toHaveBeenCalled() // no double-emit
    expect(emit).not.toHaveBeenCalled()
  })

  it("still completes the session durably when the stream is gone, skipping broadcast", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
    const complete = spyOn(AgentSessionRepository, "completeSession").mockResolvedValue(SESSION)
    spyOn(StreamRepository, "findById").mockResolvedValue(null) // stream deleted mid-turn
    const tx = {} as never
    spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, fn: (client: never) => unknown) =>
      fn(tx)) as never)
    const insertEvent = spyOn(StreamEventRepository, "insert")
    const { handlers, emit } = makeHandlers()
    const res = fakeRes()

    await handlers.complete(req("session_1", COMPLETE_BODY), res)

    // The session is still marked COMPLETED (durable); only the broadcast is skipped.
    expect(res.statusCode).toBe(204)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(insertEvent).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })
})

describe("createEnclaveSessionHandlers.fail", () => {
  const FAIL_BODY = { errorName: "AbortError" }

  it("400s an invalid body", async () => {
    const { handlers } = makeHandlers()
    await expect(handlers.fail(req("session_1", { bad: true }), fakeRes())).rejects.toMatchObject({ status: 400 })
  })

  it("404s when the session is gone", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(null)
    const { handlers } = makeHandlers()
    await expect(handlers.fail(req("session_1", FAIL_BODY), fakeRes())).rejects.toMatchObject({ status: 404 })
  })

  it("409s when the session already terminated", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue({ ...SESSION!, status: SessionStatuses.FAILED })
    const { handlers } = makeHandlers()
    await expect(handlers.fail(req("session_1", FAIL_BODY), fakeRes())).rejects.toMatchObject({ status: 409 })
  })

  it("marks the session FAILED with the scrubbed classification and emits the failed lifecycle", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
    spyOn(StreamRepository, "findById").mockResolvedValue({ workspaceId: "ws_1" } as never)
    spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([] as never)
    const tx = {} as never
    spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, fn: (client: never) => unknown) =>
      fn(tx)) as never)
    const updateStatus = spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue(SESSION)
    const insertEvent = spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
    const insertOutbox = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    const { handlers, io, emit } = makeHandlers()
    const res = fakeRes()

    await handlers.fail(req("session_1", FAIL_BODY), res)

    expect(res.statusCode).toBe(204)
    // FAILED is gated on the RUNNING→FAILED transition and carries the scrubbed
    // classification — the error's class name, never plaintext content (INV-E7).
    expect(updateStatus.mock.calls[0]![2]).toBe(SessionStatuses.FAILED)
    expect(updateStatus.mock.calls[0]![3]).toMatchObject({
      error: "Enclave session failed: AbortError",
      onlyIfStatus: SessionStatuses.RUNNING,
    })
    // The failed lifecycle event/outbox is what clears the inline indicator.
    expect(insertEvent.mock.calls[0]![1]).toMatchObject({
      streamId: "stream_1",
      eventType: "agent_session:failed",
      payload: { sessionId: "session_1", error: "Enclave session failed: AbortError" },
    })
    expect(insertOutbox.mock.calls[0]![1]).toBe("agent_session:failed")
    // And a live-open trace dialog (session room) is transitioned to failed.
    expect(io.to).toHaveBeenCalledWith("ws:ws_1:agent_session:session_1")
    expect(emit.mock.calls.some((c) => c[0] === "agent_session:failed")).toBe(true)
  })

  it("204s without emitting when the session raced to a terminal state under us", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
    spyOn(StreamRepository, "findById").mockResolvedValue({ workspaceId: "ws_1" } as never)
    const tx = {} as never
    spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, fn: (client: never) => unknown) =>
      fn(tx)) as never)
    // Lost the RUNNING→FAILED transition (completed concurrently between
    // assertRunning and the gated update).
    spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue(null)
    const insertEvent = spyOn(StreamEventRepository, "insert")
    const { handlers, emit } = makeHandlers()
    const res = fakeRes()

    await handlers.fail(req("session_1", FAIL_BODY), res)

    expect(res.statusCode).toBe(204)
    expect(insertEvent).not.toHaveBeenCalled() // no double-emit
    expect(emit).not.toHaveBeenCalled()
  })
})

describe("createEnclaveSessionHandlers.stepStarted", () => {
  it("400s an invalid body", async () => {
    const { handlers } = makeHandlers()
    await expect(handlers.stepStarted(req("session_1", { bad: true }), fakeRes())).rejects.toMatchObject({
      status: 400,
    })
  })

  it("404s when the session is gone", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(null)
    const { handlers } = makeHandlers()
    await expect(handlers.stepStarted(req("session_1", STEP_START_BODY), fakeRes())).rejects.toMatchObject({
      status: 404,
    })
  })

  it("409s when the session is no longer running", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue({ ...SESSION!, status: SessionStatuses.FAILED })
    const { handlers } = makeHandlers()
    await expect(handlers.stepStarted(req("session_1", STEP_START_BODY), fakeRes())).rejects.toMatchObject({
      status: 409,
    })
  })

  it("opens an in-flight row (no completedAt) + current_step_type in one tx, broadcasts step:started + progress", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
    spyOn(StreamRepository, "findById").mockResolvedValue({ workspaceId: "ws_1" } as never)
    const tx = {} as never
    spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, fn: (client: never) => unknown) =>
      fn(tx)) as never)
    const append = spyOn(AgentSessionRepository, "appendStep").mockResolvedValue({
      id: "step_b",
      sessionId: "session_1",
      stepNumber: 2,
      stepType: "web_search",
      contentCiphertext: null,
      contentEnvelope: null,
      startedAt: new Date("2026-05-30T00:00:00.000Z"),
      completedAt: null,
    } as never)
    const stepType = spyOn(AgentSessionRepository, "updateCurrentStepType").mockResolvedValue(undefined)
    const { handlers, io, emit } = makeHandlers()
    const res = fakeRes()

    await handlers.stepStarted(req("session_1", STEP_START_BODY), res)

    expect(res.statusCode).toBe(204)
    // The row is opened in-progress — no completedAt — so the dialog renders it live.
    expect(append.mock.calls[0]![0]).toBe(tx)
    expect(append.mock.calls[0]![1]).toMatchObject({ id: "step_b", stepType: "web_search" })
    expect((append.mock.calls[0]![1] as { completedAt?: Date }).completedAt).toBeUndefined()
    expect(stepType).toHaveBeenCalledWith(tx, "session_1", "web_search")

    expect(io.to).toHaveBeenCalledWith("ws:ws_1:agent_session:session_1")
    expect(emit.mock.calls.some((c) => c[0] === "agent_session:step:started")).toBe(true)
    // Inline indicator advances at step *start* (mirrors in-process startStep).
    expect(io.to).toHaveBeenCalledWith("ws:ws_1:stream:stream_1")
    const progress = emit.mock.calls.find((c) => c[0] === "agent_session:progress")
    expect(progress?.[1]).toMatchObject({ sessionId: "session_1", currentStepType: "web_search" })
  })
})

describe("createEnclaveSessionHandlers.steps", () => {
  it("400s an invalid body", async () => {
    const { handlers } = makeHandlers()
    await expect(handlers.steps(req("session_1", { bad: true }), fakeRes())).rejects.toMatchObject({ status: 400 })
  })

  it("404s when the session is gone", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(null)
    const { handlers } = makeHandlers()
    await expect(handlers.steps(req("session_1", STEP_BODY), fakeRes())).rejects.toMatchObject({ status: 404 })
  })

  it("409s when the session is no longer running", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue({ ...SESSION!, status: SessionStatuses.FAILED })
    const { handlers } = makeHandlers()
    await expect(handlers.steps(req("session_1", STEP_BODY), fakeRes())).rejects.toMatchObject({ status: 409 })
  })

  it("finalizes the in-flight step in place (sealed content + completedAt), broadcasts step:completed, and 204s", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
    spyOn(StreamRepository, "findById").mockResolvedValue({ workspaceId: "ws_1" } as never)
    const update = spyOn(AgentSessionRepository, "updateStep").mockResolvedValue({
      id: "step_a",
      sessionId: "session_1",
      stepNumber: 1,
      stepType: "thinking",
      contentCiphertext: "Y3Q=",
      contentEnvelope: STEP_BODY.envelope,
      startedAt: new Date("2026-05-30T00:00:00.000Z"),
      completedAt: new Date("2026-05-30T00:00:01.500Z"),
    } as never)
    const append = spyOn(AgentSessionRepository, "appendStep")
    const { handlers, io, emit } = makeHandlers()
    const res = fakeRes()

    await handlers.steps(req("session_1", STEP_BODY), res)

    expect(res.statusCode).toBe(204)
    // Updates the existing row in place — no insert on the happy path.
    expect(append).not.toHaveBeenCalled()
    expect(update.mock.calls[0]![0]).toBe(pool) // single query → bare pool (INV-30)
    expect(update.mock.calls[0]![1]).toBe("step_a")
    expect(update.mock.calls[0]![2]).toMatchObject({
      contentCiphertext: "Y3Q=", // sealed content — the server never holds plaintext (INV-E7)
      contentEnvelope: STEP_BODY.envelope,
    })
    expect((update.mock.calls[0]![2] as { completedAt?: Date }).completedAt).toBeInstanceOf(Date)

    expect(io.to).toHaveBeenCalledWith("ws:ws_1:agent_session:session_1")
    expect(emit.mock.calls[0]![0]).toBe("agent_session:step:completed")
    const emitted = emit.mock.calls[0]![1] as { sessionId: string; step: Record<string, unknown> }
    expect(emitted.step).toMatchObject({ id: "step_a", stepType: "thinking", contentCiphertext: "Y3Q=" })
    // No progress on the happy path — the indicator already advanced at step:started.
    expect(emit.mock.calls.some((c) => c[0] === "agent_session:progress")).toBe(false)
  })

  it("falls back to a completed insert + progress when the start POST was dropped", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
    spyOn(StreamRepository, "findById").mockResolvedValue({ workspaceId: "ws_1" } as never)
    // No in-flight row to finalize.
    spyOn(AgentSessionRepository, "updateStep").mockResolvedValue(null)
    const tx = {} as never
    spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, fn: (client: never) => unknown) =>
      fn(tx)) as never)
    const append = spyOn(AgentSessionRepository, "appendStep").mockResolvedValue({
      id: "step_a",
      sessionId: "session_1",
      stepNumber: 1,
      stepType: "thinking",
      contentCiphertext: "Y3Q=",
      contentEnvelope: STEP_BODY.envelope,
      startedAt: new Date("2026-05-30T00:00:00.000Z"),
      completedAt: new Date("2026-05-30T00:00:01.500Z"),
    } as never)
    const stepType = spyOn(AgentSessionRepository, "updateCurrentStepType").mockResolvedValue(undefined)
    const { handlers, emit } = makeHandlers()
    const res = fakeRes()

    await handlers.steps(req("session_1", STEP_BODY), res)

    expect(res.statusCode).toBe(204)
    // Inserts a completed row + advances current_step_type so the trace still lands.
    expect(append.mock.calls[0]![0]).toBe(tx)
    expect(append.mock.calls[0]![1]).toMatchObject({ id: "step_a", contentCiphertext: "Y3Q=" })
    expect(stepType).toHaveBeenCalledWith(tx, "session_1", "thinking")
    expect(emit.mock.calls.some((c) => c[0] === "agent_session:step:completed")).toBe(true)
    expect(emit.mock.calls.some((c) => c[0] === "agent_session:progress")).toBe(true)
  })
})

describe("createEnclaveSessionHandlers.substep", () => {
  const SUBSTEP_BODY = {
    stepType: "research",
    ciphertext: "Y3Q=",
    envelope: { v: 2, keyGeneration: 0, iv: "aXY=", aad: "YWFk" },
  }
  const SUBSTEP_WITH_SNAPSHOT = {
    ...SUBSTEP_BODY,
    stepId: "step_a",
    snapshotCiphertext: "c25hcA==",
    snapshotEnvelope: { v: 2, keyGeneration: 0, iv: "aXY=", aad: "YWFk" },
  }

  it("broadcasts the sealed phase to the stream + session rooms without persisting (no snapshot)", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
    spyOn(StreamRepository, "findById").mockResolvedValue({ workspaceId: "ws_1" } as never)
    const update = spyOn(AgentSessionRepository, "updateStep")
    const { handlers, io, emit } = makeHandlers()
    const res = fakeRes()

    await handlers.substep(req("session_1", SUBSTEP_BODY), res)

    expect(res.statusCode).toBe(204)
    expect(update).not.toHaveBeenCalled() // broadcast-only — no step row to persist onto
    expect(io.to).toHaveBeenCalledWith("ws:ws_1:stream:stream_1")
    expect(io.to).toHaveBeenCalledWith("ws:ws_1:agent_session:session_1")
    expect(emit.mock.calls.every((c) => c[0] === "agent_session:substep")).toBe(true)
    expect((emit.mock.calls[0]![1] as { ciphertext: string }).ciphertext).toBe("Y3Q=")
  })

  it("persists the running snapshot onto the in-flight step (sealed, no completion) when one travels", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
    spyOn(StreamRepository, "findById").mockResolvedValue({ workspaceId: "ws_1" } as never)
    const update = spyOn(AgentSessionRepository, "updateStep").mockResolvedValue(null)
    const { handlers, emit } = makeHandlers()
    const res = fakeRes()

    await handlers.substep(req("session_1", SUBSTEP_WITH_SNAPSHOT), res)

    expect(res.statusCode).toBe(204)
    expect(update.mock.calls[0]![1]).toBe("step_a")
    expect(update.mock.calls[0]![2]).toMatchObject({
      contentCiphertext: "c25hcA==",
      contentEnvelope: SUBSTEP_WITH_SNAPSHOT.snapshotEnvelope,
    })
    // No completedAt — the step stays in-flight; the snapshot only seeds refresh recovery.
    expect((update.mock.calls[0]![2] as { completedAt?: Date }).completedAt).toBeUndefined()
    // Still broadcasts the live phase.
    expect(emit.mock.calls.some((c) => c[0] === "agent_session:substep")).toBe(true)
  })
})

describe("createEnclaveSessionHandlers.heartbeat", () => {
  it("400s without a session id", async () => {
    const handlers = createEnclaveSessionHandlers({
      pool,
      eventService: {} as EventService,
      io: fakeIo().io,
      jobQueue: fakeJobQueue().jobQueue,
      costService: fakeCostService().costService,
    })
    await expect(handlers.heartbeat(req(undefined, {}), fakeRes())).rejects.toBeInstanceOf(HttpError)
  })

  it("refreshes the heartbeat and 204s", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
    const beat = spyOn(AgentSessionRepository, "updateHeartbeat").mockResolvedValue(undefined)
    const handlers = createEnclaveSessionHandlers({
      pool,
      eventService: {} as EventService,
      io: fakeIo().io,
      jobQueue: fakeJobQueue().jobQueue,
      costService: fakeCostService().costService,
    })
    const res = fakeRes()
    await handlers.heartbeat(req("session_1", {}), res)
    expect(beat).toHaveBeenCalledWith(pool, "session_1")
    expect(res.statusCode).toBe(204)
  })
})

// Phase 2.4b (E2EE-21): callbacks bind to the session's assigned runner via the
// dispatch-minted token, and a seal under the wrong generation is rejected
// loudly instead of persisting a permanently undecryptable row.
describe("createEnclaveSessionHandlers callback binding (Phase 2.4b)", () => {
  // The row stores only the digest; the runner echoes the cleartext.
  const BOUND_SESSION = {
    ...SESSION!,
    callbackTokenHash: hashCallbackToken("cbtok_good"),
    replyKeyGeneration: 0,
  } as typeof SESSION

  const tokenHeader = (token: string) => ({ [ENCLAVE_CALLBACK_TOKEN_HEADER]: token })

  it("403s a mismatched token without writing anything", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(BOUND_SESSION)
    const { handlers, createMessage } = makeHandlers()
    await expect(
      handlers.message(req("session_1", MESSAGE_BODY, tokenHeader("cbtok_evil")), fakeRes())
    ).rejects.toMatchObject({ status: 403, code: "CALLBACK_TOKEN_MISMATCH" })
    expect(createMessage).not.toHaveBeenCalled()
  })

  it("403s a presented token when the session row carries none", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
    const { handlers } = makeHandlers()
    await expect(
      handlers.message(req("session_1", MESSAGE_BODY, tokenHeader("cbtok_any")), fakeRes())
    ).rejects.toMatchObject({ status: 403, code: "CALLBACK_TOKEN_MISMATCH" })
  })

  it("accepts the matching token and writes the reply", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(BOUND_SESSION)
    spyOn(StreamRepository, "findById").mockResolvedValue({ workspaceId: "ws_1" } as never)
    const { handlers, createMessage } = makeHandlers()
    const res = fakeRes()
    await handlers.message(req("session_1", MESSAGE_BODY, tokenHeader("cbtok_good")), res)
    expect(res.statusCode).toBe(204)
    expect(createMessage).toHaveBeenCalled()
  })

  it("tolerates an absent token on a token-bearing session — rollout phase 1, in-flight sessions drain", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(BOUND_SESSION)
    spyOn(StreamRepository, "findById").mockResolvedValue({ workspaceId: "ws_1" } as never)
    const { handlers } = makeHandlers()
    const res = fakeRes()
    await handlers.message(req("session_1", MESSAGE_BODY), res)
    expect(res.statusCode).toBe(204)
  })

  it("rejects a wrong-generation seal loudly instead of persisting an undecryptable reply", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue({
      ...BOUND_SESSION!,
      replyKeyGeneration: 2,
    } as typeof SESSION)
    const { handlers, createMessage } = makeHandlers()
    await expect(
      // MESSAGE_BODY seals under keyGeneration 0; the session expects 2.
      handlers.message(req("session_1", MESSAGE_BODY, tokenHeader("cbtok_good")), fakeRes())
    ).rejects.toMatchObject({ status: 400, code: "E2E_WRONG_KEY_GENERATION" })
    expect(createMessage).not.toHaveBeenCalled()
  })

  it("passes any generation for sessions dispatched before the column shipped (NULL)", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue({
      ...SESSION!,
      callbackTokenHash: null,
      replyKeyGeneration: null,
    } as typeof SESSION)
    spyOn(StreamRepository, "findById").mockResolvedValue({ workspaceId: "ws_1" } as never)
    const { handlers } = makeHandlers()
    const res = fakeRes()
    await handlers.message(req("session_1", MESSAGE_BODY), res)
    expect(res.statusCode).toBe(204)
  })

  it("binds the heartbeat too — wrong token never refreshes", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(BOUND_SESSION)
    const beat = spyOn(AgentSessionRepository, "updateHeartbeat").mockResolvedValue(undefined)
    const { handlers } = makeHandlers()
    await expect(handlers.heartbeat(req("session_1", {}, tokenHeader("cbtok_evil")), fakeRes())).rejects.toMatchObject({
      status: 403,
    })
    expect(beat).not.toHaveBeenCalled()
  })

  it("rejects a wrong-generation sealed step", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue({
      ...BOUND_SESSION!,
      replyKeyGeneration: 1,
    } as typeof SESSION)
    const { handlers } = makeHandlers()
    await expect(
      handlers.steps(req("session_1", STEP_BODY, tokenHeader("cbtok_good")), fakeRes())
    ).rejects.toMatchObject({ status: 400, code: "E2E_WRONG_KEY_GENERATION" })
  })

  // Every guarded callback route consults the same chokepoint; these pin the
  // per-handler wiring so a regression on any one route fails this file.
  const ENVELOPE = { v: 2, keyGeneration: 0, iv: "aXY=", aad: "YWFk" }
  const mismatchCases: [keyof ReturnType<typeof makeHandlers>["handlers"], unknown][] = [
    ["sealedName", { ciphertext: "Y3Q=", envelope: ENVELOPE }],
    ["stepStarted", STEP_START_BODY],
    ["substep", { stepType: "web_search", ciphertext: "Y3Q=", envelope: ENVELOPE }],
    ["complete", COMPLETE_BODY],
    ["fail", { errorName: "Error" }],
  ]
  for (const [handlerName, body] of mismatchCases) {
    it(`binds ${String(handlerName)} — a wrong token is 403 with nothing written or broadcast`, async () => {
      spyOn(AgentSessionRepository, "findById").mockResolvedValue(BOUND_SESSION)
      const tx = spyOn(db, "withTransaction")
      const { handlers, emit, createMessage } = makeHandlers()
      await expect(
        handlers[handlerName](req("session_1", body, tokenHeader("cbtok_evil")), fakeRes())
      ).rejects.toMatchObject({ status: 403, code: "CALLBACK_TOKEN_MISMATCH" })
      expect(tx).not.toHaveBeenCalled()
      expect(emit).not.toHaveBeenCalled()
      expect(createMessage).not.toHaveBeenCalled()
    })
  }
})
