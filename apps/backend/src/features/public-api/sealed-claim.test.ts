import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"
import { BotRepository } from "./bot-repository"
import { BotChannelAccessRepository } from "../api-keys"
import { MessageRepository, type EventService, type Message } from "../messaging"
import { BotRuntimeInstanceRepository } from "../bot-runtimes"
import {
  E2eStreamsRepository,
  StreamE2eKeyWrapsRepository,
  type E2eStream,
  type StreamE2eKeyWrap,
} from "../e2e-streams"
import { UserRepository } from "../workspaces"
import { PersonaRepository, AgentSessionRepository, hashCallbackToken } from "../agents"
import * as e2eStreams from "../e2e-streams"
import * as dbModule from "../../db"

// Phase 2.4 sealed bot claim: when the delivery verdict is `sealed`, the claim
// response carries a `SealedTurnContext` (SSK wraps for the claiming bot's BIK +
// sealed history/prompt ciphertext) instead of the plaintext `context`, and the
// session row stores the callback binding (token hash + reply generation). The
// whole path is dark until `externalSealedDelivery` flips, so the verdict is
// forced here by spying `resolveSealingContext` (INV-48 namespace spy).

const TRIGGER_ENVELOPE = { v: 2, keyGeneration: 3, iv: "aXY=", aad: "YWFk" }

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

function sealedMessage(overrides: Partial<Message>): Message {
  return {
    id: "msg_x",
    streamId: "stream_thread",
    sequence: 1n,
    authorId: "usr_1",
    authorType: "user",
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "",
    replyCount: 0,
    clientMessageId: null,
    sentVia: null,
    reactions: {},
    metadata: {},
    editedAt: null,
    deletedAt: null,
    createdAt: new Date("2026-06-12T08:00:00.000Z"),
    ciphertext: Buffer.from("ct"),
    envelope: TRIGGER_ENVELOPE,
    e2eVersion: 2,
    ...overrides,
  } as Message
}

const e2eStream: E2eStream = {
  streamId: "stream_channel",
  workspaceId: "ws_1",
  enabledAt: new Date("2026-06-01T00:00:00.000Z"),
  ownerUserId: "usr_1",
  ownerUserKeyId: "ukey_1",
  currentKeyGeneration: 3,
  hasSealedName: true,
}

function botWrap(overrides: Partial<StreamE2eKeyWrap>): StreamE2eKeyWrap {
  return {
    keyGeneration: 3,
    recipientKeyId: "bik_1",
    recipientKind: "bot",
    wrapEnc: "enc3",
    wrapCt: "ct3",
    ...overrides,
  }
}

function arrangeSealedClaim(params: {
  publicKeyId?: string | null
  wraps?: StreamE2eKeyWrap[]
  surrounding?: Message[]
  trigger?: Message
}) {
  // A thread invocation: key material resolves against the root channel
  // (rootStreamId), the conversation window against the thread (activeStreamId).
  const invocation = {
    id: "binv_1",
    workspaceId: "ws_1",
    rootStreamId: "stream_channel",
    activeStreamId: "stream_thread",
    sourceMessageId: "msg_trigger",
    responseStreamId: "stream_thread",
    actorType: "bot" as const,
    actorId: "bot_1",
    trigger: "active-scratchpad",
    requiredCapability: "active-scratchpad",
    promptMarkdown: "[encrypted]",
    authorUserId: "usr_1",
    mentionedActorSlugs: [],
    status: "claimed",
    targetInstanceId: null,
    targetRuntimeSessionId: null,
    claimedByInstanceId: "inst_1",
    claimToken: "tok_1",
    claimExpiresAt: new Date("2026-06-12T09:01:00.000Z"),
    attempts: 1,
    errorMessage: null,
    metadata: {},
    createdAt: new Date("2026-06-12T09:00:00.000Z"),
    updatedAt: new Date("2026-06-12T09:00:00.000Z"),
    completedAt: null,
  }

  spyOn(BotChannelAccessRepository, "getGrantedStreamIds").mockResolvedValue([])
  spyOn(BotRepository, "findById").mockResolvedValue({
    id: "bot_1",
    slug: "pi",
    name: "Pi",
    archivedAt: null,
  } as never)
  spyOn(dbModule, "withTransaction").mockImplementation(((_pool: unknown, fn: (c: unknown) => unknown) =>
    fn({})) as never)
  const insertSession = spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue(null as never)

  // Force the sealed verdict — the policy switch is off in production.
  spyOn(e2eStreams, "resolveSealingContext").mockResolvedValue({
    streamIsE2e: true,
    actorHasGrant: true,
    externalSealedDelivery: true,
  })
  spyOn(BotRuntimeInstanceRepository, "findByInstance").mockResolvedValue(
    params.publicKeyId === undefined
      ? ({ publicKeyId: "bik_1" } as never)
      : ({ publicKeyId: params.publicKeyId } as never)
  )
  spyOn(E2eStreamsRepository, "getByStreamId").mockResolvedValue(e2eStream)
  spyOn(StreamE2eKeyWrapsRepository, "listForStream").mockResolvedValue(params.wraps ?? [botWrap({})])
  spyOn(MessageRepository, "findById").mockResolvedValue(
    (params.trigger ??
      sealedMessage({ id: "msg_trigger", sequence: 4n, ciphertext: Buffer.from("trigger-ct") })) as never
  )
  const findSurrounding = spyOn(MessageRepository, "findSurrounding").mockResolvedValue(
    (params.surrounding ?? []) as never
  )
  spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_1", name: "Kris" }] as never)
  spyOn(BotRepository, "findByIds").mockResolvedValue([{ id: "bot_1", name: "Pi" }] as never)
  spyOn(PersonaRepository, "findByIds").mockResolvedValue([] as never)

  const botRuntimeService = {
    claimNextInvocation: mock(() => Promise.resolve(invocation)),
    upsertPresenceFromBotKey: mock(() => Promise.resolve(null)),
  } as unknown as PublicApiDeps["botRuntimeService"]
  const eventService = {
    getLatestSequence: mock(() => Promise.resolve(7n)),
  } as unknown as EventService

  const handlers = createPublicApiHandlers({
    eventService,
    streamService: {} as PublicApiDeps["streamService"],
    searchService: {} as PublicApiDeps["searchService"],
    memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
    attachmentService: {} as PublicApiDeps["attachmentService"],
    botChannelService: {} as PublicApiDeps["botChannelService"],
    botRuntimeService,
    pool: {} as PublicApiDeps["pool"],
    io: {} as PublicApiDeps["io"],
  })

  const req = {
    workspaceId: "ws_1",
    botApiKey: { botId: "bot_1" },
    body: { runtimeKind: "pi-local", instanceId: "inst_1", supportedCapabilities: ["active-scratchpad"] },
  } as unknown as Request

  return { handlers, req, insertSession, findSurrounding }
}

describe("claimBotInvocation sealed delivery", () => {
  afterEach(() => {
    mock.restore()
  })

  it("returns a SealedTurnContext (not plaintext context) and binds the session to the callback token + reply generation", async () => {
    const { handlers, req, insertSession, findSurrounding } = arrangeSealedClaim({
      surrounding: [
        sealedMessage({
          id: "msg_1",
          sequence: 1n,
          authorId: "usr_1",
          authorType: "user",
          ciphertext: Buffer.from("h1"),
        }),
        sealedMessage({
          id: "msg_2",
          sequence: 2n,
          authorId: "bot_1",
          authorType: "bot",
          ciphertext: Buffer.from("h2"),
        }),
        sealedMessage({ id: "msg_trigger", sequence: 4n, ciphertext: Buffer.from("trigger-ct") }),
      ],
      trigger: sealedMessage({
        id: "msg_trigger",
        sequence: 4n,
        authorId: "usr_1",
        ciphertext: Buffer.from("trigger-ct"),
      }),
      // A non-bot wrap and a stale bot wrap for a different key are both filtered.
      wraps: [
        botWrap({}),
        { keyGeneration: 3, recipientKeyId: "ukey_1", recipientKind: "user", wrapEnc: "uenc", wrapCt: "uct" },
        botWrap({ recipientKeyId: "bik_other", wrapEnc: "other", wrapCt: "other" }),
      ],
    })
    const { res, payloads } = createResponse()

    await handlers.claimBotInvocation(req, res)

    // The window is read from the thread (activeStreamId), trigger excluded.
    expect(findSurrounding.mock.calls[0]?.slice(1)).toEqual(["msg_trigger", "stream_thread", 30, 0])

    const data = (payloads[0] as { data: Record<string, unknown> }).data
    expect("context" in data).toBe(false)
    expect(data.sealedContext).toEqual({
      callbackToken: "tok_1",
      wraps: [{ keyGeneration: 3, wrapEnc: "enc3", wrapCt: "ct3" }],
      history: [
        { ciphertext: Buffer.from("h1").toString("base64"), envelope: TRIGGER_ENVELOPE, role: "user", sequence: "1" },
        {
          ciphertext: Buffer.from("h2").toString("base64"),
          envelope: TRIGGER_ENVELOPE,
          role: "assistant",
          sequence: "2",
        },
      ],
      prompt: { ciphertext: Buffer.from("trigger-ct").toString("base64"), envelope: TRIGGER_ENVELOPE },
      reply: { keyGeneration: 3, senderId: "bot_1" },
      trigger: {
        messageId: "msg_trigger",
        authorName: "Kris",
        authorType: "user",
        createdAt: "2026-06-12T08:00:00.000Z",
      },
    })

    const sessionParams = insertSession.mock.calls[0]?.[1] as Record<string, unknown>
    expect(sessionParams.callbackTokenHash).toBe(hashCallbackToken("tok_1"))
    expect(sessionParams.replyKeyGeneration).toBe(3)
  })

  it("fails the claim loudly when the claiming instance has no registered identity key (INV-11)", async () => {
    const { handlers, req } = arrangeSealedClaim({ publicKeyId: null })
    const { res } = createResponse()

    await expect(handlers.claimBotInvocation(req, res)).rejects.toMatchObject({
      status: 409,
      code: "BOT_IDENTITY_KEY_REQUIRED",
    })
  })

  it("fails the claim loudly when the claiming key no longer covers the stream's generations (revoke/rotation race)", async () => {
    // The e2e stream is at generation 3 but the only wrap covers generation 2,
    // so the claiming BIK can neither open the prompt nor seal its reply.
    const { handlers, req } = arrangeSealedClaim({ wraps: [botWrap({ keyGeneration: 2 })] })
    const { res } = createResponse()

    await expect(handlers.claimBotInvocation(req, res)).rejects.toMatchObject({
      status: 409,
      code: "SEALED_KEY_COVERAGE_LOST",
    })
  })
})
