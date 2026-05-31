import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import type { Server } from "socket.io"
import { AuthorTypes } from "@threa/types"
import * as db from "../../db"
import { HttpError } from "../../lib/errors"
import { AgentSessionRepository, SessionStatuses } from "../agents"
import { StreamRepository, StreamEventRepository } from "../streams"
import { OutboxRepository } from "../../lib/outbox"
import type { EventService } from "../messaging"
import { createEnclaveSessionHandlers } from "./session-handlers"

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

function req(id: string | undefined, body: unknown): Request {
  return { params: { id }, body } as unknown as Request
}

const SESSION = {
  id: "session_1",
  streamId: "stream_1",
  personaId: "persona_ariadne",
  status: SessionStatuses.RUNNING,
  lastSeenSequence: null,
  createdAt: new Date("2026-05-30T00:00:00.000Z"),
} as unknown as Awaited<ReturnType<typeof AgentSessionRepository.findById>>

const MESSAGE_BODY = {
  messageId: "msg_a",
  ciphertext: "Y3Q=",
  envelope: { v: 2, keyGeneration: 0, iv: "aXY=", aad: "YWFk" },
}
const COMPLETE_BODY = { messageIds: ["msg_a", "msg_b"], model: "anthropic/claude-sonnet-4.6" }

const STEP_BODY = {
  stepId: "step_a",
  stepType: "thinking",
  ciphertext: "Y3Q=",
  envelope: { v: 2, keyGeneration: 0, iv: "aXY=", aad: "YWFk" },
  durationMs: 1500,
}

afterEach(() => mock.restore())

// Fake socket server exposing the `emit` spy so step-broadcast assertions can
// observe the relayed payload (io is required — the API process always has it).
function fakeIo() {
  const emit = mock((_event: string, _payload: unknown) => {})
  const io = { to: mock((_room: string) => ({ emit })) } as unknown as Server
  return { io, emit }
}

function makeHandlers(createMessage = mock(async (_input: Record<string, unknown>) => ({}) as never)) {
  const eventService = { createMessage } as unknown as EventService
  const { io, emit } = fakeIo()
  return { handlers: createEnclaveSessionHandlers({ pool, eventService, io }), createMessage, io, emit }
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
    const { handlers, createMessage } = makeHandlers()
    const res = fakeRes()

    await handlers.complete(req("session_1", COMPLETE_BODY), res)

    expect(res.statusCode).toBe(204)
    expect(createMessage).not.toHaveBeenCalled() // replies were already streamed via /messages
    expect(complete).toHaveBeenCalledTimes(1)
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

  it("appends the sealed step + current_step_type in one transaction, broadcasts it, and 204s", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
    spyOn(StreamRepository, "findById").mockResolvedValue({ workspaceId: "ws_1" } as never)
    // Run the transaction body against a fake client so the repo spies observe
    // the calls (INV-6: append + current_step_type are wrapped in withTransaction).
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
    const { handlers, io, emit } = makeHandlers()
    const res = fakeRes()

    await handlers.steps(req("session_1", STEP_BODY), res)

    expect(res.statusCode).toBe(204)
    expect(append).toHaveBeenCalledTimes(1)
    // Both writes run on the same transaction client, not the bare pool.
    expect(append.mock.calls[0]![0]).toBe(tx)
    expect(append.mock.calls[0]![1]).toMatchObject({
      id: "step_a",
      sessionId: "session_1",
      stepType: "thinking",
      contentCiphertext: "Y3Q=", // sealed content — the server never holds plaintext (INV-E7)
      contentEnvelope: STEP_BODY.envelope,
    })
    expect(stepType).toHaveBeenCalledWith(tx, "session_1", "thinking")

    // Live broadcast to the workspace-scoped session room via the canonical
    // serializer — payload carries ciphertext + envelope only (INV-E7).
    expect(io.to).toHaveBeenCalledWith("ws:ws_1:agent_session:session_1")
    expect(emit.mock.calls[0]![0]).toBe("agent_session:step:completed")
    const emitted = emit.mock.calls[0]![1] as { sessionId: string; step: Record<string, unknown> }
    expect(emitted.sessionId).toBe("session_1")
    expect(emitted.step).toMatchObject({
      id: "step_a",
      stepType: "thinking",
      contentCiphertext: "Y3Q=",
      contentEnvelope: STEP_BODY.envelope,
    })

    // Also drives the inline stream-view trace (useAgentActivity), which listens
    // on the *stream* room — a plaintext progress event carrying step type only.
    expect(io.to).toHaveBeenCalledWith("ws:ws_1:stream:stream_1")
    const progress = emit.mock.calls.find((c) => c[0] === "agent_session:progress")
    expect(progress?.[1]).toMatchObject({
      sessionId: "session_1",
      streamId: "stream_1",
      currentStepType: "thinking",
    })
  })
})

describe("createEnclaveSessionHandlers.heartbeat", () => {
  it("400s without a session id", async () => {
    const handlers = createEnclaveSessionHandlers({ pool, eventService: {} as EventService, io: fakeIo().io })
    await expect(handlers.heartbeat(req(undefined, {}), fakeRes())).rejects.toBeInstanceOf(HttpError)
  })

  it("refreshes the heartbeat and 204s", async () => {
    const beat = spyOn(AgentSessionRepository, "updateHeartbeat").mockResolvedValue(undefined)
    const handlers = createEnclaveSessionHandlers({ pool, eventService: {} as EventService, io: fakeIo().io })
    const res = fakeRes()
    await handlers.heartbeat(req("session_1", {}), res)
    expect(beat).toHaveBeenCalledWith(pool, "session_1")
    expect(res.statusCode).toBe(204)
  })
})
