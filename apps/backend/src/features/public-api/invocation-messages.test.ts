import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"
import { BotRepository } from "./bot-repository"
import { AgentSessionRepository } from "../agents"
import { E2eStreamsRepository } from "../e2e-streams"
import { MessageRepository } from "../messaging"
import { StreamEventRepository } from "../streams"
import * as streamsModule from "../streams"
import * as dbModule from "../../db"

const CLAIM = { instanceId: "inst_1", claimToken: "tok_1" }
const INVOCATION = {
  id: "binv_1",
  rootStreamId: "stream_root",
  activeStreamId: "stream_turn",
  responseStreamId: "stream_turn",
  trigger: "active-scratchpad",
  status: "claimed",
  claimedByInstanceId: "inst_1",
  claimedRuntimeSessionId: "rts_claimed",
  claimedRuntimeSessionClaimToken: "tok_1",
  targetRuntimeSessionId: null,
  claimToken: "tok_1",
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

function arrange(
  opts: {
    snapshot?: Record<string, unknown> | null
    activeClaim?: Record<string, unknown> | null
    completed?: Record<string, unknown> | null
    e2e?: boolean
    session?: Record<string, unknown> | null
    activeLink?: Record<string, unknown> | null
    existingMessage?: Record<string, unknown> | null
    existingEvent?: Record<string, unknown> | null
  } = {}
) {
  const snapshot = opts.snapshot === undefined ? INVOCATION : opts.snapshot
  const activeClaim = opts.activeClaim === undefined ? snapshot : opts.activeClaim
  spyOn(BotRepository, "findById").mockResolvedValue({
    id: "bot_1",
    name: "Claude",
    archivedAt: null,
  } as never)
  spyOn(dbModule, "withTransaction").mockImplementation(((_pool: unknown, fn: (c: unknown) => unknown) =>
    fn({})) as never)
  spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue((opts.e2e ?? false) as never)
  const resolveAuthority = spyOn(streamsModule, "resolveLockedStreamAuthorities").mockResolvedValue([
    { state: { readOnly: false, readOnlyReason: null } },
  ] as never)
  const session =
    opts.session === undefined
      ? { id: "binv_1", personaId: "bot_1", streamId: "stream_turn", status: "running" }
      : opts.session
  spyOn(AgentSessionRepository, "findById").mockResolvedValue(session as never)
  const findSessionForUpdate = spyOn(AgentSessionRepository, "findByIdForUpdate").mockResolvedValue(session as never)
  const findExistingMessage = spyOn(MessageRepository, "findByClientMessageId").mockResolvedValue(
    (opts.existingMessage ?? null) as never
  )
  const findExistingEvent = spyOn(StreamEventRepository, "findByMessageId").mockResolvedValue(
    (opts.existingEvent ?? null) as never
  )
  const createMessage = mock(
    async (_tx: unknown, _principal: unknown, params: Record<string, unknown>) =>
      ({ message: { id: params.clientMessageId ?? "msg_new" }, created: true }) as never
  )
  type Lookup = Record<string, unknown>
  const findInvocationForCallback = mock(async (_tx: unknown, _params: Lookup) => snapshot)
  const findActiveClaimForUpdate = mock(async (_tx: unknown, _params: Lookup) => activeClaim)
  const findCompletedInvocationForReplay = mock(async (_tx: unknown, _params: Lookup) => opts.completed ?? null)
  const activeLink =
    opts.activeLink === undefined
      ? {
          instanceId: "inst_1",
          runtimeSessionId: "rts_claimed",
          rootStreamId: "stream_elsewhere",
          activeStreamId: "stream_elsewhere",
          status: "active",
        }
      : opts.activeLink
  const findActiveSessionLinkForClaim = mock(async (_tx: unknown, _params: Lookup) => activeLink)
  const failInvocationInTransaction = mock(async (_tx: unknown, _params: Lookup) => activeClaim)
  const handlers = createPublicApiHandlers({
    eventService: {
      createMessageForPrincipalInTransaction: createMessage,
    } as unknown as PublicApiDeps["eventService"],
    streamService: {} as PublicApiDeps["streamService"],
    searchService: {} as PublicApiDeps["searchService"],
    featureFlagService: {} as PublicApiDeps["featureFlagService"],
    memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
    attachmentService: {} as PublicApiDeps["attachmentService"],
    botChannelService: {} as PublicApiDeps["botChannelService"],
    botRuntimeService: {
      findInvocationForCallback,
      findActiveClaimForUpdate,
      findCompletedInvocationForReplay,
      findActiveSessionLinkForCompletedClaim: findActiveSessionLinkForClaim,
      failInvocationInTransaction,
    } as unknown as PublicApiDeps["botRuntimeService"],
    labelService: {} as PublicApiDeps["labelService"],
    labelAssignmentService: {} as PublicApiDeps["labelAssignmentService"],
    pool: {} as PublicApiDeps["pool"],
    io: {} as PublicApiDeps["io"],
  })
  return {
    handlers,
    createMessage,
    findActiveClaimForUpdate,
    findSessionForUpdate,
    findActiveSessionLinkForClaim,
    resolveAuthority,
  }
}

function req(body: Record<string, unknown>) {
  return {
    workspaceId: "ws_1",
    botApiKey: { botId: "bot_1" },
    params: { invocationId: "binv_1" },
    header: () => undefined,
    body,
  } as unknown as Request
}

describe("sendBotInvocationMessage", () => {
  afterEach(() => mock.restore())

  it("posts into the claim's own stream, stamped with the claim's session", async () => {
    const { handlers, createMessage } = arrange()
    const { res, payloads } = createResponse()

    await handlers.sendBotInvocationMessage(
      req({ ...CLAIM, content: "Halfway there.", clientMessageId: "remote-send-binv_1-1" }),
      res
    )

    const params = createMessage.mock.calls[0]?.[2] as unknown as Record<string, unknown>
    expect(params).toMatchObject({
      workspaceId: "ws_1",
      streamId: "stream_turn",
      sessionId: "binv_1",
      authorId: "bot_1",
      authorType: "bot",
      contentMarkdown: "Halfway there.",
      clientMessageId: "remote-send-binv_1-1",
    })
    expect(payloads[0]).toEqual({
      data: { invocationId: "binv_1", sessionId: "binv_1", messageId: "remote-send-binv_1-1" },
    })
  })

  it("should reject a completed claim whose runtime-session binding belongs to an older claim", async () => {
    const completed = {
      ...INVOCATION,
      status: "completed",
      claimedRuntimeSessionClaimToken: "tok_previous",
    }
    const { handlers, createMessage, findActiveSessionLinkForClaim } = arrange({
      snapshot: completed,
      activeClaim: null,
      completed,
      session: { id: "binv_1", personaId: "bot_1", streamId: "stream_turn", status: "completed" },
    })
    const { res } = createResponse()

    await expect(
      handlers.sendBotInvocationMessage(req({ ...CLAIM, content: "Stale claimant." }), res)
    ).rejects.toMatchObject({ status: 404, code: "RUNTIME_LINK_ENDED" })
    expect(findActiveSessionLinkForClaim).not.toHaveBeenCalled()
    expect(createMessage).not.toHaveBeenCalled()
  })

  it("should allow an old targeted row to fall back to its target runtime session", async () => {
    const completed = {
      ...INVOCATION,
      status: "completed",
      claimedRuntimeSessionId: null,
      claimedRuntimeSessionClaimToken: null,
      targetRuntimeSessionId: "rts_target",
    }
    const { handlers, findActiveSessionLinkForClaim } = arrange({
      snapshot: completed,
      activeClaim: null,
      completed,
      session: { id: "binv_1", personaId: "bot_1", streamId: "stream_turn", status: "completed" },
      activeLink: { instanceId: "inst_1", runtimeSessionId: "rts_target", status: "active" },
    })
    const { res } = createResponse()

    await handlers.sendBotInvocationMessage(req({ ...CLAIM, content: "Old targeted follow-up." }), res)

    expect(findActiveSessionLinkForClaim.mock.calls[0]?.[1]).toMatchObject({
      instanceId: "inst_1",
      runtimeSessionId: "rts_target",
    })
  })

  it("should reject an old untargeted row without a persisted claiming runtime session", async () => {
    const completed = {
      ...INVOCATION,
      status: "completed",
      claimedRuntimeSessionId: null,
      claimedRuntimeSessionClaimToken: null,
      targetRuntimeSessionId: null,
    }
    const { handlers, createMessage, findActiveSessionLinkForClaim } = arrange({
      snapshot: completed,
      activeClaim: null,
      completed,
      session: { id: "binv_1", personaId: "bot_1", streamId: "stream_turn", status: "completed" },
    })
    const { res } = createResponse()

    await expect(
      handlers.sendBotInvocationMessage(req({ ...CLAIM, content: "Unknown old claimant." }), res)
    ).rejects.toMatchObject({ status: 404, code: "RUNTIME_LINK_ENDED" })
    expect(findActiveSessionLinkForClaim).not.toHaveBeenCalled()
    expect(createMessage).not.toHaveBeenCalled()
  })

  it("returns an existing client message only when its bot and session stamp match", async () => {
    const { handlers, createMessage, findSessionForUpdate } = arrange({
      activeClaim: null,
      completed: null,
      session: null,
      existingMessage: {
        id: "msg_existing",
        streamId: "stream_turn",
        authorId: "bot_1",
        authorType: "bot",
      },
      existingEvent: { actorId: "bot_1", actorType: "bot", payload: { sessionId: "binv_1" } },
    })
    const { res, payloads } = createResponse()

    await handlers.sendBotInvocationMessage(
      req({ ...CLAIM, content: "Progress.", clientMessageId: "remote-send-binv_1-1" }),
      res
    )

    expect(payloads[0]).toEqual({
      data: { invocationId: "binv_1", sessionId: "binv_1", messageId: "msg_existing" },
    })
    expect(createMessage).not.toHaveBeenCalled()
    expect(findSessionForUpdate).not.toHaveBeenCalled()
  })

  it("should replay a committed message after the stream becomes read-only without terminalizing", async () => {
    const arranged = arrange({
      snapshot: { ...INVOCATION, status: "completed" },
      activeClaim: null,
      completed: null,
      session: null,
      existingMessage: {
        id: "msg_existing",
        streamId: "stream_turn",
        authorId: "bot_1",
        authorType: "bot",
      },
      existingEvent: { actorId: "bot_1", actorType: "bot", payload: { sessionId: "binv_1" } },
    })
    arranged.resolveAuthority.mockResolvedValue([{ state: { readOnly: true, readOnlyReason: "archived" } }] as never)
    const { res, payloads } = createResponse()

    await arranged.handlers.sendBotInvocationMessage(
      req({ ...CLAIM, content: "Progress.", clientMessageId: "remote-send-binv_1-1" }),
      res
    )

    expect(payloads[0]).toEqual({
      data: { invocationId: "binv_1", sessionId: "binv_1", messageId: "msg_existing" },
    })
    expect(arranged.createMessage).not.toHaveBeenCalled()
  })

  it("rejects a duplicate client id owned by another author", async () => {
    const { handlers, createMessage } = arrange({
      existingMessage: {
        id: "msg_existing",
        streamId: "stream_turn",
        authorId: "bot_other",
        authorType: "bot",
      },
      existingEvent: { actorId: "bot_other", actorType: "bot", payload: { sessionId: "binv_1" } },
    })
    const { res } = createResponse()

    await expect(
      handlers.sendBotInvocationMessage(
        req({ ...CLAIM, content: "Progress.", clientMessageId: "remote-send-binv_1-1" }),
        res
      )
    ).rejects.toMatchObject({ status: 404 })
    expect(createMessage).not.toHaveBeenCalled()
  })

  it("rejects a duplicate client id stamped with another session", async () => {
    const { handlers, createMessage } = arrange({
      existingMessage: {
        id: "msg_existing",
        streamId: "stream_turn",
        authorId: "bot_1",
        authorType: "bot",
      },
      existingEvent: { actorId: "bot_1", actorType: "bot", payload: { sessionId: "binv_other" } },
    })
    const { res } = createResponse()

    await expect(
      handlers.sendBotInvocationMessage(
        req({ ...CLAIM, content: "Progress.", clientMessageId: "remote-send-binv_1-1" }),
        res
      )
    ).rejects.toMatchObject({ status: 404 })
    expect(createMessage).not.toHaveBeenCalled()
  })

  it("rejects when the locked row's response stream is not the snapshot's (404)", async () => {
    const { handlers, createMessage } = arrange({
      activeClaim: { id: "binv_1", responseStreamId: "stream_other", trigger: "active-scratchpad" },
    })
    const { res } = createResponse()

    await expect(handlers.sendBotInvocationMessage(req({ ...CLAIM, content: "hi" }), res)).rejects.toMatchObject({
      status: 404,
    })
    expect(createMessage).not.toHaveBeenCalled()
  })

  it("rejects plaintext into an E2E stream (400)", async () => {
    const { handlers, createMessage } = arrange({ e2e: true })
    const { res } = createResponse()

    await expect(handlers.sendBotInvocationMessage(req({ ...CLAIM, content: "hi" }), res)).rejects.toMatchObject({
      status: 400,
      code: "E2E_STREAM_PLAINTEXT_UNSUPPORTED",
    })
    expect(createMessage).not.toHaveBeenCalled()
  })

  it("rejects a session-control invocation, which has no session to attribute to (409)", async () => {
    const { handlers, createMessage } = arrange({
      snapshot: { id: "binv_1", responseStreamId: "stream_turn", trigger: "session-control" },
    })
    const { res } = createResponse()

    await expect(handlers.sendBotInvocationMessage(req({ ...CLAIM, content: "hi" }), res)).rejects.toMatchObject({
      status: 409,
      code: "SESSION_CONTROL_MESSAGE_UNSUPPORTED",
    })
    expect(createMessage).not.toHaveBeenCalled()
  })

  it("rejects a session owned by another persona (403)", async () => {
    const { handlers, createMessage } = arrange({
      session: { id: "binv_1", personaId: "bot_other", streamId: "stream_turn", status: "running" },
    })
    const { res } = createResponse()

    await expect(handlers.sendBotInvocationMessage(req({ ...CLAIM, content: "hi" }), res)).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    })
    expect(createMessage).not.toHaveBeenCalled()
  })

  it("rejects a session that sits on a different stream than the claim (404)", async () => {
    const { handlers, createMessage } = arrange({
      session: { id: "binv_1", personaId: "bot_1", streamId: "stream_elsewhere", status: "running" },
    })
    const { res } = createResponse()

    await expect(handlers.sendBotInvocationMessage(req({ ...CLAIM, content: "hi" }), res)).rejects.toMatchObject({
      status: 404,
    })
    expect(createMessage).not.toHaveBeenCalled()
  })

  // Keep stream, invocation, and session lock order aligned with completion to avoid ABBA deadlocks.
  it("locks stream, invocation and session in that order before the insert", async () => {
    const { handlers, findActiveClaimForUpdate, findSessionForUpdate, createMessage, resolveAuthority } = arrange()
    const { res } = createResponse()

    await handlers.sendBotInvocationMessage(req({ ...CLAIM, content: "hi" }), res)

    expect(resolveAuthority.mock.calls[0]?.[1]).toMatchObject({
      workspaceId: "ws_1",
      streamIds: ["stream_turn"],
      principal: { kind: "bot", botId: "bot_1" },
    })
    expect(findSessionForUpdate).toHaveBeenCalledWith(expect.anything(), "binv_1")
    const order = [
      resolveAuthority.mock.invocationCallOrder[0]!,
      findActiveClaimForUpdate.mock.invocationCallOrder[0]!,
      findSessionForUpdate.mock.invocationCallOrder[0]!,
      createMessage.mock.invocationCallOrder[0]!,
    ]
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })
})
