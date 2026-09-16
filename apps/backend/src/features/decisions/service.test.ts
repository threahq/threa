import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool, PoolClient } from "pg"
import { AuthorTypes, DecisionRequestStatuses } from "@threahq/types"
import { DecisionService, type BotStreamAccessChecker } from "./service"
import { DecisionRequestRepository, type DecisionRequestRecord } from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import { BotInvocationRepository, BotRuntimeSessionLinkRepository } from "../bot-runtimes"
import { StreamEventRepository, StreamRepository } from "../streams"
import * as streamsModule from "../streams"
import * as dbModule from "../../db"

const NOW = new Date("2026-09-16T12:00:00.000Z")

function fakeDecision(overrides: Partial<DecisionRequestRecord> = {}): DecisionRequestRecord {
  return {
    id: "dreq_1",
    workspaceId: "ws_1",
    streamId: "stream_1",
    requesterBotId: "bot_1",
    requesterRuntimeSessionId: "sess_1",
    requesterInvocationId: null,
    kind: "approval",
    title: "Deploy the migration?",
    bodyMarkdown: null,
    options: [
      { id: "yes", label: "Deploy", tone: "primary" },
      { id: "no", label: "Hold", tone: "neutral" },
    ],
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
  kind: "approval" as const,
  title: "Deploy the migration?",
  options: [
    { id: "yes", label: "Deploy", tone: "primary" as const },
    { id: "no", label: "Hold", tone: "neutral" as const },
  ],
  allowNote: false,
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
      version: 2,
    })
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
    spyOn(DecisionRequestRepository, "findById")
      .mockResolvedValueOnce(fakeDecision())
      .mockResolvedValueOnce(winner)
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ streamId: "stream_1" } as never)
    spyOn(DecisionRequestRepository, "resolve").mockResolvedValue(null)
    stubEventAppend()

    await expect(makeService().resolve(RESOLVE_PARAMS)).rejects.toMatchObject({
      status: 409,
      code: "DECISION_NOT_OPEN",
      details: expect.objectContaining({ id: "dreq_1", status: "resolved", version: 2 }),
    })
  })
})
