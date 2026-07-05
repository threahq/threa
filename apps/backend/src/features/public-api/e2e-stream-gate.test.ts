import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"
import { E2eStreamsRepository } from "../e2e-streams"
import { BotRepository } from "./bot-repository"
import { AgentSessionRepository } from "../agents"
import * as dbModule from "../../db"
import type { EventService } from "../messaging"
import type { StreamService } from "../streams"

const SEALED_ENVELOPE = { v: 2, keyGeneration: 3, iv: "aXY=", aad: "YWFk" }

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
    labelService: {} as PublicApiDeps["labelService"],
    labelAssignmentService: {} as PublicApiDeps["labelAssignmentService"],
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

  it("rejects a bot-invocation completion targeting an E2E stream with 400 (E2EE-2)", async () => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    spyOn(BotRepository, "findById").mockResolvedValue({ id: "bot_1", archivedAt: null } as never)
    const createMessageInTransaction = mock(() => Promise.resolve({ id: "msg_new" }))
    // withTransaction runs the callback against a sentinel client.
    spyOn(dbModule, "withTransaction").mockImplementation(((_pool: unknown, fn: (c: unknown) => unknown) =>
      fn({})) as never)
    const botRuntimeService = {
      findActiveClaimForUpdate: mock(() => Promise.resolve({ id: "claim_1", responseStreamId: "stream_1" })),
      findPresenceByInstance: mock(() => Promise.resolve({ manifest: null })),
      completeInvocationInTransaction: mock(() => Promise.resolve({ id: "inv_1" })),
    } as unknown as PublicApiDeps["botRuntimeService"]
    const botChannelService = {
      isStreamAccessibleForBot: mock(() => Promise.resolve(true)),
    } as unknown as PublicApiDeps["botChannelService"]
    const handlers = createHandlers({
      eventService: { createMessageInTransaction } as unknown as EventService,
      botRuntimeService,
      botChannelService,
    })

    const req = {
      workspaceId: "ws_1",
      params: { invocationId: "inv_1" },
      botApiKey: { botId: "bot_1" },
      body: { instanceId: "inst_1", claimToken: "tok_1", finalMessageMarkdown: "leaked plaintext" },
    } as unknown as Request

    await expect(handlers.completeBotInvocation(req, createResponse())).rejects.toMatchObject({
      status: 400,
      code: "E2E_STREAM_PLAINTEXT_UNSUPPORTED",
    })
    // The gate fires before the bot's plaintext reply is written into the sealed stream.
    expect(createMessageInTransaction).not.toHaveBeenCalled()
  })

  it("accepts a sealed session-control ack completion on an E2E stream (ciphertext, current gen)", async () => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    spyOn(E2eStreamsRepository, "getByStreamId").mockResolvedValue({ currentKeyGeneration: 3 } as never)
    spyOn(BotRepository, "findById").mockResolvedValue({ id: "bot_1", archivedAt: null } as never)
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(null as never)
    spyOn(dbModule, "withTransaction").mockImplementation(((_pool: unknown, fn: (c: unknown) => unknown) =>
      fn({})) as never)
    const createMessageInTransaction = mock((_client: unknown, params: Record<string, unknown>) =>
      Promise.resolve({
        id: params.id,
        streamId: "stream_1",
        sequence: 1n,
        authorId: "bot_1",
        authorType: "bot",
        contentJson: { type: "doc", content: [] },
        contentMarkdown: params.contentMarkdown,
        reactions: {},
        metadata: {},
        editedAt: null,
        createdAt: new Date(),
      })
    )
    const botRuntimeService = {
      findActiveClaimForUpdate: mock(() =>
        Promise.resolve({ id: "claim_1", responseStreamId: "stream_1", metadata: {}, authorUserId: "usr_1" })
      ),
      findPresenceByInstance: mock(() => Promise.resolve({ manifest: null })),
      completeInvocationInTransaction: mock(() =>
        Promise.resolve({ id: "inv_1", responseStreamId: "stream_1", metadata: {} })
      ),
    } as unknown as PublicApiDeps["botRuntimeService"]
    const botChannelService = {
      isStreamAccessibleForBot: mock(() => Promise.resolve(true)),
    } as unknown as PublicApiDeps["botChannelService"]
    const handlers = createHandlers({
      eventService: { createMessageInTransaction } as unknown as EventService,
      botRuntimeService,
      botChannelService,
    })

    const req = {
      workspaceId: "ws_1",
      params: { invocationId: "inv_1" },
      botApiKey: { botId: "bot_1" },
      body: {
        instanceId: "inst_1",
        claimToken: "tok_1",
        sealedReply: { messageId: "msg_ack", ciphertext: "c2VhbGVk", envelope: SEALED_ENVELOPE },
      },
    } as unknown as Request

    await handlers.completeBotInvocation(req, createResponse())
    const params = createMessageInTransaction.mock.calls[0]?.[1] as unknown as Record<string, unknown>
    expect(params).toMatchObject({ id: "msg_ack", streamId: "stream_1", e2eVersion: 2, envelope: SEALED_ENVELOPE })
    expect(Buffer.isBuffer(params.ciphertext)).toBe(true)
    // No plaintext content — placeholder only, ciphertext carries the ack.
    expect(params.contentMarkdown).toBeDefined()
  })

  it("rejects a sealed session-control ack under the wrong key generation with 400", async () => {
    spyOn(E2eStreamsRepository, "getByStreamId").mockResolvedValue({ currentKeyGeneration: 4 } as never)
    spyOn(BotRepository, "findById").mockResolvedValue({ id: "bot_1", archivedAt: null } as never)
    spyOn(dbModule, "withTransaction").mockImplementation(((_pool: unknown, fn: (c: unknown) => unknown) =>
      fn({})) as never)
    const createMessageInTransaction = mock(() => Promise.resolve({ id: "msg_ack" }))
    const botRuntimeService = {
      findActiveClaimForUpdate: mock(() => Promise.resolve({ id: "claim_1", responseStreamId: "stream_1" })),
      findPresenceByInstance: mock(() => Promise.resolve({ manifest: null })),
    } as unknown as PublicApiDeps["botRuntimeService"]
    const botChannelService = {
      isStreamAccessibleForBot: mock(() => Promise.resolve(true)),
    } as unknown as PublicApiDeps["botChannelService"]
    const handlers = createHandlers({
      eventService: { createMessageInTransaction } as unknown as EventService,
      botRuntimeService,
      botChannelService,
    })

    const req = {
      workspaceId: "ws_1",
      params: { invocationId: "inv_1" },
      botApiKey: { botId: "bot_1" },
      body: {
        instanceId: "inst_1",
        claimToken: "tok_1",
        sealedReply: { messageId: "msg_ack", ciphertext: "c2VhbGVk", envelope: SEALED_ENVELOPE },
      },
    } as unknown as Request

    await expect(handlers.completeBotInvocation(req, createResponse())).rejects.toMatchObject({
      status: 400,
      code: "E2E_WRONG_KEY_GENERATION",
    })
    expect(createMessageInTransaction).not.toHaveBeenCalled()
  })

  it("rejects a plaintext trace step targeting an E2E stream with 400 (INV-E7 step sink)", async () => {
    const isE2e = spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    const findById = spyOn(BotRepository, "findById").mockResolvedValue({ id: "bot_1", archivedAt: null } as never)
    const botRuntimeService = {
      findActiveClaim: mock(() =>
        Promise.resolve({ id: "claim_1", responseStreamId: "stream_1", sourceMessageId: "msg_t" })
      ),
    } as unknown as PublicApiDeps["botRuntimeService"]
    const botChannelService = {
      isStreamAccessibleForBot: mock(() => Promise.resolve(true)),
    } as unknown as PublicApiDeps["botChannelService"]
    const handlers = createHandlers({ botRuntimeService, botChannelService })

    const req = {
      workspaceId: "ws_1",
      params: { invocationId: "inv_1" },
      botApiKey: { botId: "bot_1" },
      body: { instanceId: "inst_1", claimToken: "tok_1", stepType: "tool_call", content: "$ echo leaked" },
    } as unknown as Request

    await expect(handlers.recordBotInvocationStep(req, createResponse())).rejects.toMatchObject({
      status: 400,
      code: "E2E_STREAM_PLAINTEXT_UNSUPPORTED",
    })
    expect(isE2e).toHaveBeenCalledWith(expect.anything(), "ws_1", "stream_1")
    // The gate fires before the trace projector / appendStep runs, so no
    // plaintext step content lands in the E2E stream (BotRepository.findById is
    // only reached after the gate — never called here).
    expect(findById).not.toHaveBeenCalled()
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

// E2E uploads are bot-only: a sealed harness turn can bind the row via the
// sealed-messages/sealed-complete `attachmentIds`, but a user API key has no
// sealed message-write path, so its E2E upload could never be referenced.
describe("public API E2E upload gate", () => {
  afterEach(() => {
    mock.restore()
  })

  function uploadRequest(extra: Partial<Request> = {}): Request {
    return {
      workspaceId: "ws_1",
      attachmentId: "att_new",
      file: { key: "s3/key", originalname: "encrypted", mimetype: "application/octet-stream", size: 21 },
      body: { e2e: "true" },
      ...extra,
    } as unknown as Request
  }

  it("accepts an e2e upload from a bot API key and stores the placeholder row", async () => {
    const createForUpload = mock(async (params: Record<string, unknown>) => ({
      status: "created" as const,
      attachment: {
        id: "att_new",
        filename: params.filename,
        mimeType: params.mimeType,
        sizeBytes: 21,
        safetyStatus: "e2e_unscanned",
        createdAt: new Date(),
      },
    }))
    const handlers = createHandlers({
      attachmentService: { createForUpload } as unknown as PublicApiDeps["attachmentService"],
    })

    await handlers.uploadAttachment(uploadRequest({ botApiKey: { botId: "bot_1" } } as never), createResponse())

    // buildUploadParams forced the placeholders and the e2e flag through.
    expect(createForUpload.mock.calls[0]?.[0]).toMatchObject({
      e2e: true,
      filename: "encrypted",
      mimeType: "application/octet-stream",
      uploadedBy: "bot_1",
    })
  })

  it("rejects an e2e upload from a user API key with E2E_UPLOAD_UNSUPPORTED", async () => {
    const createForUpload = mock(async () => {
      throw new Error("should not be called")
    })
    const handlers = createHandlers({
      attachmentService: { createForUpload } as unknown as PublicApiDeps["attachmentService"],
    })

    await expect(
      handlers.uploadAttachment(
        uploadRequest({ userApiKey: { id: "key_1" }, user: { id: "usr_1", name: "T" } } as never),
        createResponse()
      )
    ).rejects.toMatchObject({ status: 400, code: "E2E_UPLOAD_UNSUPPORTED" })
    expect(createForUpload).not.toHaveBeenCalled()
  })
})
