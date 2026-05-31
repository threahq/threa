import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import { createPublicApiHandlers } from "./handlers"
import { E2eStreamsRepository } from "../e2e-streams"

// The public API has no ciphertext message-write path, so plaintext sends/edits
// into an E2E stream must be rejected before any insert (mirrors the first-party
// INV-E1 gate). These tests pin that gate by forcing `isE2eStream` true.

function createResponse(): Response {
  const res = {} as Response
  res.status = mock(() => res) as unknown as Response["status"]
  res.json = mock(() => res) as unknown as Response["json"]
  return res
}

function createHandlers(overrides: { eventService?: unknown } = {}) {
  const eventService = overrides.eventService ?? {
    createMessage: mock(() => Promise.resolve({ id: "msg_new" })),
    editMessage: mock(() => Promise.resolve({ id: "msg_new" })),
    getMessageById: mock(() =>
      Promise.resolve({ id: "msg_1", streamId: "stream_1", authorId: "usr_1", deletedAt: null })
    ),
  }
  const streamService = {
    tryAccess: mock(() => Promise.resolve({ id: "stream_1" })),
  }
  return createPublicApiHandlers({
    eventService,
    streamService,
    botRuntimeService: {},
    memoExplorerService: {},
    botChannelService: {},
    io: {},
    pool: {},
    personaService: {},
  } as never)
}

function userRequest(extra: Partial<Request> = {}): Request {
  return {
    workspaceId: "ws_1",
    params: { streamId: "stream_1", messageId: "msg_1" },
    body: { content: "hello" },
    userApiKey: { id: "key_1" },
    user: { id: "usr_1", name: "Tester" },
    ...extra,
  } as unknown as Request
}

describe("public API E2E-stream plaintext gate", () => {
  afterEach(() => {
    mock.restore()
  })

  it("rejects a plaintext sendMessage into an E2E stream with 400", async () => {
    const isE2e = spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    const createMessage = mock(() => Promise.resolve({ id: "msg_new" }))
    const handlers = createHandlers({
      eventService: { createMessage, getMessageById: mock(() => Promise.resolve(null)) },
    })

    await expect(handlers.sendMessage(userRequest(), createResponse())).rejects.toMatchObject({
      status: 400,
      code: "E2E_STREAM_PLAINTEXT_UNSUPPORTED",
    })
    expect(isE2e).toHaveBeenCalledWith(expect.anything(), "ws_1", "stream_1")
    // The gate fires before any write.
    expect(createMessage).not.toHaveBeenCalled()
  })

  it("rejects a plaintext updateMessage into an E2E stream with 400", async () => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    const editMessage = mock(() => Promise.resolve({ id: "msg_1" }))
    const handlers = createHandlers({
      eventService: {
        editMessage,
        getMessageById: mock(() =>
          Promise.resolve({ id: "msg_1", streamId: "stream_1", authorId: "usr_1", deletedAt: null })
        ),
      },
    })

    await expect(handlers.updateMessage(userRequest(), createResponse())).rejects.toMatchObject({
      status: 400,
      code: "E2E_STREAM_PLAINTEXT_UNSUPPORTED",
    })
    expect(editMessage).not.toHaveBeenCalled()
  })

  it("lets a plaintext sendMessage into a non-E2E stream through to createMessage", async () => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    const createMessage = mock(() =>
      Promise.resolve({
        id: "msg_new",
        streamId: "stream_1",
        sequence: 1n,
        authorId: "usr_1",
        authorType: "user",
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "hello",
        reactions: {},
        metadata: {},
        editedAt: null,
        createdAt: new Date(),
      })
    )
    const handlers = createHandlers({
      eventService: { createMessage, getMessageById: mock(() => Promise.resolve(null)) },
    })

    await handlers.sendMessage(userRequest(), createResponse())
    expect(createMessage).toHaveBeenCalled()
  })
})
