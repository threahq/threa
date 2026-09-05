import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"
import { AgentSessionRepository } from "../agents"

// Renewing a bot invocation claim is the external runtime's liveness signal
// between trace steps. Because bot invocations reuse the invocation id as the
// agent session id, renewal must also bump the session heartbeat — otherwise a
// long-running turn that renews but goes quiet on /steps is falsely orphaned
// (FAILED) by cleanup while it is in fact alive.

function createResponse(): Response {
  const res = {} as Response
  res.status = mock(() => res) as unknown as Response["status"]
  res.json = mock(() => res) as unknown as Response["json"]
  return res
}

function arrangeRenew(renewed: unknown) {
  const updateHeartbeat = spyOn(AgentSessionRepository, "updateHeartbeat").mockResolvedValue(undefined as never)
  const renewInvocationClaimInTransaction = mock(() => Promise.resolve(renewed))
  const botRuntimeService = { renewInvocationClaimInTransaction } as unknown as PublicApiDeps["botRuntimeService"]

  const client = { query: mock(() => Promise.resolve({ rows: [] })), release: mock(() => {}) }
  const pool = { connect: mock(() => Promise.resolve(client)) } as unknown as PublicApiDeps["pool"]
  const handlers = createPublicApiHandlers({
    eventService: {} as PublicApiDeps["eventService"],
    streamService: {} as PublicApiDeps["streamService"],
    searchService: {} as PublicApiDeps["searchService"],
    featureFlagService: {} as PublicApiDeps["featureFlagService"],
    memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
    attachmentService: {} as PublicApiDeps["attachmentService"],
    botChannelService: {} as PublicApiDeps["botChannelService"],
    botRuntimeService,
    labelService: {} as PublicApiDeps["labelService"],
    labelAssignmentService: {} as PublicApiDeps["labelAssignmentService"],
    pool,
    io: {} as PublicApiDeps["io"],
  })

  const req = {
    workspaceId: "ws_1",
    params: { invocationId: "binv_1" },
    botApiKey: { botId: "bot_1" },
    body: { instanceId: "inst_1", claimToken: "tok_1" },
  } as unknown as Request

  return { handlers, req, updateHeartbeat, pool }
}

describe("renewBotInvocationClaim", () => {
  afterEach(() => {
    mock.restore()
  })

  it("bumps the agent session heartbeat so a renewing turn is not orphan-failed", async () => {
    const { handlers, req, updateHeartbeat, pool } = arrangeRenew({
      id: "binv_1",
      status: "claimed",
      claimExpiresAt: new Date("2026-06-11T09:02:00.000Z"),
    })

    await handlers.renewBotInvocationClaim(req, createResponse())

    expect(updateHeartbeat).toHaveBeenCalledTimes(1)
    expect(updateHeartbeat.mock.calls[0]).toEqual([pool, "binv_1"])
  })

  it("does not bump the heartbeat when the claim is gone (404)", async () => {
    const { handlers, req, updateHeartbeat } = arrangeRenew(null)

    await expect(handlers.renewBotInvocationClaim(req, createResponse())).rejects.toMatchObject({ status: 404 })
    expect(updateHeartbeat).not.toHaveBeenCalled()
  })
})
