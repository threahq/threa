import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool, PoolClient } from "pg"
import { AuthorTypes, BotAccessRequestStatuses } from "@threahq/types"
import { BotAccessRequestService, type BotGrantWriter } from "./service"
import { BotAccessRequestRepository, type BotAccessRequest } from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import { StreamEventRepository } from "../streams"
import * as dbModule from "../../db"

const NOW = new Date("2026-07-13T12:00:00.000Z")

function fakeRequest(overrides: Partial<BotAccessRequest> = {}): BotAccessRequest {
  return {
    id: "bareq_1",
    workspaceId: "ws_1",
    botId: "bot_1",
    streamId: "stream_1",
    delegationId: "dlg_1",
    botName: "Kris's MacBook",
    delegationTitle: "Fix the build",
    requestedByLabel: "Kris's MacBook",
    status: BotAccessRequestStatuses.OPEN,
    resolvedBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    statusChangedAt: NOW,
    ...overrides,
  }
}

function stubEventAppend() {
  const insertEvent = spyOn(StreamEventRepository, "insert").mockResolvedValue({} as never)
  const insertOutbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)
  return { insertEvent, insertOutbox }
}

function stubTransaction() {
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
}

function makeService() {
  const addBotToStreamOn = mock(async () => {})
  const streamService: BotGrantWriter = { addBotToStreamOn }
  const service = new BotAccessRequestService({ pool: {} as Pool, streamService })
  return { service, addBotToStreamOn }
}

describe("BotAccessRequestService.request", () => {
  afterEach(() => mock.restore())

  it("appends the bot_access:requested card (+ outbox) for a genuinely new request", async () => {
    stubTransaction()
    spyOn(BotAccessRequestRepository, "insertOrGetOpen").mockResolvedValue({ request: fakeRequest(), created: true })
    const { insertEvent, insertOutbox } = stubEventAppend()

    const { service } = makeService()
    const { created } = await service.request({
      workspaceId: "ws_1",
      streamId: "stream_1",
      botId: "bot_1",
      botName: "Kris's MacBook",
      delegationId: "dlg_1",
      delegationTitle: "Fix the build",
      requestedByLabel: "Kris's MacBook",
    })

    expect(created).toBe(true)
    expect(insertEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        streamId: "stream_1",
        eventType: "bot_access:requested",
        actorId: "bot_1",
        actorType: AuthorTypes.BOT,
        payload: expect.objectContaining({
          requestId: "bareq_1",
          botId: "bot_1",
          botName: "Kris's MacBook",
          delegationId: "dlg_1",
          delegationTitle: "Fix the build",
        }),
      })
    )
    expect(insertOutbox.mock.calls[0]?.[1]).toBe("stream:bot_access_requested")
  })

  it("is idempotent: a re-request while one is open appends NO second card", async () => {
    stubTransaction()
    spyOn(BotAccessRequestRepository, "insertOrGetOpen").mockResolvedValue({ request: fakeRequest(), created: false })
    const { insertEvent } = stubEventAppend()

    const { service } = makeService()
    const { request, created } = await service.request({
      workspaceId: "ws_1",
      streamId: "stream_1",
      botId: "bot_1",
      botName: "Kris's MacBook",
    })

    expect(created).toBe(false)
    expect(request.id).toBe("bareq_1")
    expect(insertEvent).not.toHaveBeenCalled()
  })
})

describe("BotAccessRequestService.approve", () => {
  afterEach(() => mock.restore())

  it("applies the grant via addBotToStreamOn in the txn client and appends the approved patch (+ outbox)", async () => {
    stubTransaction()
    spyOn(BotAccessRequestRepository, "approve").mockResolvedValue(
      fakeRequest({ status: BotAccessRequestStatuses.APPROVED, resolvedBy: "usr_kris" })
    )
    const { insertEvent, insertOutbox } = stubEventAppend()

    const { service, addBotToStreamOn } = makeService()
    const approved = await service.approve({
      workspaceId: "ws_1",
      id: "bareq_1",
      streamId: "stream_1",
      approvedBy: "usr_kris",
    })

    expect(approved?.status).toBe("approved")
    expect(addBotToStreamOn).toHaveBeenCalledWith(expect.anything(), "stream_1", "bot_1", "ws_1", "usr_kris")
    expect(insertEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "bot_access:status_changed",
        actorId: "usr_kris",
        actorType: AuthorTypes.USER,
        payload: expect.objectContaining({
          requestId: "bareq_1",
          status: "approved",
          resolvedBy: "usr_kris",
          delegationId: "dlg_1",
          delegationTitle: "Fix the build",
        }),
      })
    )
    expect(insertOutbox.mock.calls[0]?.[1]).toBe("stream:bot_access_status_changed")
  })

  it("returns null (no grant, no event) when the approve lost the race", async () => {
    stubTransaction()
    spyOn(BotAccessRequestRepository, "approve").mockResolvedValue(null)
    const { insertEvent } = stubEventAppend()

    const { service, addBotToStreamOn } = makeService()
    const approved = await service.approve({ workspaceId: "ws_1", id: "bareq_1", approvedBy: "usr_kris" })

    expect(approved).toBeNull()
    expect(addBotToStreamOn).not.toHaveBeenCalled()
    expect(insertEvent).not.toHaveBeenCalled()
  })
})

describe("BotAccessRequestService.deny", () => {
  afterEach(() => mock.restore())

  it("appends the denied patch (+ outbox) and does NOT grant access", async () => {
    stubTransaction()
    spyOn(BotAccessRequestRepository, "deny").mockResolvedValue(
      fakeRequest({ status: BotAccessRequestStatuses.DENIED, resolvedBy: "usr_kris" })
    )
    const { insertEvent, insertOutbox } = stubEventAppend()

    const { service, addBotToStreamOn } = makeService()
    const denied = await service.deny({
      workspaceId: "ws_1",
      id: "bareq_1",
      streamId: "stream_1",
      deniedBy: "usr_kris",
    })

    expect(denied?.status).toBe("denied")
    expect(addBotToStreamOn).not.toHaveBeenCalled()
    expect(insertEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "bot_access:status_changed",
        actorId: "usr_kris",
        actorType: AuthorTypes.USER,
        payload: expect.objectContaining({ requestId: "bareq_1", status: "denied", resolvedBy: "usr_kris" }),
      })
    )
    expect(insertOutbox.mock.calls[0]?.[1]).toBe("stream:bot_access_status_changed")
  })

  it("returns null (and appends nothing) when the deny lost the race", async () => {
    stubTransaction()
    spyOn(BotAccessRequestRepository, "deny").mockResolvedValue(null)
    const { insertEvent } = stubEventAppend()

    const { service } = makeService()
    const denied = await service.deny({ workspaceId: "ws_1", id: "bareq_1", deniedBy: "usr_kris" })

    expect(denied).toBeNull()
    expect(insertEvent).not.toHaveBeenCalled()
  })
})
