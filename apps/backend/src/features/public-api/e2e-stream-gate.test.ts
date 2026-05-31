import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"
import { E2eStreamsRepository } from "../e2e-streams"
import type { EventService } from "../messaging"
import type { StreamService } from "../streams"

// The public API has no ciphertext message-write path, so plaintext sends/edits
// into an E2E stream must be rejected before any insert (mirrors the first-party
// INV-E1 gate). These tests pin that gate by forcing `isE2eStream` true.

function createResponse(): Response {
  const res = {} as Response
  res.status = mock(() => res) as unknown as Response["status"]
  res.json = mock(() => res) as unknown as Response["json"]
  return res
}

// Only eventService + streamService are exercised by the E2E-stream gate; the
// rest of the factory's deps are unused here. Typing the fixture as PublicApiDeps
// (rather than `as never`) means a real shape change to the factory contract —
// a renamed or removed dep — fails this test at compile time.
function createHandlers(overrides: Partial<PublicApiDeps> = {}): ReturnType<typeof createPublicApiHandlers> {
  const eventService = {
    createMessage: mock(() => Promise.resolve({ id: "msg_new" })),
    editMessage: mock(() => Promise.resolve({ id: "msg_new" })),
    getMessageById: mock(() =>
      Promise.resolve({ id: "msg_1", streamId: "stream_1", authorId: "usr_1", deletedAt: null })
    ),
  } as unknown as EventService
  const streamService = {
    tryAccess: mock(() => Promise.resolve({ id: "stream_1" })),
  } as unknown as StreamService

  const deps: PublicApiDeps = {
    eventService,
    streamService,
    searchService: {} as PublicApiDeps["searchService"],
    memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
    attachmentService: {} as PublicApiDeps["attachmentService"],
    botChannelService: {} as PublicApiDeps["botChannelService"],
    botRuntimeService: {} as PublicApiDeps["botRuntimeService"],
    pool: {} as PublicApiDeps["pool"],
    io: {} as PublicApiDeps["io"],
    ...overrides,
  }
  return createPublicApiHandlers(deps)
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
      eventService: { createMessage, getMessageById: mock(() => Promise.resolve(null)) } as unknown as EventService,
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
      } as unknown as EventService,
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
      eventService: { createMessage, getMessageById: mock(() => Promise.resolve(null)) } as unknown as EventService,
    })

    await handlers.sendMessage(userRequest(), createResponse())
    expect(createMessage).toHaveBeenCalled()
  })
})
