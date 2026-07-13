import { describe, expect, it, mock } from "bun:test"
import type { Request, Response } from "express"
import { BotAccessRequestStatuses } from "@threa/types"
import { createBotAccessRequestHandlers, type StreamMemberChecker } from "./handlers"
import type { BotAccessRequest } from "./repository"
import type { BotAccessRequestService } from "./service"

const NOW = new Date("2026-07-13T12:00:00.000Z")

function makeRequestRow(overrides: Partial<BotAccessRequest> = {}): BotAccessRequest {
  return {
    id: "bar_1",
    workspaceId: "ws_1",
    botId: "bot_1",
    streamId: "stream_1",
    delegationId: "dlg_1",
    botName: "Runner",
    delegationTitle: "Add rate limiting",
    requestedByLabel: null,
    status: BotAccessRequestStatuses.OPEN,
    resolvedBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    statusChangedAt: NOW,
    ...overrides,
  }
}

function createResponse() {
  const payloads: unknown[] = []
  const res = {
    json: mock((payload: unknown) => {
      payloads.push(payload)
      return res
    }),
    status: mock(() => res),
  } as unknown as Response
  return { res, payloads }
}

function makeRequest() {
  return {
    workspaceId: "ws_1",
    params: { id: "bar_1" },
    user: { id: "usr_1", name: "Kris" },
  } as unknown as Request
}

function makeHandlers(overrides: { botAccessRequestService?: Partial<BotAccessRequestService>; isMember?: boolean }) {
  const streamService: StreamMemberChecker = {
    isMember: mock(async () => overrides.isMember ?? true),
  }
  return createBotAccessRequestHandlers({
    botAccessRequestService: (overrides.botAccessRequestService ?? {}) as BotAccessRequestService,
    streamService,
  })
}

describe("bot access request handlers — member gate", () => {
  it("404s an unknown request id (existence-hiding)", async () => {
    const handlers = makeHandlers({ botAccessRequestService: { getById: mock(async () => null) } })
    const { res } = createResponse()
    await expect(handlers.approve(makeRequest(), res)).rejects.toMatchObject({
      status: 404,
      code: "BOT_ACCESS_REQUEST_NOT_FOUND",
    })
  })

  it("404s (not 403) a non-member of the request's stream, stricter than the delegation-card gate", async () => {
    const handlers = makeHandlers({
      botAccessRequestService: { getById: mock(async () => makeRequestRow()) },
      isMember: false,
    })
    const { res } = createResponse()
    await expect(handlers.approve(makeRequest(), res)).rejects.toMatchObject({
      status: 404,
      code: "BOT_ACCESS_REQUEST_NOT_FOUND",
    })
    await expect(handlers.deny(makeRequest(), res)).rejects.toMatchObject({ status: 404 })
  })
})

describe("approve / deny — race-honest responses", () => {
  it("approves, passing the resolving member and the request's stream through", async () => {
    const approve = mock(async () => makeRequestRow({ status: BotAccessRequestStatuses.APPROVED, resolvedBy: "usr_1" }))
    const handlers = makeHandlers({
      botAccessRequestService: { getById: mock(async () => makeRequestRow()), approve },
    })
    const { res, payloads } = createResponse()

    await handlers.approve(makeRequest(), res)

    expect((approve.mock.calls[0] as unknown[])[0]).toMatchObject({
      workspaceId: "ws_1",
      id: "bar_1",
      streamId: "stream_1",
      approvedBy: "usr_1",
    })
    expect(payloads[0]).toEqual({ approved: true })
  })

  it("reports approved:false when the CAS lost the race (already resolved)", async () => {
    const handlers = makeHandlers({
      botAccessRequestService: { getById: mock(async () => makeRequestRow()), approve: mock(async () => null) },
    })
    const { res, payloads } = createResponse()

    await handlers.approve(makeRequest(), res)

    expect(payloads[0]).toEqual({ approved: false })
  })

  it("reports denied:false when the CAS lost the race", async () => {
    const handlers = makeHandlers({
      botAccessRequestService: { getById: mock(async () => makeRequestRow()), deny: mock(async () => null) },
    })
    const { res, payloads } = createResponse()

    await handlers.deny(makeRequest(), res)

    expect(payloads[0]).toEqual({ denied: false })
  })
})
