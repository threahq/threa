import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool, PoolClient } from "pg"
import { AuthorTypes, BotTypes, DecisionRequestStatuses } from "@threahq/types"
import { DecisionService, type BotStreamAccessChecker } from "./service"
import { DecisionRequestRepository, type DecisionRequestRecord } from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import { BotInvocationRepository, BotRuntimeSessionLinkRepository } from "../bot-runtimes"
import { E2eStreamsRepository } from "../e2e-streams"
import { BotRepository } from "../public-api"
import { StreamEventRepository, StreamRepository } from "../streams"
import * as streamsModule from "../streams"
import * as dbModule from "../../db"
import { E2E_PLACEHOLDER_CONTENT_MARKDOWN } from "@threahq/types"

const NOW = new Date("2026-09-16T12:00:00.000Z")

function fakeDecision(overrides: Partial<DecisionRequestRecord> = {}): DecisionRequestRecord {
  return {
    id: "dreq_1",
    workspaceId: "ws_1",
    streamId: "stream_1",
    requesterBotId: "bot_1",
    requesterRuntimeSessionId: "sess_1",
    requesterInvocationId: null,
    title: "Deploy the migration?",
    bodyMarkdown: null,
    options: [
      { id: "yes", label: "Deploy", tone: "primary" },
      { id: "no", label: "Hold", tone: "neutral" },
    ],
    ciphertext: null,
    envelope: null,
    allowNote: false,
    externalRef: null,
    status: DecisionRequestStatuses.OPEN,
    resolution: null,
    expiresAt: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function stubTransaction() {
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
  spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
}

function stubEventAppend() {
  const insertEvent = spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
  const insertOutbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)
  return { insertEvent, insertOutbox }
}

function makeService(actionable = true) {
  const botChannelService: BotStreamAccessChecker = { isStreamActionableForBot: mock(async () => actionable) }
  return new DecisionService({ pool: {} as Pool, botChannelService })
}

const REQUEST_PARAMS = {
  workspaceId: "ws_1",
  streamId: "stream_1",
  botId: "bot_1",
  title: "Deploy the migration?",
  options: [
    { id: "yes", label: "Deploy", tone: "primary" as const },
    { id: "no", label: "Hold", tone: "neutral" as const },
  ],
  allowNote: false,
}

const SEALED_ID = "dreq_01K5M0000000000000000000ZZ"
/** base64 of `stream_1|decision|<SEALED_ID>|bot_1` — the slot the card is sealed to. */
const SEALED_CARD_AAD = "c3RyZWFtXzF8ZGVjaXNpb258ZHJlcV8wMUs1TTAwMDAwMDAwMDAwMDAwMDAwMDBaWnxib3RfMQ=="
/** base64 of `stream_1|decision-note|dreq_1|usr_1` — the slot the answer's note is sealed to. */
const SEALED_NOTE_AAD = "c3RyZWFtXzF8ZGVjaXNpb24tbm90ZXxkcmVxXzF8dXNyXzE="
const SEALED_BODY = {
  ciphertext: "c2VhbGVk",
  envelope: { v: 2, keyGeneration: 1, iv: "aXZpdml2", aad: SEALED_CARD_AAD },
} as const
const SEALED_NOTE = {
  ciphertext: "bm90ZQ==",
  envelope: { v: 2, keyGeneration: 1, iv: "aXZpdml2", aad: SEALED_NOTE_AAD },
} as const

const SEALED_REQUEST_PARAMS = {
  workspaceId: "ws_1",
  streamId: "stream_1",
  botId: "bot_1",
  decisionId: SEALED_ID,
  options: [
    { id: "yes", tone: "primary" as const },
    { id: "no", tone: "neutral" as const },
  ],
  sealed: SEALED_BODY,
  allowNote: true,
}

function stubRunningSession() {
  spyOn(StreamRepository, "findByIdForWorkspace").mockResolvedValue({
    id: "stream_1",
    rootStreamId: null,
  } as never)
  spyOn(BotRuntimeSessionLinkRepository, "findActiveByStream").mockResolvedValue({
    runtimeSessionId: "sess_1",
  } as never)
}

describe("DecisionService.request", () => {
  afterEach(() => mock.restore())

  it("writes the row, the decision:requested card and its outbox row in one transaction", async () => {
    stubTransaction()
    stubRunningSession()
    const decision = fakeDecision()
    spyOn(DecisionRequestRepository, "insert").mockResolvedValue(decision)
    const { insertEvent, insertOutbox } = stubEventAppend()

    const created = await makeService().request(REQUEST_PARAMS)

    expect(created).toEqual(decision)
    expect(insertEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        streamId: "stream_1",
        eventType: "decision:requested",
        actorId: "bot_1",
        actorType: AuthorTypes.BOT,
        payload: expect.objectContaining({
          decisionId: "dreq_1",
          decision: expect.objectContaining({ id: "dreq_1", title: "Deploy the migration?", status: "open" }),
        }),
      })
    )
    expect(insertOutbox).toHaveBeenCalledWith(expect.anything(), "stream:decision_requested", {
      workspaceId: "ws_1",
      streamId: "stream_1",
      event: { id: "evt_1" },
    })
  })

  it("refuses a plaintext decision on an end-to-end encrypted stream", async () => {
    stubTransaction()
    stubRunningSession()
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    const insert = spyOn(DecisionRequestRepository, "insert").mockResolvedValue(fakeDecision())
    const { insertEvent, insertOutbox } = stubEventAppend()

    await expect(makeService().request(REQUEST_PARAMS)).rejects.toMatchObject({
      status: 400,
      code: "E2E_STREAM_REQUIRES_CIPHERTEXT",
    })
    expect({
      inserted: insert.mock.calls.length,
      events: insertEvent.mock.calls.length,
      outbox: insertOutbox.mock.calls.length,
    }).toEqual({ inserted: 0, events: 0, outbox: 0 })
  })

  it("refuses a sealed decision on a plaintext stream", async () => {
    stubTransaction()
    stubRunningSession()
    const insert = spyOn(DecisionRequestRepository, "insert").mockResolvedValue(fakeDecision())

    await expect(makeService().request(SEALED_REQUEST_PARAMS)).rejects.toMatchObject({
      status: 400,
      code: "E2E_PAYLOAD_REQUIRES_E2E_STREAM",
    })
    expect(insert).not.toHaveBeenCalled()
  })

  it("refuses a sealed decision that carries a readable title or label", async () => {
    stubTransaction()
    stubRunningSession()
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    const insert = spyOn(DecisionRequestRepository, "insert").mockResolvedValue(fakeDecision())

    await expect(
      makeService().request({ ...SEALED_REQUEST_PARAMS, title: "Deploy the migration?" })
    ).rejects.toMatchObject({ status: 400, code: "E2E_STREAM_PLAINTEXT_UNSUPPORTED" })
    await expect(
      makeService().request({
        ...SEALED_REQUEST_PARAMS,
        options: [{ id: "yes", label: "Deploy", tone: "primary" as const }],
      })
    ).rejects.toMatchObject({ status: 400, code: "E2E_STREAM_PLAINTEXT_UNSUPPORTED" })
    expect(insert).not.toHaveBeenCalled()
  })

  it("stores a sealed card under the requester's id, with placeholders where the question would be", async () => {
    stubTransaction()
    stubRunningSession()
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    const insert = spyOn(DecisionRequestRepository, "insert").mockResolvedValue(fakeDecision())
    stubEventAppend()

    await makeService().request(SEALED_REQUEST_PARAMS)

    expect(insert.mock.calls[0]![1]).toMatchObject({
      id: SEALED_ID,
      title: E2E_PLACEHOLDER_CONTENT_MARKDOWN,
      bodyMarkdown: null,
      options: [
        { id: "yes", label: E2E_PLACEHOLDER_CONTENT_MARKDOWN, tone: "primary" },
        { id: "no", label: E2E_PLACEHOLDER_CONTENT_MARKDOWN, tone: "neutral" },
      ],
      ciphertext: SEALED_BODY.ciphertext,
      envelope: SEALED_BODY.envelope,
    })
  })

  it("refuses a card sealed to another stream, id or bot", async () => {
    stubTransaction()
    stubRunningSession()
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    const insert = spyOn(DecisionRequestRepository, "insert").mockResolvedValue(fakeDecision())
    stubEventAppend()

    for (const params of [
      { ...SEALED_REQUEST_PARAMS, streamId: "stream_2" },
      { ...SEALED_REQUEST_PARAMS, decisionId: "dreq_01K5M0000000000000000000YY" },
      { ...SEALED_REQUEST_PARAMS, botId: "bot_2" },
    ]) {
      await expect(makeService().request(params)).rejects.toMatchObject({
        status: 400,
        code: "DECISION_SEAL_AAD_MISMATCH",
      })
    }
    expect(insert).not.toHaveBeenCalled()
  })

  it("turns a replayed sealed id into a 409 rather than a 500", async () => {
    stubTransaction()
    stubRunningSession()
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    spyOn(DecisionRequestRepository, "insert").mockRejectedValue(
      Object.assign(new Error("duplicate key"), { code: "23505", constraint: "decision_requests_pkey" })
    )

    await expect(makeService().request(SEALED_REQUEST_PARAMS)).rejects.toMatchObject({
      status: 409,
      code: "DECISION_ALREADY_EXISTS",
    })
  })

  it("refuses a bot with no running session and no in-flight invocation", async () => {
    stubTransaction()
    spyOn(StreamRepository, "findByIdForWorkspace").mockResolvedValue({ id: "stream_1", rootStreamId: null } as never)
    spyOn(BotRuntimeSessionLinkRepository, "findActiveByStream").mockResolvedValue(null as never)
    spyOn(BotInvocationRepository, "findLiveClaimedForBot").mockResolvedValue(null)
    const insert = spyOn(DecisionRequestRepository, "insert").mockResolvedValue(fakeDecision())

    await expect(makeService().request(REQUEST_PARAMS)).rejects.toMatchObject({
      status: 409,
      code: "DECISION_REQUESTER_NOT_ACTIVE",
    })
    expect(insert).not.toHaveBeenCalled()
  })

  it("refuses an invocation the bot is running on another stream", async () => {
    stubTransaction()
    spyOn(StreamRepository, "findByIdForWorkspace").mockResolvedValue({ id: "stream_1", rootStreamId: null } as never)
    spyOn(BotRuntimeSessionLinkRepository, "findActiveByStream").mockResolvedValue(null as never)
    spyOn(BotInvocationRepository, "findLiveClaimedForBot").mockResolvedValue({
      id: "binv_1",
      rootStreamId: "stream_other",
      sourceMessageId: "msg_other",
    } as never)
    const insert = spyOn(DecisionRequestRepository, "insert").mockResolvedValue(fakeDecision())

    await expect(makeService().request({ ...REQUEST_PARAMS, invocationId: "binv_1" })).rejects.toMatchObject({
      status: 409,
      code: "DECISION_REQUESTER_NOT_ACTIVE",
    })
    expect(insert).not.toHaveBeenCalled()
  })

  it("accepts a runtime session id from an invocation-only requester with no session link", async () => {
    stubTransaction()
    spyOn(StreamRepository, "findByIdForWorkspace").mockResolvedValue({ id: "stream_1", rootStreamId: null } as never)
    spyOn(BotRuntimeSessionLinkRepository, "findActiveByStream").mockResolvedValue(null as never)
    spyOn(BotInvocationRepository, "findLiveClaimedForBot").mockResolvedValue({
      id: "binv_1",
      rootStreamId: "stream_1",
      sourceMessageId: "msg_1",
      claimedRuntimeSessionId: "sess_1",
    } as never)
    const insert = spyOn(DecisionRequestRepository, "insert").mockResolvedValue(fakeDecision())
    stubEventAppend()

    await makeService().request({ ...REQUEST_PARAMS, invocationId: "binv_1", runtimeSessionId: "sess_1" })

    expect(insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requesterRuntimeSessionId: "sess_1", requesterInvocationId: "binv_1" })
    )
  })

  it("refuses a runtime session id that did not claim the named invocation", async () => {
    stubTransaction()
    spyOn(StreamRepository, "findByIdForWorkspace").mockResolvedValue({ id: "stream_1", rootStreamId: null } as never)
    spyOn(BotRuntimeSessionLinkRepository, "findActiveByStream").mockResolvedValue(null as never)
    spyOn(BotInvocationRepository, "findLiveClaimedForBot").mockResolvedValue({
      id: "binv_1",
      rootStreamId: "stream_1",
      sourceMessageId: "msg_1",
      claimedRuntimeSessionId: "sess_1",
    } as never)
    const insert = spyOn(DecisionRequestRepository, "insert").mockResolvedValue(fakeDecision())

    await expect(
      makeService().request({ ...REQUEST_PARAMS, invocationId: "binv_1", runtimeSessionId: "sess_other" })
    ).rejects.toMatchObject({ status: 409, code: "DECISION_REQUESTER_NOT_ACTIVE" })
    expect(insert).not.toHaveBeenCalled()
  })

  it("refuses a requester with no runtime session to deliver the answer to", async () => {
    stubTransaction()
    spyOn(StreamRepository, "findByIdForWorkspace").mockResolvedValue({ id: "stream_1", rootStreamId: null } as never)
    spyOn(BotRuntimeSessionLinkRepository, "findActiveByStream").mockResolvedValue(null as never)
    spyOn(BotInvocationRepository, "findLiveClaimedForBot").mockResolvedValue({
      id: "binv_1",
      rootStreamId: "stream_1",
      sourceMessageId: "msg_1",
      claimedRuntimeSessionId: null,
    } as never)
    const insert = spyOn(DecisionRequestRepository, "insert").mockResolvedValue(fakeDecision())

    await expect(makeService().request({ ...REQUEST_PARAMS, invocationId: "binv_1" })).rejects.toMatchObject({
      status: 409,
      code: "DECISION_REQUESTER_NOT_ACTIVE",
    })
    expect(insert).not.toHaveBeenCalled()
  })

  it("hides a stream the bot cannot act on as a 404", async () => {
    stubTransaction()
    await expect(makeService(false).request(REQUEST_PARAMS)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" })
  })
})

describe("DecisionService.resolve", () => {
  afterEach(() => mock.restore())

  const RESOLVE_PARAMS = {
    workspaceId: "ws_1",
    id: "dreq_1",
    userId: "usr_1",
    optionId: "yes",
    version: 1,
  }

  function stubResolvable(decision = fakeDecision()) {
    stubTransaction()
    spyOn(DecisionRequestRepository, "findById").mockResolvedValue(decision)
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ streamId: "stream_1" } as never)
    spyOn(BotRepository, "findById").mockResolvedValue({ id: "bot_1", type: BotTypes.SHARED } as never)
    return decision
  }

  it("appends the patch, the stream outbox row and the bot-plane push", async () => {
    stubResolvable()
    const resolved = fakeDecision({
      status: DecisionRequestStatuses.RESOLVED,
      version: 2,
      resolution: { optionId: "yes", decidedBy: "usr_1", decidedAt: NOW.toISOString() },
    })
    spyOn(DecisionRequestRepository, "resolve").mockResolvedValue(resolved)
    const { insertEvent, insertOutbox } = stubEventAppend()

    const result = await makeService().resolve(RESOLVE_PARAMS)

    expect(result).toEqual(resolved)
    expect(insertEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "decision:resolved",
        actorId: "usr_1",
        actorType: AuthorTypes.USER,
        payload: {
          decisionId: "dreq_1",
          status: "resolved",
          resolution: { optionId: "yes", decidedBy: "usr_1", decidedAt: NOW.toISOString() },
          version: 2,
        },
      })
    )
    expect(insertOutbox).toHaveBeenCalledWith(expect.anything(), "stream:decision_resolved", {
      workspaceId: "ws_1",
      streamId: "stream_1",
      event: { id: "evt_1" },
    })
    expect(insertOutbox).toHaveBeenCalledWith(expect.anything(), "bot_decision:resolved", {
      workspaceId: "ws_1",
      botId: "bot_1",
      streamId: "stream_1",
      runtimeSessionId: "sess_1",
      decisionId: "dreq_1",
      status: "resolved",
      optionId: "yes",
      note: null,
      noteCiphertext: null,
      noteEnvelope: null,
      version: 2,
    })
  })

  it("seals the note onto a sealed card and pushes it back sealed", async () => {
    const sealedCard = stubResolvable(fakeDecision({ allowNote: true, ...SEALED_BODY }))
    const resolve = spyOn(DecisionRequestRepository, "resolve").mockResolvedValue(
      fakeDecision({
        ...SEALED_BODY,
        status: DecisionRequestStatuses.RESOLVED,
        version: 2,
        resolution: {
          optionId: "yes",
          noteCiphertext: SEALED_NOTE.ciphertext,
          noteEnvelope: SEALED_NOTE.envelope,
          decidedBy: "usr_1",
          decidedAt: NOW.toISOString(),
        },
      })
    )
    const { insertOutbox } = stubEventAppend()

    await makeService().resolve({
      ...RESOLVE_PARAMS,
      sealedNote: SEALED_NOTE,
    })

    expect(sealedCard.ciphertext).toBe(SEALED_BODY.ciphertext)
    expect(resolve.mock.calls[0]![1].resolution).toEqual({
      optionId: "yes",
      note: undefined,
      noteCiphertext: SEALED_NOTE.ciphertext,
      noteEnvelope: SEALED_NOTE.envelope,
      decidedBy: "usr_1",
      decidedAt: expect.any(String),
    })
    expect(insertOutbox).toHaveBeenCalledWith(expect.anything(), "bot_decision:resolved", {
      workspaceId: "ws_1",
      botId: "bot_1",
      streamId: "stream_1",
      runtimeSessionId: "sess_1",
      decisionId: "dreq_1",
      status: "resolved",
      optionId: "yes",
      note: null,
      noteCiphertext: SEALED_NOTE.ciphertext,
      noteEnvelope: SEALED_NOTE.envelope,
      version: 2,
    })
  })

  it("refuses a plaintext note on a sealed card and a sealed note on a plaintext one", async () => {
    stubResolvable(fakeDecision({ allowNote: true, ...SEALED_BODY }))
    const resolve = spyOn(DecisionRequestRepository, "resolve").mockResolvedValue(fakeDecision())

    await expect(makeService().resolve({ ...RESOLVE_PARAMS, note: "ship it" })).rejects.toMatchObject({
      status: 400,
      code: "E2E_STREAM_REQUIRES_CIPHERTEXT",
    })

    mock.restore()
    stubResolvable(fakeDecision({ allowNote: true }))
    spyOn(DecisionRequestRepository, "resolve").mockResolvedValue(fakeDecision())
    await expect(
      makeService().resolve({
        ...RESOLVE_PARAMS,
        sealedNote: SEALED_NOTE,
      })
    ).rejects.toMatchObject({ status: 400, code: "E2E_PAYLOAD_REQUIRES_E2E_STREAM" })
    expect(resolve).not.toHaveBeenCalled()
  })

  it("refuses a note sealed to another answer", async () => {
    stubResolvable(fakeDecision({ allowNote: true, ...SEALED_BODY }))
    const resolve = spyOn(DecisionRequestRepository, "resolve").mockResolvedValue(fakeDecision())

    await expect(
      makeService().resolve({
        ...RESOLVE_PARAMS,
        sealedNote: { ...SEALED_NOTE, envelope: { ...SEALED_NOTE.envelope, aad: SEALED_CARD_AAD } },
      })
    ).rejects.toMatchObject({ status: 400, code: "DECISION_SEAL_AAD_MISMATCH" })
    expect(resolve).not.toHaveBeenCalled()
  })

  it("rejects an option that is not on the card", async () => {
    stubResolvable()
    await expect(makeService().resolve({ ...RESOLVE_PARAMS, optionId: "maybe" })).rejects.toMatchObject({
      status: 400,
      code: "DECISION_OPTION_UNKNOWN",
    })
  })

  it("rejects a note on a decision that does not accept one", async () => {
    stubResolvable()
    await expect(makeService().resolve({ ...RESOLVE_PARAMS, note: "because" })).rejects.toMatchObject({
      status: 400,
      code: "DECISION_NOTE_NOT_ALLOWED",
    })
  })

  it("returns the winning row on a lost CAS race", async () => {
    const winner = fakeDecision({
      status: DecisionRequestStatuses.RESOLVED,
      version: 2,
      resolution: { optionId: "no", decidedBy: "usr_2", decidedAt: NOW.toISOString() },
    })
    stubTransaction()
    spyOn(DecisionRequestRepository, "findById").mockResolvedValueOnce(fakeDecision()).mockResolvedValueOnce(winner)
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ streamId: "stream_1" } as never)
    spyOn(BotRepository, "findById").mockResolvedValue({ id: "bot_1", type: BotTypes.SHARED } as never)
    spyOn(DecisionRequestRepository, "resolve").mockResolvedValue(null)
    stubEventAppend()

    await expect(makeService().resolve(RESOLVE_PARAMS)).rejects.toMatchObject({
      status: 409,
      code: "DECISION_NOT_OPEN",
      details: expect.objectContaining({ id: "dreq_1", status: "resolved", version: 2 }),
    })
  })
})
