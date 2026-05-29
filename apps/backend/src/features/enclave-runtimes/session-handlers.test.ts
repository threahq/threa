import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { AuthorTypes } from "@threa/types"
import { HttpError } from "../../lib/errors"
import { AgentSessionRepository, SessionStatuses } from "../agents"
import { StreamRepository } from "../streams"
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
} as unknown as Awaited<ReturnType<typeof AgentSessionRepository.findById>>

const MESSAGE_BODY = {
  messageId: "msg_a",
  ciphertext: "Y3Q=",
  envelope: { v: 2, keyGeneration: 0, iv: "aXY=", aad: "YWFk" },
}
const COMPLETE_BODY = { messageIds: ["msg_a", "msg_b"], model: "anthropic/claude-sonnet-4.6" }

afterEach(() => mock.restore())

function makeHandlers(createMessage = mock(async (_input: Record<string, unknown>) => ({}) as never)) {
  const eventService = { createMessage } as unknown as EventService
  return { handlers: createEnclaveSessionHandlers({ pool, eventService }), createMessage }
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

  it("records the sent ids and completes the session (without writing messages)", async () => {
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
    const complete = spyOn(AgentSessionRepository, "completeSession").mockResolvedValue(SESSION)
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
  })
})

describe("createEnclaveSessionHandlers.heartbeat", () => {
  it("400s without a session id", async () => {
    const handlers = createEnclaveSessionHandlers({ pool, eventService: {} as EventService })
    await expect(handlers.heartbeat(req(undefined, {}), fakeRes())).rejects.toBeInstanceOf(HttpError)
  })

  it("refreshes the heartbeat and 204s", async () => {
    const beat = spyOn(AgentSessionRepository, "updateHeartbeat").mockResolvedValue(undefined)
    const handlers = createEnclaveSessionHandlers({ pool, eventService: {} as EventService })
    const res = fakeRes()
    await handlers.heartbeat(req("session_1", {}), res)
    expect(beat).toHaveBeenCalledWith(pool, "session_1")
    expect(res.statusCode).toBe(204)
  })
})
