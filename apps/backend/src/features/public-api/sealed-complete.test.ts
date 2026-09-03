import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import { THREA_CALLBACK_TOKEN_HEADER } from "@threa/types"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"
import { BotRepository } from "./bot-repository"
import { StreamRepository, StreamEventRepository } from "../streams"
import * as streamsModule from "../streams"
import { AgentSessionRepository, hashCallbackToken, type AgentSession } from "../agents"
import { MessageRepository } from "../messaging"
import { OutboxRepository } from "../../lib/outbox"
import * as dbModule from "../../db"

// Phase 3 sealed bot `/sealed-complete`: the external sibling of the enclave's
// `/complete` and the sealed variant of the plaintext bot complete. A
// sealed-capable bot harness delivers its single sealed reply inline; the server
// persists ciphertext it can't read, flips the claim, and finalizes the session —
// all in one transaction. Auth is the bot API key + the neutral
// `X-Threa-Callback-Token` header verified against the session's binding.

const CALLBACK_TOKEN = "tok_1"
const REPLY_ENVELOPE = { v: 2, keyGeneration: 3, iv: "aXY=", aad: "YWFk" }

const session: AgentSession = {
  id: "binv_1",
  streamId: "stream_thread",
  personaId: "bot_1",
  triggerMessageId: "msg_trigger",
  triggerMessageRevision: null,
  supersedesSessionId: null,
  status: "running",
  currentStep: 0,
  currentStepType: null,
  serverId: null,
  callbackTokenHash: hashCallbackToken(CALLBACK_TOKEN),
  replyKeyGeneration: 3,
  heartbeatAt: new Date("2026-06-12T09:00:00.000Z"),
  abortRequestedAt: null,
  responseMessageId: null,
  error: null,
  lastSeenSequence: 0n,
  sentMessageIds: [],
  contextMessageIds: [],
  episodeSummary: null,
  responseValidationFailed: false,
  reflectiveCapturedAt: null,
  createdAt: new Date("2026-06-12T09:00:00.000Z"),
  completedAt: null,
}

function createResponse() {
  const payloads: unknown[] = []
  const res = {} as Response
  res.status = mock(() => res) as unknown as Response["status"]
  res.json = mock((body: unknown) => {
    payloads.push(body)
    return res
  }) as unknown as Response["json"]
  return { res, payloads }
}

function createEmitSpy() {
  const emitted: { room: string; event: string; payload: unknown }[] = []
  const io = {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        emitted.push({ room, event, payload })
      },
    }),
  } as unknown as PublicApiDeps["io"]
  return { io, emitted }
}

function arrange(
  opts: {
    sessionOverride?: Partial<AgentSession>
    claimCompleted?: boolean
    sessionFinalized?: boolean
  } = {}
) {
  const claimCompleted = opts.claimCompleted ?? true
  const sessionFinalized = opts.sessionFinalized ?? true

  const findSession = spyOn(AgentSessionRepository, "findById").mockResolvedValue({
    ...session,
    ...opts.sessionOverride,
  } as never)
  spyOn(StreamRepository, "findById").mockResolvedValue({ id: "stream_thread", workspaceId: "ws_1" } as never)
  spyOn(streamsModule, "resolveLockedStreamAuthorities").mockResolvedValue([
    { state: { readOnly: false, readOnlyReason: null } },
  ] as never)
  spyOn(BotRepository, "findById").mockResolvedValue({ id: "bot_1", name: "Pi", archivedAt: null } as never)
  spyOn(dbModule, "withTransaction").mockImplementation(((_pool: unknown, fn: (c: unknown) => unknown) =>
    fn({})) as never)
  spyOn(AgentSessionRepository, "completeSession").mockResolvedValue(
    (sessionFinalized
      ? { ...session, status: "completed", completedAt: new Date("2026-06-12T09:00:05.000Z") }
      : null) as never
  )
  spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([] as never)
  const insertEvent = spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
  const insertOutbox = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

  const createMessageInTransaction = mock(async (_client: unknown, _principal: unknown, params: { id: string }) => ({
    message: { id: params.id, streamId: session.streamId },
  }))
  const getLatestSequence = mock(async () => 5n)
  const activeClaim = { id: "binv_1", responseStreamId: session.streamId, status: "claimed" }
  const validateClaimSourceForCompletion = mock(async () => true)
  const completeInvocationInTransaction = mock(async (_db: unknown, _params: unknown) =>
    claimCompleted ? activeClaim : null
  )

  const botRuntimeService = {
    findInvocationForCallback: mock(async () => activeClaim),
    findActiveClaimForUpdateByToken: mock(async () => activeClaim),
    findCompletedInvocationForReplay: mock(async () => null),
    validateClaimSourceForCompletion,
    completeInvocationInTransaction,
  }
  const { io, emitted } = createEmitSpy()
  const handlers = createPublicApiHandlers({
    eventService: {
      createMessageForPrincipalInTransaction: createMessageInTransaction,
      getLatestSequence,
    } as unknown as PublicApiDeps["eventService"],
    streamService: {} as PublicApiDeps["streamService"],
    searchService: {} as PublicApiDeps["searchService"],
    memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
    attachmentService: {} as PublicApiDeps["attachmentService"],
    botChannelService: {} as PublicApiDeps["botChannelService"],
    botRuntimeService: botRuntimeService as unknown as PublicApiDeps["botRuntimeService"],
    labelService: {} as PublicApiDeps["labelService"],
    labelAssignmentService: {} as PublicApiDeps["labelAssignmentService"],
    pool: {} as PublicApiDeps["pool"],
    io,
  })
  return {
    handlers,
    emitted,
    createMessageInTransaction,
    completeInvocationInTransaction,
    insertEvent,
    insertOutbox,
    botRuntimeService,
    validateClaimSourceForCompletion,
    findSession,
  }
}

function req(
  body: Record<string, unknown>,
  headers: Record<string, string> = { [THREA_CALLBACK_TOKEN_HEADER]: CALLBACK_TOKEN }
) {
  return {
    workspaceId: "ws_1",
    botApiKey: { botId: "bot_1" },
    params: { invocationId: "binv_1" },
    header: (name: string) => headers[name],
    body,
  } as unknown as Request
}

describe("completeBotInvocationSealed", () => {
  afterEach(() => mock.restore())

  it("persists the sealed reply, flips the claim, and finalizes the session", async () => {
    const {
      handlers,
      emitted,
      createMessageInTransaction,
      completeInvocationInTransaction,
      insertEvent,
      insertOutbox,
    } = arrange()
    const { res, payloads } = createResponse()

    await handlers.completeBotInvocationSealed(
      req({ reply: { messageId: "msg_reply", ciphertext: "c2VhbGVk", envelope: REPLY_ENVELOPE } }),
      res
    )

    const createParams = createMessageInTransaction.mock.calls[0]?.[2] as unknown as Record<string, unknown>
    expect(createParams).toMatchObject({
      id: "msg_reply",
      streamId: "stream_thread",
      authorType: "bot",
      e2eVersion: 2,
      accessibleStreamIds: ["stream_thread"],
      clientMessageId: "bot-invocation:binv_1",
    })
    expect(createParams.ciphertext).toBeInstanceOf(Buffer)
    // The claim flip omits instanceId — the callback token scopes it (model A).
    const completeParams = completeInvocationInTransaction.mock.calls[0]?.[1] as unknown as Record<string, unknown>
    expect(completeParams).toMatchObject({ invocationId: "binv_1", botId: "bot_1", claimToken: CALLBACK_TOKEN })
    expect(completeParams.instanceId).toBeUndefined()
    // The completed event/outbox land with the message count it carried.
    expect(insertEvent.mock.calls[0]?.[1]).toMatchObject({
      eventType: "agent_session:completed",
      payload: expect.objectContaining({ sessionId: "binv_1", messageCount: 1 }),
    })
    expect(insertOutbox).toHaveBeenCalled()
    expect(emitted.map((e) => e.event)).toContain("agent_session:completed")
    expect((payloads[0] as { data: { messageId: string } }).data.messageId).toBe("msg_reply")
  })

  it("binds the reply's E2E attachment rows via attachmentIds", async () => {
    const { handlers, createMessageInTransaction } = arrange()
    const { res } = createResponse()

    await handlers.completeBotInvocationSealed(
      req({
        reply: {
          messageId: "msg_reply",
          ciphertext: "c2VhbGVk",
          envelope: REPLY_ENVELOPE,
          attachmentIds: ["att_1", "att_2"],
        },
      }),
      res
    )

    const createParams = createMessageInTransaction.mock.calls[0]?.[2] as unknown as Record<string, unknown>
    expect(createParams.attachmentIds).toEqual(["att_1", "att_2"])
  })

  it("returns the committed winner when archive lands after its stale claimed snapshot", async () => {
    const { handlers, createMessageInTransaction, botRuntimeService, findSession } = arrange()
    const completedSession = {
      ...session,
      status: "completed",
      responseMessageId: "msg_reply",
      completedAt: new Date("2026-06-12T09:00:05.000Z"),
    } as AgentSession
    findSession.mockResolvedValueOnce(session as never).mockResolvedValue(completedSession as never)
    spyOn(streamsModule, "resolveLockedStreamAuthorities").mockResolvedValue([
      { state: { readOnly: true, readOnlyReason: "archived" } },
    ] as never)
    botRuntimeService.findCompletedInvocationForReplay.mockResolvedValue({
      id: "binv_1",
      responseStreamId: "stream_thread",
    } as never)
    spyOn(MessageRepository, "findById").mockResolvedValue({
      id: "msg_reply",
      streamId: "stream_thread",
      authorId: "bot_1",
      authorType: "bot",
    } as never)
    const { res, payloads } = createResponse()

    await handlers.completeBotInvocationSealed(
      req({ reply: { messageId: "msg_reply", ciphertext: "c2VhbGVk", envelope: REPLY_ENVELOPE } }),
      res
    )

    expect(botRuntimeService.findActiveClaimForUpdateByToken).not.toHaveBeenCalled()
    expect(createMessageInTransaction).not.toHaveBeenCalled()
    expect((payloads[0] as { data: { messageId: string } }).data.messageId).toBe("msg_reply")
  })

  it("completes with no reply (noResponse) without creating a message", async () => {
    const { handlers, createMessageInTransaction, completeInvocationInTransaction, insertEvent } = arrange()
    const { res, payloads } = createResponse()

    await handlers.completeBotInvocationSealed(req({ noResponse: true }), res)

    expect(createMessageInTransaction).not.toHaveBeenCalled()
    expect(completeInvocationInTransaction).toHaveBeenCalled()
    expect(insertEvent.mock.calls[0]?.[1]).toMatchObject({
      payload: expect.objectContaining({ messageCount: 0 }),
    })
    expect((payloads[0] as { data: { messageId: string | null } }).data.messageId).toBeNull()
  })

  it("skips the lifecycle event when the session lost the finalize race", async () => {
    // The claim flip won but completeSession returns null (a concurrent terminal
    // transition slipped in after the pre-tx running check): the message + claim
    // commit, but no agent_session:completed event/outbox/socket frame is emitted —
    // the racing terminal transition carries its own lifecycle event.
    const { handlers, emitted, insertEvent, insertOutbox } = arrange({ sessionFinalized: false })
    const { res, payloads } = createResponse()

    await handlers.completeBotInvocationSealed(req({ noResponse: true }), res)

    expect(insertEvent).not.toHaveBeenCalled()
    expect(insertOutbox).not.toHaveBeenCalled()
    expect(emitted.map((e) => e.event)).not.toContain("agent_session:completed")
    expect((payloads[0] as { data: { invocationId: string } }).data.invocationId).toBe("binv_1")
  })

  it("rejects when the claim is already gone (404)", async () => {
    const { handlers } = arrange({ claimCompleted: false })
    const { res } = createResponse()

    await expect(handlers.completeBotInvocationSealed(req({ noResponse: true }), res)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    })
  })

  it("persists no sealed reply, trace floor, or lifecycle when canonical input is stale", async () => {
    const arranged = arrange()
    arranged.validateClaimSourceForCompletion.mockResolvedValue(false)
    const { res } = createResponse()

    await expect(
      arranged.handlers.completeBotInvocationSealed(
        req({ reply: { messageId: "msg_reply", ciphertext: "c2VhbGVk", envelope: REPLY_ENVELOPE } }),
        res
      )
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" })

    expect({
      messages: arranged.createMessageInTransaction.mock.calls.length,
      completions: arranged.completeInvocationInTransaction.mock.calls.length,
      lifecycleEvents: arranged.insertEvent.mock.calls.length,
      lifecycleOutbox: arranged.insertOutbox.mock.calls.length,
    }).toEqual({ messages: 0, completions: 0, lifecycleEvents: 0, lifecycleOutbox: 0 })
  })

  it("rejects a reply sealed under the wrong key generation (400)", async () => {
    const { handlers } = arrange()
    const { res } = createResponse()

    await expect(
      handlers.completeBotInvocationSealed(
        req({
          reply: { messageId: "msg_reply", ciphertext: "c2VhbGVk", envelope: { ...REPLY_ENVELOPE, keyGeneration: 4 } },
        }),
        res
      )
    ).rejects.toMatchObject({ status: 400, code: "E2E_WRONG_KEY_GENERATION" })
  })

  it("rejects a missing callback token (403)", async () => {
    const { handlers } = arrange()
    const { res } = createResponse()

    await expect(handlers.completeBotInvocationSealed(req({ noResponse: true }, {}), res)).rejects.toMatchObject({
      status: 403,
      code: "CALLBACK_TOKEN_MISSING",
    })
  })

  it("rejects a non-running session (409)", async () => {
    const { handlers } = arrange({ sessionOverride: { status: "completed" } })
    const { res } = createResponse()

    await expect(handlers.completeBotInvocationSealed(req({ noResponse: true }), res)).rejects.toMatchObject({
      status: 409,
      code: "SESSION_NOT_RUNNING",
    })
  })
})
