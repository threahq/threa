import { describe, expect, it, mock, afterEach } from "bun:test"
import type { Request, Response } from "express"
import { createVoiceTranscriptionHandlers } from "./handlers"
import { HttpError } from "../../lib/errors"

function fakeRes() {
  const res: Partial<Response> = {}
  res.status = mock(() => res as Response)
  res.json = mock(() => res as Response)
  res.send = mock(() => res as Response)
  return res as Response
}

function fakeReq(overrides: Partial<Request> = {}): Request {
  return {
    user: { id: "usr_1" },
    workspaceId: "ws_1",
    params: {},
    body: {},
    query: {},
    ...overrides,
  } as unknown as Request
}

describe("createVoiceTranscriptionHandlers.createSession", () => {
  afterEach(() => mock.restore())

  it("throws HttpError 400 when the body fails validation", async () => {
    const createSession = mock(async () => ({}) as never)
    const handlers = createVoiceTranscriptionHandlers({
      voiceTranscriptionService: { createSession } as never,
    })

    const promise = handlers.createSession(fakeReq({ body: { model: 123 } }), fakeRes())
    await expect(promise).rejects.toBeInstanceOf(HttpError)
    await expect(promise).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" })
    expect(createSession).not.toHaveBeenCalled()
  })

  it("creates a session and returns 201 with the serialized row", async () => {
    const expiresAt = new Date("2026-01-01T00:00:00.000Z")
    const createSession = mock(
      async (_params: { workspaceId: string; userId: string; model?: string; language?: string }) =>
        ({
          id: "voicesess_1",
          model: "elevenlabs:scribe-v2-realtime",
          provider: "elevenlabs",
          region: "us",
          expiresAt,
        }) as never
    )
    const handlers = createVoiceTranscriptionHandlers({
      voiceTranscriptionService: { createSession } as never,
    })
    const res = fakeRes()

    await handlers.createSession(fakeReq({ body: { language: "en" } }), res)

    expect(createSession.mock.calls[0][0]).toMatchObject({ workspaceId: "ws_1", userId: "usr_1", language: "en" })
    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith({
      voiceSessionId: "voicesess_1",
      model: "elevenlabs:scribe-v2-realtime",
      provider: "elevenlabs",
      region: "us",
      expiresAt: expiresAt.toISOString(),
    })
  })
})

describe("createVoiceTranscriptionHandlers.abortSession", () => {
  afterEach(() => mock.restore())

  it("delegates to the service and returns 204", async () => {
    const abortSession = mock(async () => {})
    const handlers = createVoiceTranscriptionHandlers({
      voiceTranscriptionService: { abortSession } as never,
    })
    const res = fakeRes()

    await handlers.abortSession(fakeReq({ params: { sessionId: "voicesess_1" } as never }), res)

    expect(abortSession).toHaveBeenCalledWith({ workspaceId: "ws_1", userId: "usr_1", sessionId: "voicesess_1" })
    expect(res.status).toHaveBeenCalledWith(204)
    expect(res.send).toHaveBeenCalled()
  })
})
